import {
    centsToInputValue,
    formatCurrencyFromCents,
    formatInteger
} from '../domain/money.js';
import {
    calculateInventoryMetrics,
    calculateProductSubtotalCents,
    getStockStatus
} from '../domain/product.js';

const STOCK_STATUS_BADGE = {
    ok: { label: 'Normal', className: 'badge badge-ok' },
    low: { label: 'Stock bajo', className: 'badge badge-low' },
    out: { label: 'Sin stock', className: 'badge badge-out' }
};

function createTextCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = text;
    return cell;
}

function createActionButton({ label, action, productId, className, ariaLabel, disabled = false }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.action = action;
    button.dataset.id = productId;
    button.textContent = label;
    button.setAttribute('aria-label', ariaLabel);
    button.disabled = disabled;
    return button;
}

/**
 * Pure DOM view layer for the ERP inventory screen.
 * Uses createElement, textContent, DocumentFragment, and replaceChildren to prevent XSS.
 * @param {Document} [doc=document]
 */
export function createInventoryView(doc = document) {
    let permissions = { canWrite: true, canDelete: true };

    const elements = {
        kpiTotalSkus: doc.getElementById('kpi-total-skus'),
        kpiTotalUnits: doc.getElementById('kpi-total-units'),
        kpiLowStockCard: doc.getElementById('kpi-low-stock-card'),
        kpiLowStock: doc.getElementById('kpi-low-stock'),
        kpiTotalValue: doc.getElementById('kpi-total-value'),

        productFormSection: doc.getElementById('product-form-section'),
        formHeading: doc.getElementById('form-heading'),
        errorMsg: doc.getElementById('error-msg'),
        statusMsg: doc.getElementById('status-msg'),
        form: doc.getElementById('product-form'),
        skuInput: doc.getElementById('product-sku'),
        nameInput: doc.getElementById('product-name'),
        categoryInput: doc.getElementById('product-category'),
        categorySuggestions: doc.getElementById('category-suggestions'),
        priceInput: doc.getElementById('product-unit-price'),
        stockInput: doc.getElementById('product-stock'),
        minStockInput: doc.getElementById('product-min-stock'),
        submitBtn: doc.getElementById('submit-btn'),
        cancelEditBtn: doc.getElementById('cancel-edit-btn'),

        searchInput: doc.getElementById('search-input'),
        categoryFilter: doc.getElementById('category-filter'),
        stockFilter: doc.getElementById('stock-filter'),
        sortSelect: doc.getElementById('sort-select'),
        listCount: doc.getElementById('list-count'),
        tableBody: doc.getElementById('table-body'),
        inventoryTotal: doc.getElementById('inventory-total'),

        confirmDialog: doc.getElementById('confirm-dialog'),
        confirmDialogTitle: doc.getElementById('confirm-dialog-title'),
        confirmDialogMessage: doc.getElementById('confirm-dialog-message'),
        confirmCancelBtn: doc.getElementById('confirm-cancel-btn'),
        confirmAcceptBtn: doc.getElementById('confirm-accept-btn')
    };

    const fieldInputs = {
        sku: elements.skuInput,
        name: elements.nameInput,
        category: elements.categoryInput,
        price: elements.priceInput,
        stock: elements.stockInput,
        minStock: elements.minStockInput
    };

    function buildProductRow(product, isEditing) {
        const row = doc.createElement('tr');
        if (isEditing) {
            row.classList.add('is-editing');
        }

        const skuCell = doc.createElement('td');
        const skuCode = doc.createElement('code');
        skuCode.className = 'sku-code';
        skuCode.textContent = product.sku;
        skuCell.appendChild(skuCode);

        const nameCell = createTextCell(product.name, 'cell-name');
        const categoryCell = createTextCell(product.category);
        const priceCell = createTextCell(formatCurrencyFromCents(product.priceCents), 'cell-numeric');

        const stockCell = doc.createElement('td');
        const stepper = doc.createElement('div');
        stepper.className = 'stock-stepper';

        const decrementBtn = createActionButton({
            label: '-',
            action: 'decrement',
            productId: product.id,
            className: 'stepper-btn',
            ariaLabel: `Restar 1 unidad a ${product.name}`,
            disabled: !permissions.canWrite || product.stock === 0
        });

        const stockValue = doc.createElement('span');
        stockValue.className = 'stock-value';
        stockValue.textContent = formatInteger(product.stock);

        const incrementBtn = createActionButton({
            label: '+',
            action: 'increment',
            productId: product.id,
            className: 'stepper-btn',
            ariaLabel: `Sumar 1 unidad a ${product.name}`,
            disabled: !permissions.canWrite
        });

        stepper.append(decrementBtn, stockValue, incrementBtn);
        stockCell.appendChild(stepper);

        const statusCell = doc.createElement('td');
        const statusKey = getStockStatus(product);
        const statusInfo = STOCK_STATUS_BADGE[statusKey];
        const statusBadge = doc.createElement('span');
        statusBadge.className = statusInfo.className;
        statusBadge.textContent = statusInfo.label;
        statusBadge.title = `Stock mínimo configurado: ${formatInteger(product.minStock)}`;
        statusCell.appendChild(statusBadge);

        const totalCell = createTextCell(
            formatCurrencyFromCents(calculateProductSubtotalCents(product)),
            'cell-numeric cell-subtotal'
        );

        const actionsCell = doc.createElement('td');
        const actionsGroup = doc.createElement('div');
        actionsGroup.className = 'row-actions';

        if (permissions.canWrite) {
            const editBtn = createActionButton({
                label: 'Editar',
                action: 'edit',
                productId: product.id,
                className: 'action-btn action-edit',
                ariaLabel: `Editar ${product.name}`
            });
            actionsGroup.appendChild(editBtn);
        }

        if (permissions.canDelete) {
            const deleteBtn = createActionButton({
                label: 'Eliminar',
                action: 'delete',
                productId: product.id,
                className: 'action-btn action-delete',
                ariaLabel: `Eliminar ${product.name}`
            });
            actionsGroup.appendChild(deleteBtn);
        }

        if (actionsGroup.childElementCount === 0) {
            const readOnlyLabel = doc.createElement('span');
            readOnlyLabel.className = 'cell-muted';
            readOnlyLabel.textContent = 'Solo lectura';
            actionsCell.appendChild(readOnlyLabel);
        } else {
            actionsCell.appendChild(actionsGroup);
        }

        row.append(
            skuCell,
            nameCell,
            categoryCell,
            priceCell,
            stockCell,
            statusCell,
            totalCell,
            actionsCell
        );

        return row;
    }

    function buildEmptyRow(totalProductCount) {
        const row = doc.createElement('tr');
        const cell = doc.createElement('td');
        cell.colSpan = 8;
        cell.className = 'empty-state';
        cell.textContent =
            totalProductCount === 0
                ? 'Todavía no hay productos cargados en el inventario. Agregá el primero desde el formulario superior.'
                : 'No hay productos que coincidan con los filtros o la búsqueda actual.';
        row.appendChild(cell);
        return row;
    }

    return {
        elements,

        applyPermissions(nextPermissions) {
            permissions = { ...nextPermissions };
            if (elements.productFormSection) {
                elements.productFormSection.hidden = !permissions.canWrite;
            }
        },

        renderMetrics(metrics) {
            elements.kpiTotalSkus.textContent = formatInteger(metrics.totalProducts);
            elements.kpiTotalUnits.textContent = formatInteger(metrics.totalUnits);
            elements.kpiLowStock.textContent = formatInteger(metrics.lowStockCount);
            elements.kpiTotalValue.textContent = formatCurrencyFromCents(metrics.totalValueCents);

            if (metrics.lowStockCount > 0) {
                elements.kpiLowStockCard.dataset.alert = 'true';
            } else {
                delete elements.kpiLowStockCard.dataset.alert;
            }
        },

        renderCategoryOptions(categories, selectedCategory = 'all') {
            const filterFragment = doc.createDocumentFragment();
            const allOption = doc.createElement('option');
            allOption.value = 'all';
            allOption.textContent = 'Todas las categorías';
            filterFragment.appendChild(allOption);

            for (const category of categories) {
                const option = doc.createElement('option');
                option.value = category;
                option.textContent = category;
                filterFragment.appendChild(option);
            }

            elements.categoryFilter.replaceChildren(filterFragment);
            elements.categoryFilter.value = categories.includes(selectedCategory) ? selectedCategory : 'all';

            if (elements.categorySuggestions) {
                const suggestionSet = new Set([
                    'General',
                    'Periféricos',
                    'Hardware',
                    'Redes',
                    'Insumos',
                    ...categories
                ]);
                const suggestionsFragment = doc.createDocumentFragment();
                for (const category of suggestionSet) {
                    const option = doc.createElement('option');
                    option.value = category;
                    suggestionsFragment.appendChild(option);
                }
                elements.categorySuggestions.replaceChildren(suggestionsFragment);
            }
        },

        renderTable(visibleProducts, totalProductCount, editingId = null) {
            const fragment = doc.createDocumentFragment();

            if (visibleProducts.length === 0) {
                fragment.appendChild(buildEmptyRow(totalProductCount));
            } else {
                for (const product of visibleProducts) {
                    fragment.appendChild(buildProductRow(product, product.id === editingId));
                }
            }

            elements.tableBody.replaceChildren(fragment);

            const visibleMetrics = calculateInventoryMetrics(visibleProducts);
            elements.inventoryTotal.textContent = formatCurrencyFromCents(visibleMetrics.totalValueCents);
            elements.listCount.textContent = `Mostrando ${formatInteger(visibleProducts.length)} de ${formatInteger(totalProductCount)} productos`;
        },

        readFormValues() {
            return {
                sku: elements.skuInput.value,
                name: elements.nameInput.value,
                category: elements.categoryInput.value,
                price: elements.priceInput.value,
                stock: elements.stockInput.value,
                minStock: elements.minStockInput.value
            };
        },

        setFormMode(productOrNull) {
            if (productOrNull) {
                elements.formHeading.textContent = `Editar producto (${productOrNull.sku})`;
                elements.submitBtn.textContent = 'Guardar cambios';
                elements.cancelEditBtn.hidden = false;

                elements.skuInput.value = productOrNull.sku;
                elements.nameInput.value = productOrNull.name;
                elements.categoryInput.value = productOrNull.category;
                elements.priceInput.value = centsToInputValue(productOrNull.priceCents);
                elements.stockInput.value = String(productOrNull.stock);
                elements.minStockInput.value = String(productOrNull.minStock);
                return;
            }

            elements.formHeading.textContent = 'Alta de producto';
            elements.submitBtn.textContent = 'Agregar producto';
            elements.cancelEditBtn.hidden = true;
            elements.form.reset();
            elements.minStockInput.value = '5';
        },

        focusField(field = 'sku') {
            const target = fieldInputs[field] ?? elements.skuInput;
            target?.focus();
        },

        showError(message, field = null) {
            for (const input of Object.values(fieldInputs)) {
                input.removeAttribute('aria-invalid');
            }

            elements.errorMsg.textContent = message;

            if (field && fieldInputs[field]) {
                fieldInputs[field].setAttribute('aria-invalid', 'true');
                fieldInputs[field].focus();
            }
        },

        clearError() {
            elements.errorMsg.textContent = '';
            for (const input of Object.values(fieldInputs)) {
                input.removeAttribute('aria-invalid');
            }
        },

        showStatus(message) {
            elements.statusMsg.textContent = message;
        },

        clearStatus() {
            elements.statusMsg.textContent = '';
        },

        confirmAction({
            title = 'Confirmar acción',
            message,
            confirmLabel = 'Confirmar'
        }) {
            const dialog = elements.confirmDialog;

            if (!dialog || typeof dialog.showModal !== 'function') {
                return Promise.resolve(globalThis.confirm ? globalThis.confirm(message) : false);
            }

            if (elements.confirmDialogTitle) {
                elements.confirmDialogTitle.textContent = title;
            }
            elements.confirmDialogMessage.textContent = message;
            elements.confirmAcceptBtn.textContent = confirmLabel;
            dialog.returnValue = '';

            return new Promise((resolve) => {
                function cleanup() {
                    elements.confirmCancelBtn.removeEventListener('click', handleCancel);
                    elements.confirmAcceptBtn.removeEventListener('click', handleAccept);
                    dialog.removeEventListener('close', handleClose);
                }

                function handleCancel() {
                    dialog.close('cancel');
                }

                function handleAccept() {
                    dialog.close('confirm');
                }

                function handleClose() {
                    const accepted = dialog.returnValue === 'confirm';
                    cleanup();
                    resolve(accepted);
                }

                elements.confirmCancelBtn.addEventListener('click', handleCancel);
                elements.confirmAcceptBtn.addEventListener('click', handleAccept);
                dialog.addEventListener('close', handleClose);
                dialog.showModal();
                elements.confirmCancelBtn.focus();
            });
        },

        confirmDelete(product) {
            return this.confirmAction({
                title: 'Confirmar eliminación',
                message: `¿Seguro que querés eliminar "${product.name}" (SKU: ${product.sku}) del inventario? Esta acción no se puede deshacer.`,
                confirmLabel: 'Eliminar producto'
            });
        }
    };
}

