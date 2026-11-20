import { canPerform, ROLE_LABELS, validateLoginInput, validateUserCreateInput } from './domain/auth.js';
import { exportMovementsToCsv, exportProductsToCsv } from './domain/csv.js';
import {
    ALLOWED_INTAKE_MIME_TYPES,
    INTAKE_STATUS,
    MAX_INTAKE_BATCH_FILES,
    MAX_INTAKE_FILE_BYTES,
    validateIntakeReviewPayload
} from './domain/intake.js';
import { validateMovementInput } from './domain/movement.js';
import {
    validatePartyInput,
    validatePurchaseOrderInput,
    validateSaleOrderInput
} from './domain/operations.js';
import {
    calculateInventoryMetrics,
    filterAndSortProducts,
    getUniqueCategories,
    validateProductInput
} from './domain/product.js';
import { createHttpAuthRepository } from './repositories/httpAuthRepository.js';
import { createHttpIntakeRepository } from './repositories/httpIntakeRepository.js';
import { createHttpInventoryRepository } from './repositories/httpInventoryRepository.js';
import { createHttpOperationsRepository } from './repositories/httpOperationsRepository.js';
import { createAuthView } from './ui/authView.js';
import { createIntakeView } from './ui/intakeView.js';
import { createInventoryView } from './ui/inventoryView.js';
import { createKardexView, triggerCsvDownload } from './ui/kardexView.js';
import { createOperationsView } from './ui/operationsView.js';

const authRepository = createHttpAuthRepository('/api');
const inventoryRepository = createHttpInventoryRepository('/api');
const operationsRepository = createHttpOperationsRepository('/api');
const intakeRepository = createHttpIntakeRepository('/api');

const authView = createAuthView();
const view = createInventoryView();
const kardexView = createKardexView();
const operationsView = createOperationsView();
const intakeView = createIntakeView();

const ALLOWED_MIME_SET = new Set(ALLOWED_INTAKE_MIME_TYPES);

const state = {
    isSetupMode: false,
    currentUser: null,
    activeTab: 'inventory',
    aiStatus: { configured: false, provider: 'gemini', model: '' },
    products: [],
    movements: [],
    suppliers: [],
    purchases: [],
    customers: [],
    sales: [],
    intakes: [],
    intakeFilterStatus: 'all',
    selectedFiles: [],
    intakePollTimer: null,
    users: [],
    editingId: null,
    filters: {
        query: '',
        category: 'all',
        stockFilter: 'all',
        sortBy: 'createdAt-desc'
    },
    kardexFilters: {
        productId: '',
        type: 'all'
    }
};

function getTodayDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function getPermissions(user) {
    const role = user?.role ?? '';
    return {
        canWrite: canPerform(role, 'inventory:write'),
        canDelete: canPerform(role, 'inventory:delete'),
        canCancelPurchases: canPerform(role, 'purchases:cancel'),
        canCancelSales: canPerform(role, 'sales:cancel'),
        canApproveIntake: canPerform(role, 'intake:approve'),
        canManageUsers: canPerform(role, 'users:manage')
    };
}

function stopIntakePolling() {
    if (state.intakePollTimer !== null) {
        clearInterval(state.intakePollTimer);
        state.intakePollTimer = null;
    }
}

function ensureIntakePolling() {
    const hasPending = state.intakes.some(
        (item) => item.status === INTAKE_STATUS.PENDING || item.status === INTAKE_STATUS.PROCESSING
    );

    if (!hasPending) {
        stopIntakePolling();
        return;
    }

    if (state.intakePollTimer === null) {
        state.intakePollTimer = setInterval(() => {
            void refreshIntakeQueueOnly().catch((error) => {
                if (handleUnauthorizedError(error)) return;
                stopIntakePolling();
            });
        }, 1500);
    }
}

function handleUnauthorizedError(error) {
    if (error && error.status === 401) {
        stopIntakePolling();
        state.currentUser = null;
        state.isSetupMode = false;
        authView.showAuthScreen({ isSetupMode: false });
        authView.showAuthError('Tu sesión expiró o fue revocada. Iniciá sesión nuevamente.');
        return true;
    }
    return false;
}

function renderAll() {
    if (!state.currentUser) {
        return;
    }

    const perms = getPermissions(state.currentUser);
    view.applyPermissions({ canWrite: perms.canWrite, canDelete: perms.canDelete });
    kardexView.applyPermissions({ canWrite: perms.canWrite });
    operationsView.applyPermissions({
        canWrite: perms.canWrite,
        canCancelPurchases: perms.canCancelPurchases,
        canCancelSales: perms.canCancelSales
    });
    intakeView.applyPermissions({
        canWrite: perms.canWrite,
        canApprove: perms.canApproveIntake
    });

    const metrics = calculateInventoryMetrics(state.products);
    const categories = getUniqueCategories(state.products);

    if (state.filters.category !== 'all' && !categories.includes(state.filters.category)) {
        state.filters.category = 'all';
    }

    if (
        state.kardexFilters.productId &&
        !state.products.some((product) => product.id === state.kardexFilters.productId)
    ) {
        state.kardexFilters.productId = '';
    }

    const visibleProducts = filterAndSortProducts(state.products, state.filters);

    view.renderMetrics(metrics);
    view.renderCategoryOptions(categories, state.filters.category);
    view.renderTable(visibleProducts, state.products.length, state.editingId);

    kardexView.renderProductSelectors(
        state.products,
        kardexView.elements.movementProduct.value,
        state.kardexFilters.productId
    );
    kardexView.renderMovements(state.movements);

    operationsView.renderProductCatalog(state.products);
    operationsView.renderSuppliers(state.suppliers);
    operationsView.renderCustomers(state.customers);
    operationsView.renderPurchases(state.purchases, state.sales);
    operationsView.renderSales(state.sales, state.purchases);

    intakeView.renderAiStatus(state.aiStatus);
    intakeView.setCatalog({
        products: state.products,
        suppliers: state.suppliers,
        customers: state.customers
    });
    intakeView.renderQueue(state.intakes, state.intakeFilterStatus);
    ensureIntakePolling();

    if (perms.canManageUsers) {
        authView.renderUsers(state.users, state.currentUser.id);
    }
}

async function syncFromServer() {
    const perms = getPermissions(state.currentUser);
    const requests = [
        inventoryRepository.getAll(),
        inventoryRepository.getMovements(state.kardexFilters),
        operationsRepository.listSuppliers(),
        operationsRepository.listPurchases(),
        operationsRepository.listCustomers(),
        operationsRepository.listSales(),
        intakeRepository.getAiStatus(),
        intakeRepository.listIntakes(),
        perms.canManageUsers ? authRepository.listUsers() : Promise.resolve([])
    ];

    const [
        products,
        movements,
        suppliers,
        purchases,
        customers,
        sales,
        aiStatus,
        intakeData,
        users
    ] = await Promise.all(requests);

    state.products = products;
    state.movements = movements;
    state.suppliers = suppliers;
    state.purchases = purchases;
    state.customers = customers;
    state.sales = sales;
    state.aiStatus = aiStatus;
    state.intakes = intakeData.intakes ?? [];
    state.users = users;
}

async function refreshMovementsOnly() {
    state.movements = await inventoryRepository.getMovements(state.kardexFilters);
    kardexView.renderMovements(state.movements);
}

async function refreshIntakeQueueOnly() {
    const [data, aiStatus] = await Promise.all([
        intakeRepository.listIntakes(),
        intakeRepository.getAiStatus()
    ]);
    state.intakes = data.intakes ?? [];
    state.aiStatus = aiStatus;
    intakeView.renderAiStatus(state.aiStatus);
    intakeView.renderQueue(state.intakes, state.intakeFilterStatus);
    ensureIntakePolling();
}

async function handleRefreshAiModels() {
    intakeView.clearUploadFeedback();
    intakeView.setRefreshingModelsState(true);
    try {
        const aiStatus = await intakeRepository.refreshAiModels();
        state.aiStatus = aiStatus;
        intakeView.renderAiStatus(state.aiStatus);
        if (!aiStatus.configured) {
            intakeView.showUploadError(
                'Definí GEMINI_API_KEY en .env y reiniciá el servidor para detectar modelos.'
            );
        } else {
            intakeView.showUploadStatus(
                `Detección completada: ${aiStatus.availableCount}/${aiStatus.totalModels} modelo(s) disponibles (activo: ${aiStatus.model}).`
            );
        }
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showUploadError(
            error instanceof Error ? error.message : 'No se pudieron detectar los modelos de Gemini.'
        );
    } finally {
        intakeView.setRefreshingModelsState(false);
    }
}

function exitEditMode() {
    state.editingId = null;
    view.clearError();
    view.setFormMode(null);
    renderAll();
    view.focusField('sku');
}

async function enterAuthenticatedApp(user) {
    state.currentUser = user;
    state.isSetupMode = false;
    state.activeTab = 'inventory';
    state.editingId = null;

    const perms = getPermissions(user);
    authView.showAppShell(user, { canManageUsers: perms.canManageUsers });
    authView.setActiveTab(state.activeTab);
    view.setFormMode(null);
    kardexView.syncMovementTypeUI();
    operationsView.resetPurchaseLines();
    operationsView.resetSaleLines();
    intakeView.closeReviewPanel();
    intakeView.renderSelectedFiles([]);

    await syncFromServer();
    renderAll();
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    authView.clearAuthError();

    const rawValues = authView.readAuthFormValues();
    const validation = state.isSetupMode
        ? validateUserCreateInput(rawValues, { requireRole: false })
        : validateLoginInput(rawValues);

    if (!validation.ok) {
        authView.showAuthError(validation.error, validation.field);
        return;
    }

    try {
        const user = state.isSetupMode
            ? await authRepository.setupAdmin(rawValues)
            : await authRepository.login(rawValues);
        await enterAuthenticatedApp(user);
    } catch (error) {
        authView.showAuthError(
            error instanceof Error ? error.message : 'No se pudo autenticar.',
            error?.field ?? null
        );
    }
}

async function handleLogout() {
    stopIntakePolling();
    try {
        await authRepository.logout();
    } finally {
        state.currentUser = null;
        state.products = [];
        state.movements = [];
        state.suppliers = [];
        state.purchases = [];
        state.customers = [];
        state.sales = [];
        state.intakes = [];
        state.selectedFiles = [];
        state.users = [];
        state.editingId = null;
        intakeView.closeReviewPanel();
        authView.showAuthScreen({ isSetupMode: false });
    }
}

async function handleFormSubmit(event) {
    event.preventDefault();
    view.clearError();
    view.clearStatus();

    const rawInput = view.readFormValues();
    const validation = validateProductInput(rawInput, state.products, state.editingId);

    if (!validation.ok) {
        view.showError(validation.error, validation.field);
        return;
    }

    try {
        if (state.editingId) {
            const updated = await inventoryRepository.update(state.editingId, rawInput);
            state.editingId = null;
            view.setFormMode(null);
            view.showStatus(`Producto "${updated.name}" (${updated.sku}) actualizado en SQLite.`);
        } else {
            const saved = await inventoryRepository.create(rawInput);
            view.setFormMode(null);
            view.showStatus(`Producto "${saved.name}" (${saved.sku}) agregado al inventario.`);
        }

        await syncFromServer();
        renderAll();
        view.focusField('sku');
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        view.showError(
            error instanceof Error ? error.message : 'No se pudo guardar el producto.',
            error?.field ?? null
        );
    }
}

async function handleQuickStockAdjust(product, delta) {
    if (delta < 0 && product.stock === 0) {
        return;
    }

    view.clearError();

    try {
        const result = await inventoryRepository.recordMovement({
            productId: product.id,
            type: delta > 0 ? 'IN' : 'OUT',
            quantity: 1,
            reason: 'Ajuste rápido en listado',
            reference: ''
        });

        await syncFromServer();

        if (state.editingId === result.product.id) {
            view.elements.stockInput.value = String(result.product.stock);
        }

        view.showStatus(
            `Stock de "${result.product.name}" actualizado a ${result.product.stock} unidades (registrado en Kardex).`
        );
        renderAll();
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        view.showError(error instanceof Error ? error.message : 'No se pudo actualizar el stock.');
    }
}

async function handleDeleteProduct(product) {
    const confirmed = await view.confirmDelete(product);
    if (!confirmed) {
        return;
    }

    view.clearError();

    try {
        const removed = await inventoryRepository.remove(product.id);
        if (!removed) {
            return;
        }

        if (state.editingId === product.id) {
            state.editingId = null;
            view.setFormMode(null);
        }

        await syncFromServer();
        view.showStatus(
            `Producto "${product.name}" (${product.sku}) eliminado del catálogo (historial preservado en Kardex).`
        );
        renderAll();
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        view.showError(error instanceof Error ? error.message : 'No se pudo eliminar el producto.');
    }
}

function handleTableClick(event) {
    const actionButton = event.target.closest('button[data-action]');
    if (!actionButton || actionButton.disabled) {
        return;
    }

    const { action, id } = actionButton.dataset;
    const product = state.products.find((item) => item.id === id);
    if (!product) {
        return;
    }

    if (action === 'increment') {
        void handleQuickStockAdjust(product, 1);
        return;
    }

    if (action === 'decrement') {
        void handleQuickStockAdjust(product, -1);
        return;
    }

    if (action === 'edit') {
        state.editingId = product.id;
        view.clearError();
        view.clearStatus();
        view.setFormMode(product);
        renderAll();
        view.focusField('name');
        return;
    }

    if (action === 'delete') {
        void handleDeleteProduct(product);
    }
}

async function handleMovementSubmit(event) {
    event.preventDefault();
    kardexView.clearError();
    kardexView.clearStatus();

    const rawMovement = kardexView.readFormValues();
    const product = state.products.find((item) => item.id === rawMovement.productId);
    const validation = validateMovementInput(rawMovement, product);

    if (!validation.ok) {
        kardexView.showError(validation.error, validation.field);
        return;
    }

    try {
        const result = await inventoryRepository.recordMovement(rawMovement);
        await syncFromServer();
        kardexView.resetForm(result.product.id);
        kardexView.showStatus(
            `Movimiento registrado para "${result.product.name}": stock actual ${result.product.stock} unidades.`
        );
        renderAll();
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        kardexView.showError(
            error instanceof Error ? error.message : 'No se pudo registrar el movimiento.',
            error?.field ?? null
        );
    }
}

async function handleSupplierSubmit(event) {
    event.preventDefault();
    operationsView.clearSupplierFeedback();

    const rawInput = operationsView.readSupplierForm();
    const validation = validatePartyInput(rawInput, 'Proveedor');
    if (!validation.ok) {
        operationsView.showSupplierError(validation.error, validation.field);
        return;
    }

    try {
        const supplier = await operationsRepository.createSupplier(rawInput);
        operationsView.elements.supplierForm.reset();
        await syncFromServer();
        renderAll();
        operationsView.elements.purchaseSupplier.value = supplier.id;
        operationsView.showSupplierStatus(`Proveedor "${supplier.name}" registrado.`);
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showSupplierError(
            error instanceof Error ? error.message : 'No se pudo crear el proveedor.',
            error?.field ?? null
        );
    }
}

async function handlePurchaseSubmit(event) {
    event.preventDefault();
    operationsView.clearPurchaseFeedback();

    const rawOrder = operationsView.readPurchaseForm();
    const productsById = new Map(state.products.map((p) => [p.id, p]));
    const validation = validatePurchaseOrderInput(rawOrder, productsById);

    if (!validation.ok) {
        operationsView.showPurchaseError(validation.error);
        return;
    }

    try {
        const purchase = await operationsRepository.createPurchase(rawOrder);
        operationsView.elements.purchaseForm.reset();
        operationsView.elements.purchaseReceiveNow.checked = true;
        operationsView.resetPurchaseLines();
        await syncFromServer();
        renderAll();
        operationsView.showPurchaseStatus(
            purchase.status === 'RECEIVED'
                ? `Orden ${purchase.orderNumber} recibida: stock e historial Kardex actualizados.`
                : `Orden ${purchase.orderNumber} guardada en borrador.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showPurchaseError(
            error instanceof Error ? error.message : 'No se pudo registrar la compra.'
        );
    }
}

async function handlePurchasesTableClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    const purchase = state.purchases.find((p) => p.id === id);
    if (!purchase) return;

    operationsView.clearPurchaseFeedback();

    try {
        if (action === 'receive-purchase') {
            const updated = await operationsRepository.receivePurchase(id);
            await syncFromServer();
            renderAll();
            operationsView.showPurchaseStatus(
                `Orden ${updated.orderNumber} recibida y acreditada en inventario y Kardex.`
            );
            return;
        }

        if (action === 'cancel-purchase') {
            const confirmed = await view.confirmAction({
                title: 'Cancelar orden de compra',
                message: `¿Seguro que querés cancelar la orden ${purchase.orderNumber}?`,
                confirmLabel: 'Cancelar orden'
            });
            if (!confirmed) return;

            const updated = await operationsRepository.cancelPurchase(id);
            await syncFromServer();
            renderAll();
            operationsView.showPurchaseStatus(`Orden ${updated.orderNumber} cancelada.`);
        }
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showPurchaseError(
            error instanceof Error ? error.message : 'No se pudo actualizar la orden.'
        );
    }
}

async function handleCustomerSubmit(event) {
    event.preventDefault();
    operationsView.clearCustomerFeedback();

    const rawInput = operationsView.readCustomerForm();
    const validation = validatePartyInput(rawInput, 'Cliente');
    if (!validation.ok) {
        operationsView.showCustomerError(validation.error, validation.field);
        return;
    }

    try {
        const customer = await operationsRepository.createCustomer(rawInput);
        operationsView.elements.customerForm.reset();
        await syncFromServer();
        renderAll();
        operationsView.elements.saleCustomer.value = customer.id;
        operationsView.showCustomerStatus(`Cliente "${customer.name}" registrado.`);
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showCustomerError(
            error instanceof Error ? error.message : 'No se pudo crear el cliente.',
            error?.field ?? null
        );
    }
}

async function handleSaleSubmit(event) {
    event.preventDefault();
    operationsView.clearSaleFeedback();

    const rawSale = operationsView.readSaleForm();
    const productsById = new Map(state.products.map((p) => [p.id, p]));
    const validation = validateSaleOrderInput(rawSale, productsById);

    if (!validation.ok) {
        operationsView.showSaleError(validation.error);
        return;
    }

    try {
        const sale = await operationsRepository.createSale(rawSale);
        operationsView.elements.saleForm.reset();
        operationsView.resetSaleLines();
        await syncFromServer();
        renderAll();
        operationsView.showSaleStatus(
            `Venta ${sale.saleNumber} confirmada: stock descontado y registrado en Kardex.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showSaleError(
            error instanceof Error ? error.message : 'No se pudo registrar la venta.'
        );
    }
}

async function handleSalesTableClick(event) {
    const button = event.target.closest('button[data-action="cancel-sale"]');
    if (!button) return;

    const { id } = button.dataset;
    const sale = state.sales.find((s) => s.id === id);
    if (!sale) return;

    const confirmed = await view.confirmAction({
        title: 'Anular venta confirmada',
        message: `¿Anular la venta ${sale.saleNumber}? Se devolverá el stock al inventario con un asiento compensatorio en el Kardex.`,
        confirmLabel: 'Anular venta'
    });
    if (!confirmed) return;

    operationsView.clearSaleFeedback();

    try {
        const updated = await operationsRepository.cancelSale(id);
        await syncFromServer();
        renderAll();
        operationsView.showSaleStatus(
            `Venta ${updated.saleNumber} anulada. Stock restituido en Kardex.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        operationsView.showSaleError(
            error instanceof Error ? error.message : 'No se pudo anular la venta.'
        );
    }
}

function inferMimeType(file) {
    if (file.type && ALLOWED_MIME_SET.has(file.type.toLowerCase())) {
        return file.type.toLowerCase();
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.txt')) return 'text/plain';
    return file.type || '';
}

async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function handleIntakeUploadSubmit(event) {
    event.preventDefault();
    intakeView.clearUploadFeedback();

    const docTypeHint = intakeView.elements.intakeDocType.value;
    const pastedText = intakeView.elements.intakePasteText.value.trim();
    const files = [...state.selectedFiles];

    if (files.length === 0 && !pastedText) {
        intakeView.showUploadError(
            'Seleccioná al menos un archivo o pegá el texto del comprobante para analizar.'
        );
        return;
    }

    const totalDocs = files.length + (pastedText ? 1 : 0);
    if (totalDocs > MAX_INTAKE_BATCH_FILES) {
        intakeView.showUploadError(`Máximo ${MAX_INTAKE_BATCH_FILES} comprobantes por lote.`);
        return;
    }

    const documents = [];

    for (const file of files) {
        const mimeType = inferMimeType(file);
        if (!ALLOWED_MIME_SET.has(mimeType)) {
            intakeView.showUploadError(
                `Formato no soportado en "${file.name}". Usá PDF, PNG, JPG, WebP o TXT.`
            );
            return;
        }
        if (file.size === 0) {
            intakeView.showUploadError(`El archivo "${file.name}" está vacío.`);
            return;
        }
        if (file.size > MAX_INTAKE_FILE_BYTES) {
            intakeView.showUploadError(`El archivo "${file.name}" supera el límite de 8 MB.`);
            return;
        }

        if (mimeType === 'text/plain') {
            documents.push({
                fileName: file.name,
                mimeType,
                documentTypeHint: docTypeHint,
                textContent: await file.text()
            });
        } else {
            documents.push({
                fileName: file.name,
                mimeType,
                documentTypeHint: docTypeHint,
                contentBase64: await fileToBase64(file)
            });
        }
    }

    if (pastedText) {
        documents.push({
            fileName: `texto-pegado-${getTodayDateStamp()}.txt`,
            mimeType: 'text/plain',
            documentTypeHint: docTypeHint,
            textContent: pastedText
        });
    }

    intakeView.setUploadingState(true);
    try {
        const result = await intakeRepository.uploadBatch(documents, { wait: false });
        state.selectedFiles = [];
        intakeView.elements.intakeFileInput.value = '';
        intakeView.elements.intakePasteText.value = '';
        intakeView.renderSelectedFiles([]);

        await refreshIntakeQueueOnly();
        intakeView.showUploadStatus(
            `Lote encolado (${result.intakes.length} comprobante/s). Podés revisar los resultados apenas terminen de analizarse.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showUploadError(
            error instanceof Error ? error.message : 'No se pudo enviar el lote para análisis.'
        );
    } finally {
        intakeView.setUploadingState(false);
    }
}

async function handleIntakeQueueClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    const intake = state.intakes.find((item) => item.id === id);
    if (!intake) return;

    intakeView.clearUploadFeedback();

    if (action === 'review-intake') {
        intakeView.openReviewPanel(intake);
        renderAll();
        return;
    }

    if (action === 'approve-intake') {
        const confirmed = await view.confirmAction({
            title: 'Aprobar comprobante al ERP',
            message: `¿Confirmás cargar "${intake.fileName}" definitivamente al ERP (generará orden y movimientos en SQLite/Kardex)?`,
            confirmLabel: 'Aprobar y cargar'
        });
        if (!confirmed) return;

        try {
            const result = await intakeRepository.approveIntake(id);
            if (intakeView.getActiveIntakeId() === id) {
                intakeView.closeReviewPanel();
            }
            await syncFromServer();
            renderAll();
            intakeView.showUploadStatus(
                `Comprobante "${intake.fileName}" aprobado (${result.intake.approvedOrderNumber}).`
            );
        } catch (error) {
            if (handleUnauthorizedError(error)) return;
            intakeView.showUploadError(
                error instanceof Error ? error.message : 'No se pudo aprobar el comprobante.'
            );
        }
        return;
    }

    if (action === 'reject-intake') {
        const confirmed = await view.confirmAction({
            title: 'Rechazar comprobante',
            message: `¿Descartar "${intake.fileName}" de la bandeja de revisión?`,
            confirmLabel: 'Rechazar'
        });
        if (!confirmed) return;

        try {
            await intakeRepository.rejectIntake(id);
            if (intakeView.getActiveIntakeId() === id) {
                intakeView.closeReviewPanel();
            }
            await refreshIntakeQueueOnly();
            intakeView.showUploadStatus(`Comprobante "${intake.fileName}" marcado como rechazado.`);
        } catch (error) {
            if (handleUnauthorizedError(error)) return;
            intakeView.showUploadError(
                error instanceof Error ? error.message : 'No se pudo rechazar el comprobante.'
            );
        }
    }
}

async function saveActiveReviewPayload() {
    const intakeId = intakeView.getActiveIntakeId();
    if (!intakeId) return null;

    intakeView.clearReviewError();
    const payload = intakeView.readReviewForm();
    const validation = validateIntakeReviewPayload(payload, {
        products: state.products,
        suppliers: state.suppliers,
        customers: state.customers
    });

    if (!validation.ok) {
        intakeView.showReviewError(validation.error);
        return null;
    }

    return intakeRepository.updateReview(intakeId, payload);
}

async function handleReviewFormSubmit(event) {
    event.preventDefault();
    try {
        const updated = await saveActiveReviewPayload();
        if (!updated) return;
        await refreshIntakeQueueOnly();
        intakeView.openReviewPanel(updated);
        intakeView.showUploadStatus(`Revisión de "${updated.fileName}" guardada.`);
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showReviewError(
            error instanceof Error ? error.message : 'No se pudo guardar la revisión.'
        );
    }
}

async function handleReviewApproveClick() {
    const intakeId = intakeView.getActiveIntakeId();
    if (!intakeId) return;

    try {
        const updated = await saveActiveReviewPayload();
        if (!updated) return;
        const result = await intakeRepository.approveIntake(intakeId);
        intakeView.closeReviewPanel();
        await syncFromServer();
        renderAll();
        intakeView.showUploadStatus(
            `Comprobante "${result.intake.fileName}" aprobado y cargado como ${result.intake.approvedOrderNumber}.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showReviewError(
            error instanceof Error ? error.message : 'No se pudo aprobar el comprobante.'
        );
    }
}

async function handleReviewRejectClick() {
    const intakeId = intakeView.getActiveIntakeId();
    if (!intakeId) return;

    try {
        const rejected = await intakeRepository.rejectIntake(intakeId);
        intakeView.closeReviewPanel();
        await refreshIntakeQueueOnly();
        intakeView.showUploadStatus(`Comprobante "${rejected.fileName}" rechazado.`);
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showReviewError(
            error instanceof Error ? error.message : 'No se pudo rechazar el comprobante.'
        );
    }
}

async function handleApproveAllReady() {
    const readyIds = state.intakes
        .filter((item) => item.status === INTAKE_STATUS.READY_FOR_REVIEW)
        .map((item) => item.id);

    if (readyIds.length === 0) return;

    const confirmed = await view.confirmAction({
        title: 'Aprobar lote completo',
        message: `¿Aprobar los ${readyIds.length} comprobante(s) listos para revisión e impactarlos en el ERP?`,
        confirmLabel: 'Aprobar lote'
    });
    if (!confirmed) return;

    intakeView.clearUploadFeedback();
    try {
        const result = await intakeRepository.approveBatch(readyIds);
        if (result.approved.some((entry) => entry.intake.id === intakeView.getActiveIntakeId())) {
            intakeView.closeReviewPanel();
        }
        await syncFromServer();
        renderAll();

        if (result.failed.length > 0) {
            intakeView.showUploadError(
                `Se aprobaron ${result.approved.length} comprobante(s), pero ${result.failed.length} fallaron. Ej: "${result.failed[0].fileName}": ${result.failed[0].error}`
            );
        } else {
            intakeView.showUploadStatus(
                `Lote aprobado con éxito: ${result.approved.length} comprobante(s) cargados al ERP.`
            );
        }
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showUploadError(
            error instanceof Error ? error.message : 'No se pudo aprobar el lote.'
        );
    }
}

async function handleRejectAllErrors() {
    const errorIntakes = state.intakes.filter((item) => item.status === INTAKE_STATUS.ERROR);
    if (errorIntakes.length === 0) return;

    const confirmed = await view.confirmAction({
        title: 'Descartar comprobantes con error',
        message: `¿Marcar como rechazados los ${errorIntakes.length} comprobante(s) con error de la bandeja?`,
        confirmLabel: 'Descartar errores'
    });
    if (!confirmed) return;

    intakeView.clearUploadFeedback();
    try {
        const result = await intakeRepository.rejectAllErrors();
        if (errorIntakes.some((entry) => entry.id === intakeView.getActiveIntakeId())) {
            intakeView.closeReviewPanel();
        }
        await refreshIntakeQueueOnly();
        intakeView.showUploadStatus(
            `Se descartaron ${result.rejectedCount} comprobante(s) con error.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        intakeView.showUploadError(
            error instanceof Error ? error.message : 'No se pudieron descartar los errores.'
        );
    }
}

async function handleUserFormSubmit(event) {
    event.preventDefault();
    authView.clearUsersError();
    authView.clearUsersStatus();

    const rawInput = authView.readUserFormValues();
    const validation = validateUserCreateInput(rawInput, { requireRole: true });

    if (!validation.ok) {
        authView.showUsersError(validation.error, validation.field);
        return;
    }

    try {
        const created = await authRepository.createUser(rawInput);
        authView.resetUserForm();
        await syncFromServer();
        renderAll();
        authView.showUsersStatus(
            `Usuario @${created.username} (${ROLE_LABELS[created.role] ?? created.role}) creado.`
        );
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        authView.showUsersError(
            error instanceof Error ? error.message : 'No se pudo crear el usuario.',
            error?.field ?? null
        );
    }
}

async function handleUsersTableAction(event) {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;

    const { action, id } = target.dataset;
    const user = state.users.find((u) => u.id === id);
    if (!user) return;

    authView.clearUsersError();
    authView.clearUsersStatus();

    try {
        if (action === 'change-role' && event.type === 'change') {
            const updated = await authRepository.updateUser(id, { role: target.value });
            await syncFromServer();
            renderAll();
            authView.showUsersStatus(
                `Rol de @${updated.username} actualizado a ${ROLE_LABELS[updated.role] ?? updated.role}.`
            );
            return;
        }

        if (action === 'toggle-active' && event.type === 'click') {
            const updated = await authRepository.updateUser(id, { isActive: !user.isActive });
            await syncFromServer();
            renderAll();
            authView.showUsersStatus(
                `Usuario @${updated.username} ${updated.isActive ? 'reactivado' : 'desactivado'}.`
            );
        }
    } catch (error) {
        if (handleUnauthorizedError(error)) return;
        await syncFromServer();
        renderAll();
        authView.showUsersError(
            error instanceof Error ? error.message : 'No se pudo actualizar el usuario.'
        );
    }
}

function handleExportProductsCsv() {
    view.clearError();
    const visibleProducts = filterAndSortProducts(state.products, state.filters);
    if (visibleProducts.length === 0) {
        view.showError('No hay productos visibles para exportar a CSV.');
        return;
    }

    const csv = exportProductsToCsv(visibleProducts);
    triggerCsvDownload(`inventario-${getTodayDateStamp()}.csv`, csv);
    view.showStatus(`Exportado inventario (${visibleProducts.length} productos) a CSV.`);
}

function handleExportKardexCsv() {
    kardexView.clearError();
    if (state.movements.length === 0) {
        kardexView.showError('No hay movimientos en el Kardex para exportar.');
        return;
    }

    const csv = exportMovementsToCsv(state.movements);
    triggerCsvDownload(`kardex-${getTodayDateStamp()}.csv`, csv);
    kardexView.showStatus(`Exportado Kardex (${state.movements.length} movimientos) a CSV.`);
}

function bindEvents() {
    authView.elements.authForm.addEventListener('submit', (event) => {
        void handleAuthSubmit(event);
    });
    authView.elements.logoutBtn.addEventListener('click', () => {
        void handleLogout();
    });

    authView.elements.moduleNav.addEventListener('click', (event) => {
        const tabBtn = event.target.closest('button[data-tab]');
        if (!tabBtn || tabBtn.hidden) return;
        state.activeTab = tabBtn.dataset.tab;
        authView.setActiveTab(state.activeTab);
    });

    view.elements.form.addEventListener('submit', (event) => {
        void handleFormSubmit(event);
    });
    view.elements.cancelEditBtn.addEventListener('click', exitEditMode);
    view.elements.tableBody.addEventListener('click', handleTableClick);

    view.elements.searchInput.addEventListener('input', (event) => {
        state.filters.query = event.target.value;
        renderAll();
    });
    view.elements.categoryFilter.addEventListener('change', (event) => {
        state.filters.category = event.target.value;
        renderAll();
    });
    view.elements.stockFilter.addEventListener('change', (event) => {
        state.filters.stockFilter = event.target.value;
        renderAll();
    });
    view.elements.sortSelect.addEventListener('change', (event) => {
        state.filters.sortBy = event.target.value;
        renderAll();
    });

    kardexView.elements.movementType.addEventListener('change', () => {
        kardexView.syncMovementTypeUI();
    });
    kardexView.elements.movementForm.addEventListener('submit', (event) => {
        void handleMovementSubmit(event);
    });
    kardexView.elements.kardexProductFilter.addEventListener('change', (event) => {
        state.kardexFilters.productId = event.target.value;
        void refreshMovementsOnly().catch((error) => {
            if (handleUnauthorizedError(error)) return;
            kardexView.showError(error instanceof Error ? error.message : 'Error al filtrar Kardex.');
        });
    });
    kardexView.elements.kardexTypeFilter.addEventListener('change', (event) => {
        state.kardexFilters.type = event.target.value;
        void refreshMovementsOnly().catch((error) => {
            if (handleUnauthorizedError(error)) return;
            kardexView.showError(error instanceof Error ? error.message : 'Error al filtrar Kardex.');
        });
    });

    kardexView.elements.exportProductsCsvBtn.addEventListener('click', handleExportProductsCsv);
    kardexView.elements.exportKardexCsvBtn.addEventListener('click', handleExportKardexCsv);

    operationsView.elements.supplierForm.addEventListener('submit', (event) => {
        void handleSupplierSubmit(event);
    });
    operationsView.elements.purchaseForm.addEventListener('submit', (event) => {
        void handlePurchaseSubmit(event);
    });
    operationsView.elements.addPurchaseLineBtn.addEventListener('click', () => {
        operationsView.addPurchaseLine();
    });
    operationsView.elements.purchaseLines.addEventListener('input', () => {
        operationsView.handlePurchaseLinesInput();
    });
    operationsView.elements.purchaseLines.addEventListener('click', (event) => {
        const removeBtn = event.target.closest('button[data-action="remove-line"]');
        if (!removeBtn) return;
        const lines = operationsView.elements.purchaseLines.querySelectorAll('.order-line');
        if (lines.length <= 1) return;
        removeBtn.closest('.order-line')?.remove();
        operationsView.handlePurchaseLinesInput();
    });
    operationsView.elements.purchasesTableBody.addEventListener('click', (event) => {
        void handlePurchasesTableClick(event);
    });

    operationsView.elements.customerForm.addEventListener('submit', (event) => {
        void handleCustomerSubmit(event);
    });
    operationsView.elements.saleForm.addEventListener('submit', (event) => {
        void handleSaleSubmit(event);
    });
    operationsView.elements.addSaleLineBtn.addEventListener('click', () => {
        operationsView.addSaleLine();
    });
    operationsView.elements.saleLines.addEventListener('input', () => {
        operationsView.handleSaleLinesInput();
    });
    operationsView.elements.saleLines.addEventListener('change', () => {
        operationsView.handleSaleLinesInput();
    });
    operationsView.elements.saleLines.addEventListener('click', (event) => {
        const removeBtn = event.target.closest('button[data-action="remove-line"]');
        if (!removeBtn) return;
        const lines = operationsView.elements.saleLines.querySelectorAll('.order-line');
        if (lines.length <= 1) return;
        removeBtn.closest('.order-line')?.remove();
        operationsView.handleSaleLinesInput();
    });
    operationsView.elements.salesTableBody.addEventListener('click', (event) => {
        void handleSalesTableClick(event);
    });

    intakeView.elements.refreshAiModelsBtn?.addEventListener('click', () => {
        void handleRefreshAiModels();
    });
    intakeView.elements.intakeFileInput.addEventListener('change', (event) => {
        state.selectedFiles = Array.from(event.target.files ?? []);
        intakeView.renderSelectedFiles(state.selectedFiles);
    });
    intakeView.elements.intakeDropzone.addEventListener('dragover', (event) => {
        event.preventDefault();
        intakeView.elements.intakeDropzone.classList.add('is-dragover');
    });
    intakeView.elements.intakeDropzone.addEventListener('dragleave', () => {
        intakeView.elements.intakeDropzone.classList.remove('is-dragover');
    });
    intakeView.elements.intakeDropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        intakeView.elements.intakeDropzone.classList.remove('is-dragover');
        const dropped = Array.from(event.dataTransfer?.files ?? []);
        if (dropped.length > 0) {
            state.selectedFiles = dropped;
            intakeView.renderSelectedFiles(dropped);
        }
    });
    intakeView.elements.intakeUploadForm.addEventListener('submit', (event) => {
        void handleIntakeUploadSubmit(event);
    });
    intakeView.elements.intakeStatusFilter.addEventListener('change', (event) => {
        state.intakeFilterStatus = event.target.value;
        intakeView.renderQueue(state.intakes, state.intakeFilterStatus);
    });
    intakeView.elements.rejectErrorsBtn?.addEventListener('click', () => {
        void handleRejectAllErrors();
    });
    intakeView.elements.approveAllReadyBtn.addEventListener('click', () => {
        void handleApproveAllReady();
    });
    intakeView.elements.intakeTableBody.addEventListener('click', (event) => {
        void handleIntakeQueueClick(event);
    });

    intakeView.elements.reviewDocType.addEventListener('change', () => {
        intakeView.handleReviewDocTypeChange();
    });
    intakeView.elements.reviewPartySelect.addEventListener('change', () => {
        intakeView.handleReviewPartySelectChange();
    });
    intakeView.elements.reviewAddItemBtn.addEventListener('click', () => {
        intakeView.addReviewLine();
    });
    intakeView.elements.reviewItemsList.addEventListener('input', () => {
        intakeView.refreshReviewTotals();
    });
    intakeView.elements.reviewItemsList.addEventListener('change', () => {
        intakeView.refreshReviewTotals();
    });
    intakeView.elements.reviewItemsList.addEventListener('click', (event) => {
        const removeBtn = event.target.closest('button[data-action="remove-review-line"]');
        if (!removeBtn) return;
        const lines = intakeView.elements.reviewItemsList.querySelectorAll('.intake-line-card');
        if (lines.length <= 1) return;
        removeBtn.closest('.intake-line-card')?.remove();
        intakeView.refreshReviewTotals();
    });
    intakeView.elements.reviewForm.addEventListener('submit', (event) => {
        void handleReviewFormSubmit(event);
    });
    intakeView.elements.reviewApproveBtn.addEventListener('click', () => {
        void handleReviewApproveClick();
    });
    intakeView.elements.reviewRejectBtn.addEventListener('click', () => {
        void handleReviewRejectClick();
    });
    intakeView.elements.reviewCloseBtn.addEventListener('click', () => {
        intakeView.closeReviewPanel();
        renderAll();
    });

    authView.elements.userForm.addEventListener('submit', (event) => {
        void handleUserFormSubmit(event);
    });
    authView.elements.usersTableBody.addEventListener('click', (event) => {
        void handleUsersTableAction(event);
    });
    authView.elements.usersTableBody.addEventListener('change', (event) => {
        void handleUsersTableAction(event);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.editingId && !view.elements.confirmDialog.open) {
            exitEditMode();
        }
    });
}

async function init() {
    bindEvents();

    try {
        const status = await authRepository.getStatus();
        if (status.authenticated && status.user) {
            await enterAuthenticatedApp(status.user);
            return;
        }
        state.isSetupMode = !status.initialized;
        authView.showAuthScreen({ isSetupMode: state.isSetupMode });
    } catch (error) {
        authView.showAuthScreen({ isSetupMode: false });
        authView.showAuthError(
            error instanceof Error
                ? error.message
                : 'No se pudo conectar con el servidor SQLite del ERP.'
        );
    }
}

void init();
