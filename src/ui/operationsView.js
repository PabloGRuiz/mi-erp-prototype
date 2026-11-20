import { formatCurrencyFromCents, formatInteger } from '../domain/money.js';
import { calculateOperationsSummary, PURCHASE_STATUS, SALE_STATUS } from '../domain/operations.js';
import { parsePriceToCents } from '../domain/money.js';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short'
});

const PURCHASE_STATUS_BADGE = {
    DRAFT: { label: 'Borrador', className: 'badge badge-low' },
    RECEIVED: { label: 'Recibida', className: 'badge badge-ok' },
    CANCELLED: { label: 'Anulada', className: 'badge badge-out' }
};

const SALE_STATUS_BADGE = {
    CONFIRMED: { label: 'Confirmada', className: 'badge badge-ok' },
    CANCELLED: { label: 'Anulada', className: 'badge badge-out' }
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
 * Pure XSS-safe DOM view layer for Suppliers, Purchase Orders, Customers, and Sales Orders.
 * @param {Document} [doc=document]
 */
export function createOperationsView(doc = document) {
    let cachedProducts = [];
    let productsById = new Map();
    let permissions = { canWrite: false, canCancelPurchases: false, canCancelSales: false };

    const elements = {
        purchasesSummary: doc.getElementById('purchases-summary'),
        supplierFormCard: doc.getElementById('supplier-form-card'),
        supplierErrorMsg: doc.getElementById('supplier-error-msg'),
        supplierStatusMsg: doc.getElementById('supplier-status-msg'),
        supplierForm: doc.getElementById('supplier-form'),
        supplierName: doc.getElementById('supplier-name'),
        supplierTaxId: doc.getElementById('supplier-tax-id'),
        supplierEmail: doc.getElementById('supplier-email'),
        supplierPhone: doc.getElementById('supplier-phone'),

        purchaseFormCard: doc.getElementById('purchase-form-card'),
        purchaseErrorMsg: doc.getElementById('purchase-error-msg'),
        purchaseStatusMsg: doc.getElementById('purchase-status-msg'),
        purchaseForm: doc.getElementById('purchase-form'),
        purchaseSupplier: doc.getElementById('purchase-supplier'),
        purchaseReceiveNow: doc.getElementById('purchase-receive-now'),
        purchaseNotes: doc.getElementById('purchase-notes'),
        purchaseLines: doc.getElementById('purchase-lines'),
        addPurchaseLineBtn: doc.getElementById('add-purchase-line-btn'),
        purchaseLiveTotal: doc.getElementById('purchase-live-total'),
        purchasesTableBody: doc.getElementById('purchases-table-body'),

        salesSummary: doc.getElementById('sales-summary'),
        customerFormCard: doc.getElementById('customer-form-card'),
        customerErrorMsg: doc.getElementById('customer-error-msg'),
        customerStatusMsg: doc.getElementById('customer-status-msg'),
        customerForm: doc.getElementById('customer-form'),
        customerName: doc.getElementById('customer-name'),
        customerTaxId: doc.getElementById('customer-tax-id'),
        customerEmail: doc.getElementById('customer-email'),
        customerPhone: doc.getElementById('customer-phone'),

        saleFormCard: doc.getElementById('sale-form-card'),
        saleErrorMsg: doc.getElementById('sale-error-msg'),
        saleStatusMsg: doc.getElementById('sale-status-msg'),
        saleForm: doc.getElementById('sale-form'),
        saleCustomer: doc.getElementById('sale-customer'),
        saleNotes: doc.getElementById('sale-notes'),
        saleLines: doc.getElementById('sale-lines'),
        addSaleLineBtn: doc.getElementById('add-sale-line-btn'),
        saleLiveTotal: doc.getElementById('sale-live-total'),
        salesTableBody: doc.getElementById('sales-table-body')
    };

    const supplierInputs = {
        name: elements.supplierName,
        taxId: elements.supplierTaxId,
        email: elements.supplierEmail,
        phone: elements.supplierPhone
    };

    const customerInputs = {
        name: elements.customerName,
        taxId: elements.customerTaxId,
        email: elements.customerEmail,
        phone: elements.customerPhone
    };

    function populateProductSelectOptions(selectEl, includeSaleMeta, selectedId = '') {
        const sorted = [...cachedProducts].sort((a, b) =>
            a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
        );
        const fragment = doc.createDocumentFragment();
        const placeholder = doc.createElement('option');
        placeholder.value = '';
        placeholder.textContent =
            sorted.length === 0 ? 'Sin productos en catálogo...' : 'Seleccioná un producto...';
        fragment.appendChild(placeholder);

        for (const product of sorted) {
            const option = doc.createElement('option');
            option.value = product.id;
            option.textContent = includeSaleMeta
                ? `${product.sku} — ${product.name} (${formatCurrencyFromCents(product.priceCents)} · Stock: ${formatInteger(product.stock)})`
                : `${product.sku} — ${product.name} (Stock: ${formatInteger(product.stock)})`;
            fragment.appendChild(option);
        }

        selectEl.replaceChildren(fragment);
        selectEl.value = sorted.some((p) => p.id === selectedId) ? selectedId : '';
    }

    function updatePurchaseLiveTotals() {
        let totalCents = 0;
        for (const lineRow of elements.purchaseLines.querySelectorAll('.order-line')) {
            const qty = Number(lineRow.querySelector('.line-qty')?.value ?? 0);
            const costCents = parsePriceToCents(lineRow.querySelector('.line-cost')?.value ?? '');
            const subtotalCents =
                Number.isInteger(qty) && qty > 0 && costCents !== null ? qty * costCents : 0;
            totalCents += subtotalCents;
            const subtotalEl = lineRow.querySelector('.line-subtotal');
            if (subtotalEl) {
                subtotalEl.textContent = formatCurrencyFromCents(subtotalCents);
            }
        }
        elements.purchaseLiveTotal.textContent = formatCurrencyFromCents(totalCents);
    }

    function updateSaleLiveTotals() {
        let totalCents = 0;
        for (const lineRow of elements.saleLines.querySelectorAll('.order-line')) {
            const productId = lineRow.querySelector('.line-product')?.value ?? '';
            const product = productsById.get(productId);
            const qty = Number(lineRow.querySelector('.line-qty')?.value ?? 0);
            const unitPriceCents = product ? product.priceCents : 0;
            const subtotalCents =
                product && Number.isInteger(qty) && qty > 0 ? unitPriceCents * qty : 0;
            totalCents += subtotalCents;

            const priceEl = lineRow.querySelector('.line-unit-price');
            const subtotalEl = lineRow.querySelector('.line-subtotal');
            if (priceEl) {
                priceEl.textContent = product ? formatCurrencyFromCents(unitPriceCents) : '—';
            }
            if (subtotalEl) {
                subtotalEl.textContent = formatCurrencyFromCents(subtotalCents);
            }
        }
        elements.saleLiveTotal.textContent = formatCurrencyFromCents(totalCents);
    }

    function buildOrderItemsCell(items, unitField) {
        const cell = doc.createElement('td');
        const list = doc.createElement('ul');
        list.className = 'order-items-list';

        for (const item of items) {
            const li = doc.createElement('li');
            li.textContent = `${formatInteger(item.quantity)} × ${item.productSku} — ${item.productName} (${formatCurrencyFromCents(item[unitField])})`;
            list.appendChild(li);
        }

        cell.appendChild(list);
        return cell;
    }

    function createPartyOptionList(selectEl, items, emptyLabel) {
        const previous = selectEl.value;
        const fragment = doc.createDocumentFragment();
        const first = doc.createElement('option');
        first.value = '';
        first.textContent = emptyLabel;
        fragment.appendChild(first);

        for (const party of items) {
            const option = doc.createElement('option');
            option.value = party.id;
            option.textContent = party.taxId ? `${party.name} (${party.taxId})` : party.name;
            fragment.appendChild(option);
        }

        selectEl.replaceChildren(fragment);
        selectEl.value = items.some((p) => p.id === previous) ? previous : '';
    }

    return {
        elements,

        applyPermissions(nextPermissions) {
            permissions = { ...nextPermissions };
            elements.supplierFormCard.hidden = !permissions.canWrite;
            elements.purchaseFormCard.hidden = !permissions.canWrite;
            elements.customerFormCard.hidden = !permissions.canWrite;
            elements.saleFormCard.hidden = !permissions.canWrite;
        },

        renderProductCatalog(products) {
            cachedProducts = products;
            productsById = new Map(products.map((p) => [p.id, p]));

            for (const select of elements.purchaseLines.querySelectorAll('.line-product')) {
                populateProductSelectOptions(select, false, select.value);
            }
            for (const select of elements.saleLines.querySelectorAll('.line-product')) {
                populateProductSelectOptions(select, true, select.value);
            }

            updatePurchaseLiveTotals();
            updateSaleLiveTotals();
        },

        renderSuppliers(suppliers) {
            createPartyOptionList(
                elements.purchaseSupplier,
                suppliers,
                suppliers.length === 0 ? 'Agregá un proveedor primero...' : 'Seleccioná un proveedor...'
            );
        },

        renderCustomers(customers) {
            createPartyOptionList(elements.saleCustomer, customers, 'Consumidor Final (sin cliente)');
        },

        addPurchaseLine() {
            const row = doc.createElement('div');
            row.className = 'order-line order-line-purchase';

            const select = doc.createElement('select');
            select.className = 'line-product';
            select.setAttribute('aria-label', 'Producto a comprar');
            populateProductSelectOptions(select, false, '');

            const qtyInput = doc.createElement('input');
            qtyInput.type = 'number';
            qtyInput.className = 'line-qty';
            qtyInput.min = '1';
            qtyInput.step = '1';
            qtyInput.value = '1';
            qtyInput.placeholder = 'Cant.';
            qtyInput.setAttribute('aria-label', 'Cantidad a comprar');

            const costInput = doc.createElement('input');
            costInput.type = 'number';
            costInput.className = 'line-cost';
            costInput.min = '0';
            costInput.step = '0.01';
            costInput.placeholder = 'Costo unit.';
            costInput.setAttribute('aria-label', 'Costo unitario');

            const subtotalSpan = doc.createElement('span');
            subtotalSpan.className = 'line-subtotal';
            subtotalSpan.textContent = formatCurrencyFromCents(0);

            const removeBtn = doc.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'action-btn action-delete';
            removeBtn.dataset.action = 'remove-line';
            removeBtn.textContent = 'Quitar';

            row.append(select, qtyInput, costInput, subtotalSpan, removeBtn);
            elements.purchaseLines.appendChild(row);
            updatePurchaseLiveTotals();
        },

        addSaleLine() {
            const row = doc.createElement('div');
            row.className = 'order-line order-line-sale';

            const select = doc.createElement('select');
            select.className = 'line-product';
            select.setAttribute('aria-label', 'Producto a vender');
            populateProductSelectOptions(select, true, '');

            const qtyInput = doc.createElement('input');
            qtyInput.type = 'number';
            qtyInput.className = 'line-qty';
            qtyInput.min = '1';
            qtyInput.step = '1';
            qtyInput.value = '1';
            qtyInput.placeholder = 'Cant.';
            qtyInput.setAttribute('aria-label', 'Cantidad a vender');

            const unitPriceSpan = doc.createElement('span');
            unitPriceSpan.className = 'line-unit-price';
            unitPriceSpan.textContent = '—';

            const subtotalSpan = doc.createElement('span');
            subtotalSpan.className = 'line-subtotal';
            subtotalSpan.textContent = formatCurrencyFromCents(0);

            const removeBtn = doc.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'action-btn action-delete';
            removeBtn.dataset.action = 'remove-line';
            removeBtn.textContent = 'Quitar';

            row.append(select, qtyInput, unitPriceSpan, subtotalSpan, removeBtn);
            elements.saleLines.appendChild(row);
            updateSaleLiveTotals();
        },

        resetPurchaseLines() {
            elements.purchaseLines.replaceChildren();
            this.addPurchaseLine();
        },

        resetSaleLines() {
            elements.saleLines.replaceChildren();
            this.addSaleLine();
        },

        handlePurchaseLinesInput() {
            updatePurchaseLiveTotals();
        },

        handleSaleLinesInput() {
            updateSaleLiveTotals();
        },

        readSupplierForm() {
            return {
                name: elements.supplierName.value,
                taxId: elements.supplierTaxId.value,
                email: elements.supplierEmail.value,
                phone: elements.supplierPhone.value
            };
        },

        readPurchaseForm() {
            const items = Array.from(elements.purchaseLines.querySelectorAll('.order-line')).map((row) => ({
                productId: row.querySelector('.line-product')?.value ?? '',
                quantity: row.querySelector('.line-qty')?.value ?? '',
                unitCost: row.querySelector('.line-cost')?.value ?? ''
            }));
            return {
                supplierId: elements.purchaseSupplier.value,
                receiveNow: elements.purchaseReceiveNow.checked,
                notes: elements.purchaseNotes.value,
                items
            };
        },

        readCustomerForm() {
            return {
                name: elements.customerName.value,
                taxId: elements.customerTaxId.value,
                email: elements.customerEmail.value,
                phone: elements.customerPhone.value
            };
        },

        readSaleForm() {
            const items = Array.from(elements.saleLines.querySelectorAll('.order-line')).map((row) => ({
                productId: row.querySelector('.line-product')?.value ?? '',
                quantity: row.querySelector('.line-qty')?.value ?? ''
            }));
            return {
                customerId: elements.saleCustomer.value,
                notes: elements.saleNotes.value,
                items
            };
        },

        renderPurchases(purchases, sales) {
            const summary = calculateOperationsSummary(purchases, sales);
            elements.purchasesSummary.textContent = `Recibidas: ${formatInteger(summary.receivedPurchasesCount)} · Borradores: ${formatInteger(summary.draftPurchasesCount)} · Total recibido: ${formatCurrencyFromCents(summary.receivedPurchasesTotalCents)}`;

            const fragment = doc.createDocumentFragment();
            if (purchases.length === 0) {
                const row = doc.createElement('tr');
                const cell = doc.createElement('td');
                cell.colSpan = 8;
                cell.className = 'empty-state';
                cell.textContent = 'Todavía no hay órdenes de compra registradas.';
                row.appendChild(cell);
                fragment.appendChild(row);
            } else {
                for (const purchase of purchases) {
                    const row = doc.createElement('tr');

                    const numCell = doc.createElement('td');
                    const code = doc.createElement('code');
                    code.className = 'sku-code';
                    code.textContent = purchase.orderNumber;
                    numCell.appendChild(code);

                    const dateCell = createTextCell(formatDateTime(purchase.createdAt), 'cell-numeric');
                    const supplierCell = createTextCell(purchase.supplierName, 'cell-name');
                    const itemsCell = buildOrderItemsCell(purchase.items, 'unitCostCents');

                    const statusCell = doc.createElement('td');
                    const badgeInfo = PURCHASE_STATUS_BADGE[purchase.status] ?? {
                        label: purchase.status,
                        className: 'badge'
                    };
                    const badge = doc.createElement('span');
                    badge.className = badgeInfo.className;
                    badge.textContent = badgeInfo.label;
                    statusCell.appendChild(badge);

                    const totalCell = createTextCell(
                        formatCurrencyFromCents(purchase.totalCents),
                        'cell-numeric cell-subtotal'
                    );
                    const userCell = createTextCell(purchase.actorUsername || 'sistema', 'cell-muted');

                    const actionsCell = doc.createElement('td');
                    const actionsGroup = doc.createElement('div');
                    actionsGroup.className = 'row-actions';

                    if (purchase.status === PURCHASE_STATUS.DRAFT && permissions.canWrite) {
                        const receiveBtn = doc.createElement('button');
                        receiveBtn.type = 'button';
                        receiveBtn.className = 'action-btn action-edit';
                        receiveBtn.dataset.action = 'receive-purchase';
                        receiveBtn.dataset.id = purchase.id;
                        receiveBtn.textContent = 'Recibir';
                        actionsGroup.appendChild(receiveBtn);
                    }

                    if (purchase.status === PURCHASE_STATUS.DRAFT && permissions.canCancelPurchases) {
                        const cancelBtn = doc.createElement('button');
                        cancelBtn.type = 'button';
                        cancelBtn.className = 'action-btn action-delete';
                        cancelBtn.dataset.action = 'cancel-purchase';
                        cancelBtn.dataset.id = purchase.id;
                        cancelBtn.textContent = 'Cancelar';
                        actionsGroup.appendChild(cancelBtn);
                    }

                    if (actionsGroup.childElementCount === 0) {
                        const dash = doc.createElement('span');
                        dash.className = 'cell-muted';
                        dash.textContent = '—';
                        actionsCell.appendChild(dash);
                    } else {
                        actionsCell.appendChild(actionsGroup);
                    }

                    row.append(
                        numCell,
                        dateCell,
                        supplierCell,
                        itemsCell,
                        statusCell,
                        totalCell,
                        userCell,
                        actionsCell
                    );
                    fragment.appendChild(row);
                }
            }

            elements.purchasesTableBody.replaceChildren(fragment);
        },

        renderSales(sales, purchases) {
            const summary = calculateOperationsSummary(purchases, sales);
            elements.salesSummary.textContent = `Confirmadas: ${formatInteger(summary.confirmedSalesCount)} · Anuladas: ${formatInteger(summary.cancelledSalesCount)} · Facturado: ${formatCurrencyFromCents(summary.confirmedSalesTotalCents)}`;

            const fragment = doc.createDocumentFragment();
            if (sales.length === 0) {
                const row = doc.createElement('tr');
                const cell = doc.createElement('td');
                cell.colSpan = 8;
                cell.className = 'empty-state';
                cell.textContent = 'Todavía no hay ventas registradas.';
                row.appendChild(cell);
                fragment.appendChild(row);
            } else {
                for (const sale of sales) {
                    const row = doc.createElement('tr');

                    const numCell = doc.createElement('td');
                    const code = doc.createElement('code');
                    code.className = 'sku-code';
                    code.textContent = sale.saleNumber;
                    numCell.appendChild(code);

                    const dateCell = createTextCell(formatDateTime(sale.createdAt), 'cell-numeric');
                    const customerCell = createTextCell(sale.customerName, 'cell-name');
                    const itemsCell = buildOrderItemsCell(sale.items, 'unitPriceCents');

                    const statusCell = doc.createElement('td');
                    const badgeInfo = SALE_STATUS_BADGE[sale.status] ?? {
                        label: sale.status,
                        className: 'badge'
                    };
                    const badge = doc.createElement('span');
                    badge.className = badgeInfo.className;
                    badge.textContent = badgeInfo.label;
                    statusCell.appendChild(badge);

                    const totalCell = createTextCell(
                        formatCurrencyFromCents(sale.totalCents),
                        'cell-numeric cell-subtotal'
                    );
                    const userCell = createTextCell(sale.actorUsername || 'sistema', 'cell-muted');

                    const actionsCell = doc.createElement('td');
                    if (sale.status === SALE_STATUS.CONFIRMED && permissions.canCancelSales) {
                        const cancelBtn = doc.createElement('button');
                        cancelBtn.type = 'button';
                        cancelBtn.className = 'action-btn action-delete';
                        cancelBtn.dataset.action = 'cancel-sale';
                        cancelBtn.dataset.id = sale.id;
                        cancelBtn.textContent = 'Anular';
                        cancelBtn.setAttribute('aria-label', `Anular venta ${sale.saleNumber}`);
                        actionsCell.appendChild(cancelBtn);
                    } else {
                        const dash = doc.createElement('span');
                        dash.className = 'cell-muted';
                        dash.textContent = '—';
                        actionsCell.appendChild(dash);
                    }

                    row.append(
                        numCell,
                        dateCell,
                        customerCell,
                        itemsCell,
                        statusCell,
                        totalCell,
                        userCell,
                        actionsCell
                    );
                    fragment.appendChild(row);
                }
            }

            elements.salesTableBody.replaceChildren(fragment);
        },

        showSupplierError(message, field = null) {
            for (const input of Object.values(supplierInputs)) input.removeAttribute('aria-invalid');
            elements.supplierErrorMsg.textContent = message;
            if (field && supplierInputs[field]) {
                supplierInputs[field].setAttribute('aria-invalid', 'true');
                supplierInputs[field].focus();
            }
        },
        clearSupplierFeedback() {
            elements.supplierErrorMsg.textContent = '';
            elements.supplierStatusMsg.textContent = '';
            for (const input of Object.values(supplierInputs)) input.removeAttribute('aria-invalid');
        },
        showSupplierStatus(message) {
            elements.supplierStatusMsg.textContent = message;
        },

        showPurchaseError(message) {
            elements.purchaseErrorMsg.textContent = message;
        },
        clearPurchaseFeedback() {
            elements.purchaseErrorMsg.textContent = '';
            elements.purchaseStatusMsg.textContent = '';
        },
        showPurchaseStatus(message) {
            elements.purchaseStatusMsg.textContent = message;
        },

        showCustomerError(message, field = null) {
            for (const input of Object.values(customerInputs)) input.removeAttribute('aria-invalid');
            elements.customerErrorMsg.textContent = message;
            if (field && customerInputs[field]) {
                customerInputs[field].setAttribute('aria-invalid', 'true');
                customerInputs[field].focus();
            }
        },
        clearCustomerFeedback() {
            elements.customerErrorMsg.textContent = '';
            elements.customerStatusMsg.textContent = '';
            for (const input of Object.values(customerInputs)) input.removeAttribute('aria-invalid');
        },
        showCustomerStatus(message) {
            elements.customerStatusMsg.textContent = message;
        },

        showSaleError(message) {
            elements.saleErrorMsg.textContent = message;
        },
        clearSaleFeedback() {
            elements.saleErrorMsg.textContent = '';
            elements.saleStatusMsg.textContent = '';
        },
        showSaleStatus(message) {
            elements.saleStatusMsg.textContent = message;
        }
    };
}

