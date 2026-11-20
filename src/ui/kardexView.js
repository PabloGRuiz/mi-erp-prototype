import { formatInteger } from '../domain/money.js';
import { calculateMovementSummary } from '../domain/movement.js';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short'
});

const MOVEMENT_TYPE_BADGE = {
    IN: { label: 'Entrada', className: 'badge badge-in' },
    OUT: { label: 'Salida', className: 'badge badge-out' },
    ADJUSTMENT: { label: 'Ajuste', className: 'badge badge-adjust' }
};

function createTextCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = text;
    return cell;
}

function formatDateTime(isoString) {
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) {
        return isoString ?? '';
    }
    return DATE_TIME_FORMATTER.format(parsed);
}

/**
 * Triggers a safe client-side CSV download from in-memory text.
 * @param {string} filename
 * @param {string} csvContent
 */
export function triggerCsvDownload(filename, csvContent) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pure XSS-safe DOM view layer for the Kardex movement ledger and CSV exports.
 * @param {Document} [doc=document]
 */
export function createKardexView(doc = document) {
    const elements = {
        movementFormCard: doc.getElementById('movement-form-card'),
        movementForm: doc.getElementById('movement-form'),
        movementProduct: doc.getElementById('movement-product'),
        movementType: doc.getElementById('movement-type'),
        movementQuantityLabel: doc.getElementById('movement-quantity-label'),
        movementQuantity: doc.getElementById('movement-quantity'),
        movementReason: doc.getElementById('movement-reason'),
        movementReference: doc.getElementById('movement-reference'),
        movementErrorMsg: doc.getElementById('movement-error-msg'),
        movementStatusMsg: doc.getElementById('movement-status-msg'),

        kardexProductFilter: doc.getElementById('kardex-product-filter'),
        kardexTypeFilter: doc.getElementById('kardex-type-filter'),
        kardexCount: doc.getElementById('kardex-count'),
        kardexSummaryIn: doc.getElementById('kardex-summary-in'),
        kardexSummaryOut: doc.getElementById('kardex-summary-out'),
        kardexTableBody: doc.getElementById('kardex-table-body'),

        exportProductsCsvBtn: doc.getElementById('export-products-csv-btn'),
        exportKardexCsvBtn: doc.getElementById('export-kardex-csv-btn')
    };

    const fieldInputs = {
        productId: elements.movementProduct,
        type: elements.movementType,
        quantity: elements.movementQuantity,
        reason: elements.movementReason,
        reference: elements.movementReference
    };

    function buildMovementRow(movement) {
        const row = doc.createElement('tr');

        const dateCell = createTextCell(formatDateTime(movement.createdAt), 'cell-numeric');

        const skuCell = doc.createElement('td');
        const skuCode = doc.createElement('code');
        skuCode.className = 'sku-code';
        skuCode.textContent = movement.productSku;
        skuCell.appendChild(skuCode);

        const productCell = createTextCell(movement.productName, 'cell-name');

        const typeCell = doc.createElement('td');
        const typeInfo = MOVEMENT_TYPE_BADGE[movement.type] ?? {
            label: movement.type,
            className: 'badge'
        };
        const badge = doc.createElement('span');
        badge.className = typeInfo.className;
        badge.textContent = typeInfo.label;
        typeCell.appendChild(badge);

        const deltaCell = doc.createElement('td');
        deltaCell.className = 'cell-numeric';
        const deltaSpan = doc.createElement('span');
        deltaSpan.className = movement.delta > 0 ? 'delta-positive' : 'delta-negative';
        deltaSpan.textContent =
            movement.delta > 0
                ? `+${formatInteger(movement.delta)}`
                : `-${formatInteger(Math.abs(movement.delta))}`;
        deltaCell.appendChild(deltaSpan);

        const stockTransitionCell = createTextCell(
            `${formatInteger(movement.previousStock)} → ${formatInteger(movement.resultingStock)}`,
            'cell-numeric'
        );

        const reasonCell = createTextCell(movement.reason);
        const referenceCell = createTextCell(movement.reference || '—', 'cell-muted');
        const userCell = createTextCell(movement.actorUsername || 'sistema', 'cell-muted');

        row.append(
            dateCell,
            skuCell,
            productCell,
            typeCell,
            deltaCell,
            stockTransitionCell,
            reasonCell,
            referenceCell,
            userCell
        );

        return row;
    }

    function buildEmptyRow() {
        const row = doc.createElement('tr');
        const cell = doc.createElement('td');
        cell.colSpan = 9;
        cell.className = 'empty-state';
        cell.textContent = 'Todavía no hay movimientos registrados para los filtros seleccionados.';
        row.appendChild(cell);
        return row;
    }

    return {
        elements,

        applyPermissions({ canWrite }) {
            if (elements.movementFormCard) {
                elements.movementFormCard.hidden = !canWrite;
            }
        },

        syncMovementTypeUI() {
            const isAdjustment = elements.movementType.value === 'ADJUSTMENT';
            elements.movementQuantityLabel.textContent = isAdjustment
                ? 'Stock real contado:'
                : 'Cantidad:';
            elements.movementQuantity.min = isAdjustment ? '0' : '1';
            elements.movementQuantity.placeholder = isAdjustment ? 'Ej. 10' : '1';
        },

        renderProductSelectors(products, selectedProductId = '', selectedFilterProductId = '') {
            const sortedProducts = [...products].sort((a, b) =>
                a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
            );

            const formFragment = doc.createDocumentFragment();
            const defaultOption = doc.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent =
                sortedProducts.length === 0
                    ? 'Cargá un producto primero...'
                    : 'Seleccioná un producto...';
            formFragment.appendChild(defaultOption);

            for (const product of sortedProducts) {
                const option = doc.createElement('option');
                option.value = product.id;
                option.textContent = `${product.sku} — ${product.name} (Stock: ${formatInteger(product.stock)})`;
                formFragment.appendChild(option);
            }

            elements.movementProduct.replaceChildren(formFragment);
            const hasFormSelection = sortedProducts.some((p) => p.id === selectedProductId);
            elements.movementProduct.value = hasFormSelection ? selectedProductId : '';
            elements.movementProduct.disabled = sortedProducts.length === 0;

            const filterFragment = doc.createDocumentFragment();
            const allOption = doc.createElement('option');
            allOption.value = '';
            allOption.textContent = 'Todos los productos';
            filterFragment.appendChild(allOption);

            for (const product of sortedProducts) {
                const option = doc.createElement('option');
                option.value = product.id;
                option.textContent = `${product.sku} — ${product.name}`;
                filterFragment.appendChild(option);
            }

            elements.kardexProductFilter.replaceChildren(filterFragment);
            const hasFilterSelection = sortedProducts.some((p) => p.id === selectedFilterProductId);
            elements.kardexProductFilter.value = hasFilterSelection ? selectedFilterProductId : '';
        },

        renderMovements(movements) {
            const summary = calculateMovementSummary(movements);
            elements.kardexCount.textContent = `Mostrando ${formatInteger(movements.length)} movimientos`;
            elements.kardexSummaryIn.textContent = `Entradas: +${formatInteger(summary.totalInUnits)}`;
            elements.kardexSummaryOut.textContent = `Salidas: -${formatInteger(summary.totalOutUnits)}`;

            const fragment = doc.createDocumentFragment();
            if (movements.length === 0) {
                fragment.appendChild(buildEmptyRow());
            } else {
                for (const movement of movements) {
                    fragment.appendChild(buildMovementRow(movement));
                }
            }

            elements.kardexTableBody.replaceChildren(fragment);
        },

        readFormValues() {
            return {
                productId: elements.movementProduct.value,
                type: elements.movementType.value,
                quantity: elements.movementQuantity.value,
                reason: elements.movementReason.value,
                reference: elements.movementReference.value
            };
        },

        resetForm(keepProductId = '') {
            const selectedType = elements.movementType.value || 'IN';
            elements.movementForm.reset();
            elements.movementType.value = selectedType;
            elements.movementQuantity.value = selectedType === 'ADJUSTMENT' ? '0' : '1';
            if (keepProductId) {
                elements.movementProduct.value = keepProductId;
            }
            this.syncMovementTypeUI();
        },

        showError(message, field = null) {
            for (const input of Object.values(fieldInputs)) {
                input.removeAttribute('aria-invalid');
            }
            elements.movementErrorMsg.textContent = message;
            if (field && fieldInputs[field]) {
                fieldInputs[field].setAttribute('aria-invalid', 'true');
                fieldInputs[field].focus();
            }
        },

        clearError() {
            elements.movementErrorMsg.textContent = '';
            for (const input of Object.values(fieldInputs)) {
                input.removeAttribute('aria-invalid');
            }
        },

        showStatus(message) {
            elements.movementStatusMsg.textContent = message;
        },

        clearStatus() {
            elements.movementStatusMsg.textContent = '';
        }
    };
}

