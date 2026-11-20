import { parsePriceToCents } from './money.js';
import { parseNonNegativeInteger } from './product.js';

export const PURCHASE_STATUS = Object.freeze({
    DRAFT: 'DRAFT',
    RECEIVED: 'RECEIVED',
    CANCELLED: 'CANCELLED'
});

export const SALE_STATUS = Object.freeze({
    CONFIRMED: 'CONFIRMED',
    CANCELLED: 'CANCELLED'
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 120;
const MAX_TAX_ID_LENGTH = 30;
const MAX_EMAIL_LENGTH = 120;
const MAX_PHONE_LENGTH = 40;
const MAX_NOTES_LENGTH = 300;
const MAX_ORDER_ITEMS = 100;

function lookupProduct(productsById, productId) {
    if (!productsById || !productId) {
        return null;
    }
    if (productsById instanceof Map) {
        return productsById.get(productId) ?? null;
    }
    return productsById[productId] ?? null;
}

/**
 * Validates supplier or customer contact metadata.
 * @param {Record<string, unknown>} rawInput
 * @param {string} [label='Proveedor']
 */
export function validatePartyInput(rawInput, label = 'Proveedor') {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: `Los datos del ${label.toLowerCase()} son inválidos.`, field: 'name' };
    }

    const name = typeof rawInput.name === 'string' ? rawInput.name.trim() : '';
    if (!name) {
        return { ok: false, error: `El nombre del ${label.toLowerCase()} es obligatorio.`, field: 'name' };
    }
    if (name.length > MAX_NAME_LENGTH) {
        return {
            ok: false,
            error: `El nombre del ${label.toLowerCase()} no puede superar los ${MAX_NAME_LENGTH} caracteres.`,
            field: 'name'
        };
    }

    const taxId = typeof rawInput.taxId === 'string' ? rawInput.taxId.trim().toUpperCase() : '';
    if (taxId.length > MAX_TAX_ID_LENGTH) {
        return {
            ok: false,
            error: `El CUIT / DNI no puede superar los ${MAX_TAX_ID_LENGTH} caracteres.`,
            field: 'taxId'
        };
    }

    const email = typeof rawInput.email === 'string' ? rawInput.email.trim() : '';
    if (email.length > MAX_EMAIL_LENGTH) {
        return {
            ok: false,
            error: `El correo no puede superar los ${MAX_EMAIL_LENGTH} caracteres.`,
            field: 'email'
        };
    }
    if (email && !EMAIL_PATTERN.test(email)) {
        return {
            ok: false,
            error: 'El formato del correo electrónico no es válido.',
            field: 'email'
        };
    }

    const phone = typeof rawInput.phone === 'string' ? rawInput.phone.trim() : '';
    if (phone.length > MAX_PHONE_LENGTH) {
        return {
            ok: false,
            error: `El teléfono no puede superar los ${MAX_PHONE_LENGTH} caracteres.`,
            field: 'phone'
        };
    }

    const notes = typeof rawInput.notes === 'string' ? rawInput.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) {
        return {
            ok: false,
            error: `Las notas no pueden superar los ${MAX_NOTES_LENGTH} caracteres.`,
            field: 'notes'
        };
    }

    return {
        ok: true,
        data: { name, taxId, email, phone, notes }
    };
}

/**
 * Validates a multi-item purchase order before persisting.
 * @param {Record<string, unknown>} rawInput
 * @param {Map<string, any> | Record<string, any>} productsById
 */
export function validatePurchaseOrderInput(rawInput, productsById) {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: 'Los datos de la orden de compra son inválidos.', field: 'supplierId' };
    }

    const supplierId = typeof rawInput.supplierId === 'string' ? rawInput.supplierId.trim() : '';
    if (!supplierId) {
        return { ok: false, error: 'Seleccioná un proveedor válido.', field: 'supplierId' };
    }

    const receiveNow = rawInput.receiveNow === undefined ? true : Boolean(rawInput.receiveNow);
    const notes = typeof rawInput.notes === 'string' ? rawInput.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) {
        return {
            ok: false,
            error: `Las observaciones no pueden superar los ${MAX_NOTES_LENGTH} caracteres.`,
            field: 'notes'
        };
    }

    if (!Array.isArray(rawInput.items) || rawInput.items.length === 0) {
        return {
            ok: false,
            error: 'Agregá al menos un producto a la orden de compra.',
            field: 'items'
        };
    }

    if (rawInput.items.length > MAX_ORDER_ITEMS) {
        return {
            ok: false,
            error: `Una orden no puede superar los ${MAX_ORDER_ITEMS} ítems.`,
            field: 'items'
        };
    }

    const normalizedItems = [];
    let totalCents = 0;

    for (let i = 0; i < rawInput.items.length; i += 1) {
        const line = rawInput.items[i];
        const productId = typeof line?.productId === 'string' ? line.productId.trim() : '';
        const product = lookupProduct(productsById, productId);

        if (!product) {
            return {
                ok: false,
                error: `El producto de la línea ${i + 1} no existe en el catálogo.`,
                field: 'items'
            };
        }

        const quantity = parseNonNegativeInteger(line.quantity);
        if (quantity === null || quantity < 1) {
            return {
                ok: false,
                error: `La cantidad de "${product.name}" debe ser un entero mayor o igual a 1.`,
                field: 'items'
            };
        }

        const unitCostCents =
            line.unitCostCents !== undefined &&
            Number.isSafeInteger(line.unitCostCents) &&
            line.unitCostCents >= 0
                ? line.unitCostCents
                : parsePriceToCents(line.unitCost);

        if (unitCostCents === null) {
            return {
                ok: false,
                error: `El costo unitario de "${product.name}" debe ser un monto válido mayor o igual a 0.`,
                field: 'items'
            };
        }

        const subtotalCents = unitCostCents * quantity;
        if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents + subtotalCents)) {
            return {
                ok: false,
                error: 'El monto total de la compra excede el límite numérico seguro.',
                field: 'items'
            };
        }

        totalCents += subtotalCents;
        normalizedItems.push({
            productId: product.id,
            productSku: product.sku,
            productName: product.name,
            quantity,
            unitCostCents,
            subtotalCents
        });
    }

    return {
        ok: true,
        data: {
            supplierId,
            receiveNow,
            notes,
            items: normalizedItems,
            totalCents
        }
    };
}

/**
 * Validates a multi-item sales order, aggregating requested quantities per SKU to prevent overselling.
 * Prices each line from the authoritative catalog unit price snapshot.
 * @param {Record<string, unknown>} rawInput
 * @param {Map<string, any> | Record<string, any>} productsById
 */
export function validateSaleOrderInput(rawInput, productsById) {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: 'Los datos de la venta son inválidos.', field: 'items' };
    }

    const rawCustomerId = typeof rawInput.customerId === 'string' ? rawInput.customerId.trim() : '';
    const customerId = rawCustomerId || null;

    const notes = typeof rawInput.notes === 'string' ? rawInput.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) {
        return {
            ok: false,
            error: `Las observaciones no pueden superar los ${MAX_NOTES_LENGTH} caracteres.`,
            field: 'notes'
        };
    }

    if (!Array.isArray(rawInput.items) || rawInput.items.length === 0) {
        return {
            ok: false,
            error: 'Agregá al menos un producto a la venta.',
            field: 'items'
        };
    }

    if (rawInput.items.length > MAX_ORDER_ITEMS) {
        return {
            ok: false,
            error: `Una venta no puede superar los ${MAX_ORDER_ITEMS} ítems.`,
            field: 'items'
        };
    }

    const normalizedItems = [];
    const requestedByProduct = new Map();
    let totalCents = 0;

    for (let i = 0; i < rawInput.items.length; i += 1) {
        const line = rawInput.items[i];
        const productId = typeof line?.productId === 'string' ? line.productId.trim() : '';
        const product = lookupProduct(productsById, productId);

        if (!product) {
            return {
                ok: false,
                error: `El producto de la línea ${i + 1} no existe en el catálogo.`,
                field: 'items'
            };
        }

        const quantity = parseNonNegativeInteger(line.quantity);
        if (quantity === null || quantity < 1) {
            return {
                ok: false,
                error: `La cantidad de "${product.name}" debe ser un entero mayor o igual a 1.`,
                field: 'items'
            };
        }

        const accumulatedQty = (requestedByProduct.get(product.id) ?? 0) + quantity;
        if (accumulatedQty > product.stock) {
            return {
                ok: false,
                error: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, solicitado: ${accumulatedQty}.`,
                field: 'items',
                code: 'INSUFFICIENT_STOCK'
            };
        }
        requestedByProduct.set(product.id, accumulatedQty);

        const unitPriceCents = product.priceCents;
        const subtotalCents = unitPriceCents * quantity;
        if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents + subtotalCents)) {
            return {
                ok: false,
                error: 'El monto total de la venta excede el límite numérico seguro.',
                field: 'items'
            };
        }

        totalCents += subtotalCents;
        normalizedItems.push({
            productId: product.id,
            productSku: product.sku,
            productName: product.name,
            quantity,
            unitPriceCents,
            subtotalCents
        });
    }

    return {
        ok: true,
        data: {
            customerId,
            notes,
            items: normalizedItems,
            totalCents
        }
    };
}

/**
 * Aggregates KPIs across purchase and sales orders.
 * @param {Array<{ status: string, totalCents: number }>} purchases
 * @param {Array<{ status: string, totalCents: number }>} sales
 */
export function calculateOperationsSummary(purchases, sales) {
    const summary = {
        receivedPurchasesCount: 0,
        draftPurchasesCount: 0,
        receivedPurchasesTotalCents: 0,
        confirmedSalesCount: 0,
        cancelledSalesCount: 0,
        confirmedSalesTotalCents: 0
    };

    for (const purchase of purchases) {
        if (purchase.status === PURCHASE_STATUS.RECEIVED) {
            summary.receivedPurchasesCount += 1;
            summary.receivedPurchasesTotalCents += purchase.totalCents;
        } else if (purchase.status === PURCHASE_STATUS.DRAFT) {
            summary.draftPurchasesCount += 1;
        }
    }

    for (const sale of sales) {
        if (sale.status === SALE_STATUS.CONFIRMED) {
            summary.confirmedSalesCount += 1;
            summary.confirmedSalesTotalCents += sale.totalCents;
        } else if (sale.status === SALE_STATUS.CANCELLED) {
            summary.cancelledSalesCount += 1;
        }
    }

    return summary;
}

