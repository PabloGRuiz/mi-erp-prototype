import { centsToInputValue } from './money.js';
import { calculateProductSubtotalCents, getStockStatus } from './product.js';

const FORMULA_INJECTION_PATTERN = /^[=+\-@\t\r]/;
const CSV_QUOTE_PATTERN = /[",\r\n]/;

const STOCK_STATUS_LABELS = {
    ok: 'Normal',
    low: 'Stock bajo',
    out: 'Sin stock'
};

const MOVEMENT_TYPE_LABELS = {
    IN: 'Entrada',
    OUT: 'Salida',
    ADJUSTMENT: 'Ajuste'
};

/**
 * Escapes a single CSV cell per RFC 4180 while neutralizing spreadsheet formula injection.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
    const raw = value === null || value === undefined ? '' : String(value);
    const safe = FORMULA_INJECTION_PATTERN.test(raw) ? `'${raw}` : raw;

    if (CSV_QUOTE_PATTERN.test(safe)) {
        return `"${safe.replaceAll('"', '""')}"`;
    }

    return safe;
}

function buildCsvDocument(headers, rows) {
    const serializeRow = (cells) => cells.map(escapeCsvCell).join(',');
    const lines = [serializeRow(headers), ...rows.map(serializeRow)];
    return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * Serializes an inventory product list to UTF-8 BOM CSV.
 * @param {Array<Record<string, any>>} products
 * @returns {string}
 */
export function exportProductsToCsv(products) {
    const headers = [
        'SKU',
        'Producto',
        'Categoría',
        'Precio (ARS)',
        'Stock',
        'Stock Mínimo',
        'Estado',
        'Valor Total (ARS)'
    ];

    const rows = products.map((product) => [
        product.sku,
        product.name,
        product.category,
        centsToInputValue(product.priceCents),
        product.stock,
        product.minStock,
        STOCK_STATUS_LABELS[getStockStatus(product)] ?? '',
        centsToInputValue(calculateProductSubtotalCents(product))
    ]);

    return buildCsvDocument(headers, rows);
}

/**
 * Serializes a Kardex stock movement list to UTF-8 BOM CSV.
 * @param {Array<Record<string, any>>} movements
 * @returns {string}
 */
export function exportMovementsToCsv(movements) {
    const headers = [
        'Fecha',
        'SKU',
        'Producto',
        'Tipo',
        'Variación',
        'Stock Anterior',
        'Stock Resultante',
        'Motivo',
        'Referencia',
        'Usuario'
    ];

    const rows = movements.map((movement) => [
        movement.createdAt,
        movement.productSku,
        movement.productName,
        MOVEMENT_TYPE_LABELS[movement.type] ?? movement.type,
        movement.delta > 0 ? `+${movement.delta}` : String(movement.delta),
        movement.previousStock,
        movement.resultingStock,
        movement.reason,
        movement.reference ?? '',
        movement.actorUsername || 'sistema'
    ]);

    return buildCsvDocument(headers, rows);
}

