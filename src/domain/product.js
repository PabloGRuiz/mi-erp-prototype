import { parsePriceToCents } from './money.js';

const SKU_PATTERN = /^[A-Z0-9_-]{2,32}$/;
const INTEGER_PATTERN = /^\d+$/;
const MAX_NAME_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 60;
const DEFAULT_CATEGORY = 'General';

/**
 * Normalizes a SKU code by trimming surrounding whitespace and uppercasing.
 * @param {unknown} rawSku
 * @returns {string}
 */
export function normalizeSku(rawSku) {
    return typeof rawSku === 'string' ? rawSku.trim().toUpperCase() : '';
}

/**
 * Parses a non-negative safe integer from string or number input.
 * Returns null for decimals, negatives, empty strings, or unsafe integers.
 * @param {string | number} rawValue
 * @returns {number | null}
 */
export function parseNonNegativeInteger(rawValue) {
    if (typeof rawValue === 'number') {
        return Number.isSafeInteger(rawValue) && rawValue >= 0 ? rawValue : null;
    }

    if (typeof rawValue !== 'string') {
        return null;
    }

    const trimmed = rawValue.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
        return null;
    }

    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Validates raw form/domain input against ERP product business rules.
 * @param {Record<string, unknown>} rawInput
 * @param {Array<{ id: string, sku: string }>} [existingProducts=[]]
 * @param {string | null} [editingId=null]
 */
export function validateProductInput(rawInput, existingProducts = [], editingId = null) {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: 'Los datos del producto son inválidos.', field: 'sku' };
    }

    const sku = normalizeSku(rawInput.sku);
    if (!sku) {
        return { ok: false, error: 'El SKU es obligatorio.', field: 'sku' };
    }

    if (!SKU_PATTERN.test(sku)) {
        return {
            ok: false,
            error: 'El SKU debe tener entre 2 y 32 caracteres (letras, números, guiones o guion bajo).',
            field: 'sku'
        };
    }

    const duplicateSku = existingProducts.some(
        (product) => product.id !== editingId && normalizeSku(product.sku) === sku
    );
    if (duplicateSku) {
        return {
            ok: false,
            error: `Ya existe un producto registrado con el SKU "${sku}".`,
            field: 'sku'
        };
    }

    const name = typeof rawInput.name === 'string' ? rawInput.name.trim() : '';
    if (!name) {
        return { ok: false, error: 'El nombre del producto es obligatorio.', field: 'name' };
    }

    if (name.length > MAX_NAME_LENGTH) {
        return {
            ok: false,
            error: `El nombre del producto no puede superar los ${MAX_NAME_LENGTH} caracteres.`,
            field: 'name'
        };
    }

    const rawCategory = typeof rawInput.category === 'string' ? rawInput.category.trim() : '';
    const category = rawCategory || DEFAULT_CATEGORY;
    if (category.length > MAX_CATEGORY_LENGTH) {
        return {
            ok: false,
            error: `La categoría no puede superar los ${MAX_CATEGORY_LENGTH} caracteres.`,
            field: 'category'
        };
    }

    const priceCents = parsePriceToCents(rawInput.price);
    if (priceCents === null) {
        return {
            ok: false,
            error: 'El precio debe ser un monto válido mayor o igual a 0 (hasta 2 decimales).',
            field: 'price'
        };
    }

    const stock = parseNonNegativeInteger(rawInput.stock);
    if (stock === null) {
        return {
            ok: false,
            error: 'El stock debe ser un número entero mayor o igual a 0.',
            field: 'stock'
        };
    }

    const rawMinStock = rawInput.minStock;
    const isEmptyMinStock =
        rawMinStock === undefined ||
        rawMinStock === null ||
        (typeof rawMinStock === 'string' && rawMinStock.trim() === '');
    const minStock = isEmptyMinStock ? 0 : parseNonNegativeInteger(rawMinStock);

    if (minStock === null) {
        return {
            ok: false,
            error: 'El stock mínimo debe ser un número entero mayor o igual a 0.',
            field: 'minStock'
        };
    }

    return {
        ok: true,
        data: {
            sku,
            name,
            category,
            priceCents,
            stock,
            minStock
        }
    };
}

/**
 * Instantiates a complete product entity with immutable identity and timestamps.
 * @param {{ sku: string, name: string, category: string, priceCents: number, stock: number, minStock: number }} validatedData
 * @param {{ id?: string, now?: string }} [metadata]
 */
export function createProduct(validatedData, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
    return {
        id,
        sku: validatedData.sku,
        name: validatedData.name,
        category: validatedData.category,
        priceCents: validatedData.priceCents,
        stock: validatedData.stock,
        minStock: validatedData.minStock,
        createdAt: now,
        updatedAt: now
    };
}

/**
 * Computes the operational stock status for a product.
 * @param {{ stock: number, minStock: number }} product
 * @returns {'out' | 'low' | 'ok'}
 */
export function getStockStatus(product) {
    if (product.stock === 0) {
        return 'out';
    }
    if (product.stock <= product.minStock) {
        return 'low';
    }
    return 'ok';
}

/**
 * Returns true if the product requires replenishment attention (low or out of stock).
 * @param {{ stock: number, minStock: number }} product
 * @returns {boolean}
 */
export function isLowStock(product) {
    return getStockStatus(product) !== 'ok';
}

/**
 * Computes the total inventory valuation in cents for a single product.
 * @param {{ priceCents: number, stock: number }} product
 * @returns {number}
 */
export function calculateProductSubtotalCents(product) {
    return product.priceCents * product.stock;
}

/**
 * Aggregates executive KPI metrics across an array of products in a single pass.
 * @param {Array<{ priceCents: number, stock: number, minStock: number }>} products
 */
export function calculateInventoryMetrics(products) {
    return products.reduce(
        (metrics, product) => {
            metrics.totalProducts += 1;
            metrics.totalUnits += product.stock;
            if (isLowStock(product)) {
                metrics.lowStockCount += 1;
            }
            if (product.stock === 0) {
                metrics.outOfStockCount += 1;
            }
            metrics.totalValueCents += calculateProductSubtotalCents(product);
            return metrics;
        },
        {
            totalProducts: 0,
            totalUnits: 0,
            lowStockCount: 0,
            outOfStockCount: 0,
            totalValueCents: 0
        }
    );
}

/**
 * Extracts and sorts unique product categories in Spanish alphabetical order.
 * @param {Array<{ category: string }>} products
 * @returns {string[]}
 */
export function getUniqueCategories(products) {
    const categories = new Set();
    for (const product of products) {
        if (product.category) {
            categories.add(product.category);
        }
    }
    return [...categories].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

const SORT_COMPARATORS = {
    'createdAt-desc': (a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0),
    'name-asc': (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    'price-asc': (a, b) => a.priceCents - b.priceCents,
    'price-desc': (a, b) => b.priceCents - a.priceCents,
    'stock-asc': (a, b) => a.stock - b.stock,
    'stock-desc': (a, b) => b.stock - a.stock,
    'value-desc': (a, b) => calculateProductSubtotalCents(b) - calculateProductSubtotalCents(a)
};

/**
 * Returns a new filtered and sorted array of products without mutating the source list.
 * @param {Array<Record<string, any>>} products
 * @param {{ query?: string, category?: string, stockFilter?: string, sortBy?: string }} [options]
 */
export function filterAndSortProducts(
    products,
    { query = '', category = 'all', stockFilter = 'all', sortBy = 'createdAt-desc' } = {}
) {
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = products.filter((product) => {
        if (normalizedQuery) {
            const matchesQuery =
                product.sku.toLowerCase().includes(normalizedQuery) ||
                product.name.toLowerCase().includes(normalizedQuery) ||
                product.category.toLowerCase().includes(normalizedQuery);
            if (!matchesQuery) {
                return false;
            }
        }

        if (category !== 'all' && product.category !== category) {
            return false;
        }

        if (stockFilter === 'low') {
            return isLowStock(product);
        }
        if (stockFilter === 'out') {
            return getStockStatus(product) === 'out';
        }
        if (stockFilter === 'ok') {
            return getStockStatus(product) === 'ok';
        }

        return true;
    });

    const comparator = SORT_COMPARATORS[sortBy] ?? SORT_COMPARATORS['createdAt-desc'];
    return [...filtered].sort(comparator);
}

