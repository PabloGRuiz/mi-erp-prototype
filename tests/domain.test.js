import test from 'node:test';
import assert from 'node:assert/strict';

import {
    centsToInputValue,
    formatCurrencyFromCents,
    parsePriceToCents
} from '../src/domain/money.js';
import {
    calculateInventoryMetrics,
    createProduct,
    filterAndSortProducts,
    getStockStatus,
    validateProductInput
} from '../src/domain/product.js';
import {
    createLocalStorageProductRepository,
    STORAGE_KEY
} from '../src/repositories/localStorageProductRepository.js';

function createMemoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        }
    };
}

test('money: parses decimal prices strictly into integer cents without IEEE 754 drift', () => {
    const a = parsePriceToCents('0.1');
    const b = parsePriceToCents('0.2');
    assert.equal(a, 10);
    assert.equal(b, 20);
    assert.equal(a + b, 30);

    const unit = parsePriceToCents('19.99');
    assert.equal(unit, 1999);
    assert.equal(unit * 3, 5997);

    assert.equal(parsePriceToCents('0'), 0);
    assert.equal(parsePriceToCents(' 1250.5 '), 125050);
    assert.equal(centsToInputValue(1999), '19.99');
    assert.match(formatCurrencyFromCents(1999), /19,99/);
});

test('money: rejects empty, negative, malformed, or excessive-decimal prices', () => {
    assert.equal(parsePriceToCents(''), null);
    assert.equal(parsePriceToCents('   '), null);
    assert.equal(parsePriceToCents('-10'), null);
    assert.equal(parsePriceToCents('10.123'), null);
    assert.equal(parsePriceToCents('abc'), null);
    assert.equal(parsePriceToCents(Infinity), null);
    assert.equal(parsePriceToCents(NaN), null);
});

test('product: validates SKU uniqueness, required fields, category defaults, and integers', () => {
    const existing = [
        createProduct(
            {
                sku: 'TEC-001',
                name: 'Teclado Mecánico',
                category: 'Periféricos',
                priceCents: 4500000,
                stock: 10,
                minStock: 3
            },
            { id: 'prod-1', now: '2026-11-19T10:00:00.000Z' }
        )
    ];

    const duplicate = validateProductInput(
        {
            sku: ' tec-001 ',
            name: 'Otro teclado',
            category: '',
            price: '100',
            stock: '2',
            minStock: '1'
        },
        existing
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.field, 'sku');

    const editingSameSku = validateProductInput(
        {
            sku: 'tec-001',
            name: 'Teclado Pro',
            category: '',
            price: '48000.50',
            stock: '12',
            minStock: ''
        },
        existing,
        'prod-1'
    );
    assert.equal(editingSameSku.ok, true);
    assert.deepEqual(editingSameSku.data, {
        sku: 'TEC-001',
        name: 'Teclado Pro',
        category: 'General',
        priceCents: 4800050,
        stock: 12,
        minStock: 0
    });

    const invalidStock = validateProductInput(
        { sku: 'MOU-001', name: 'Mouse', price: '10', stock: '2.5', minStock: '1' },
        existing
    );
    assert.equal(invalidStock.ok, false);
    assert.equal(invalidStock.field, 'stock');
});

test('product: computes stock status, aggregated metrics, and immutable filters/sorts', () => {
    const products = [
        createProduct(
            { sku: 'A-1', name: 'Teclado', category: 'Periféricos', priceCents: 10000, stock: 8, minStock: 5 },
            { id: '1', now: '2026-11-19T10:00:00.000Z' }
        ),
        createProduct(
            { sku: 'B-2', name: 'Mouse', category: 'Periféricos', priceCents: 5000, stock: 3, minStock: 5 },
            { id: '2', now: '2026-11-19T11:00:00.000Z' }
        ),
        createProduct(
            { sku: 'C-3', name: 'Cable HDMI', category: 'Insumos', priceCents: 2000, stock: 0, minStock: 2 },
            { id: '3', now: '2026-11-19T12:00:00.000Z' }
        )
    ];

    assert.equal(getStockStatus(products[0]), 'ok');
    assert.equal(getStockStatus(products[1]), 'low');
    assert.equal(getStockStatus(products[2]), 'out');

    assert.deepEqual(calculateInventoryMetrics(products), {
        totalProducts: 3,
        totalUnits: 11,
        lowStockCount: 2,
        outOfStockCount: 1,
        totalValueCents: 8 * 10000 + 3 * 5000 + 0 * 2000
    });

    const snapshot = products.map((p) => p.id);
    const lowFiltered = filterAndSortProducts(products, {
        query: '',
        category: 'all',
        stockFilter: 'low',
        sortBy: 'price-asc'
    });

    assert.deepEqual(
        lowFiltered.map((p) => p.sku),
        ['C-3', 'B-2']
    );
    assert.deepEqual(
        products.map((p) => p.id),
        snapshot
    );

    const searchBySku = filterAndSortProducts(products, { query: 'b-2' });
    assert.equal(searchBySku.length, 1);
    assert.equal(searchBySku[0].name, 'Mouse');
});

test('repository: supports async CRUD, defensive cloning, and corrupted JSON recovery', async () => {
    const storage = createMemoryStorage({ [STORAGE_KEY]: '{broken-json' });
    const repo = createLocalStorageProductRepository(storage);

    assert.deepEqual(await repo.getAll(), []);

    const created = createProduct(
        { sku: 'MON-01', name: 'Monitor 24"', category: 'Hardware', priceCents: 25000000, stock: 4, minStock: 2 },
        { id: 'id-1', now: '2026-11-19T10:00:00.000Z' }
    );

    const saved = await repo.create(created);
    saved.name = 'Mutated Outside';

    const fetched = await repo.getById('id-1');
    assert.equal(fetched?.name, 'Monitor 24"');

    const updated = await repo.update('id-1', { stock: 6 });
    assert.equal(updated.stock, 6);
    assert.equal(updated.id, 'id-1');

    assert.equal(await repo.remove('id-1'), true);
    assert.equal(await repo.remove('id-1'), false);
    assert.deepEqual(await repo.getAll(), []);
});

