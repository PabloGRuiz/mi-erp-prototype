import { exportMovementsToCsv, exportProductsToCsv } from './domain/csv.js';
import { validateMovementInput } from './domain/movement.js';
import {
    calculateInventoryMetrics,
    filterAndSortProducts,
    getUniqueCategories,
    validateProductInput
} from './domain/product.js';
import { createHttpInventoryRepository } from './repositories/httpInventoryRepository.js';
import { createInventoryView } from './ui/inventoryView.js';
import { createKardexView, triggerCsvDownload } from './ui/kardexView.js';

const inventoryRepository = createHttpInventoryRepository('/api');
const view = createInventoryView();
const kardexView = createKardexView();

const state = {
    products: [],
    movements: [],
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

function render() {
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
}

async function syncFromServer() {
    const [products, movements] = await Promise.all([
        inventoryRepository.getAll(),
        inventoryRepository.getMovements(state.kardexFilters)
    ]);

    state.products = products;
    state.movements = movements;
}

async function refreshMovementsOnly() {
    state.movements = await inventoryRepository.getMovements(state.kardexFilters);
    kardexView.renderMovements(state.movements);
}

function exitEditMode() {
    state.editingId = null;
    view.clearError();
    view.setFormMode(null);
    render();
    view.focusField('sku');
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
        render();
        view.focusField('sku');
    } catch (error) {
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
        render();
    } catch (error) {
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
        render();
    } catch (error) {
        view.showError(error instanceof Error ? error.message : 'No se pudo eliminar el producto.');
    }
}

function handleTableClick(event) {
    const actionButton = event.target.closest('button[data-action]');
    if (!actionButton) {
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
        render();
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
        render();
    } catch (error) {
        kardexView.showError(
            error instanceof Error ? error.message : 'No se pudo registrar el movimiento.',
            error?.field ?? null
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
    view.elements.form.addEventListener('submit', (event) => {
        void handleFormSubmit(event);
    });

    view.elements.cancelEditBtn.addEventListener('click', exitEditMode);
    view.elements.tableBody.addEventListener('click', handleTableClick);

    view.elements.searchInput.addEventListener('input', (event) => {
        state.filters.query = event.target.value;
        render();
    });

    view.elements.categoryFilter.addEventListener('change', (event) => {
        state.filters.category = event.target.value;
        render();
    });

    view.elements.stockFilter.addEventListener('change', (event) => {
        state.filters.stockFilter = event.target.value;
        render();
    });

    view.elements.sortSelect.addEventListener('change', (event) => {
        state.filters.sortBy = event.target.value;
        render();
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
            kardexView.showError(error instanceof Error ? error.message : 'Error al filtrar Kardex.');
        });
    });

    kardexView.elements.kardexTypeFilter.addEventListener('change', (event) => {
        state.kardexFilters.type = event.target.value;
        void refreshMovementsOnly().catch((error) => {
            kardexView.showError(error instanceof Error ? error.message : 'Error al filtrar Kardex.');
        });
    });

    kardexView.elements.exportProductsCsvBtn.addEventListener('click', handleExportProductsCsv);
    kardexView.elements.exportKardexCsvBtn.addEventListener('click', handleExportKardexCsv);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.editingId && !view.elements.confirmDialog.open) {
            exitEditMode();
        }
    });
}

async function init() {
    bindEvents();
    view.setFormMode(null);
    kardexView.syncMovementTypeUI();

    try {
        await syncFromServer();
    } catch (error) {
        view.showError(
            error instanceof Error
                ? error.message
                : 'No se pudo conectar con el servidor SQLite del ERP.'
        );
    }

    render();
}

void init();
