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
    calculateMovementSummary,
    MOVEMENT_TYPES,
    validateMovementInput
} from '../src/domain/movement.js';
import {
    canPerform,
    ROLES,
    validateLoginInput,
    validateUserCreateInput
} from '../src/domain/auth.js';
import {
    calculateOperationsSummary,
    PURCHASE_STATUS,
    SALE_STATUS,
    validatePartyInput,
    validatePurchaseOrderInput,
    validateSaleOrderInput
} from '../src/domain/operations.js';
import {
    calculateIntakeQueueStats,
    INTAKE_STATUS,
    reconcileExtractedDocument,
    validateIntakeReviewPayload
} from '../src/domain/intake.js';
import { exportMovementsToCsv, exportProductsToCsv, escapeCsvCell } from '../src/domain/csv.js';
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


test('movement: validates IN, OUT, INSUFFICIENT_STOCK, ADJUSTMENT, and aggregates summary', () => {
    const product = createProduct(
        { sku: 'MOU-01', name: 'Mouse Óptico', category: 'Periféricos', priceCents: 150000, stock: 10, minStock: 3 },
        { id: 'p-1', now: '2026-11-19T10:00:00.000Z' }
    );

    const validIn = validateMovementInput(
        { type: 'in', quantity: '4', reason: ' Compra ', reference: ' FC-10 ' },
        product
    );
    assert.equal(validIn.ok, true);
    assert.deepEqual(validIn.data, {
        productId: 'p-1',
        type: MOVEMENT_TYPES.IN,
        quantity: 4,
        delta: 4,
        previousStock: 10,
        resultingStock: 14,
        reason: 'Compra',
        reference: 'FC-10'
    });

    const insufficient = validateMovementInput(
        { type: 'OUT', quantity: '11', reason: 'Venta grande' },
        product
    );
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.code, 'INSUFFICIENT_STOCK');
    assert.equal(insufficient.field, 'quantity');

    const adjustment = validateMovementInput(
        { type: 'ADJUSTMENT', targetStock: '6', reason: 'Conteo físico' },
        product
    );
    assert.equal(adjustment.ok, true);
    assert.equal(adjustment.data.delta, -4);
    assert.equal(adjustment.data.quantity, 4);
    assert.equal(adjustment.data.resultingStock, 6);

    const noChange = validateMovementInput(
        { type: 'ADJUSTMENT', targetStock: '10', reason: 'Conteo igual' },
        product
    );
    assert.equal(noChange.ok, false);
    assert.equal(noChange.code, 'NO_CHANGE');

    assert.deepEqual(
        calculateMovementSummary([{ delta: 10 }, { delta: 4 }, { delta: -3 }, { delta: -2 }]),
        {
            totalMovements: 4,
            totalInUnits: 14,
            totalOutUnits: 5,
            netUnits: 9
        }
    );
});

test('csv: neutralizes spreadsheet formula injection and formats RFC 4180 rows with BOM', () => {
    assert.equal(escapeCsvCell('=A1+B1'), '\'=A1+B1');
    assert.equal(escapeCsvCell('=SUM(1,2)'), '"\'=SUM(1,2)"');
    assert.equal(escapeCsvCell('=CMD("calc")'), '"\'=CMD(""calc"")"');
    assert.equal(escapeCsvCell('+1+1'), '\'+1+1');
    assert.equal(escapeCsvCell('-1+1'), '\'-1+1');
    assert.equal(escapeCsvCell('@SUM(A1)'), '\'@SUM(A1)');
    assert.equal(escapeCsvCell('Monitor "Pro", 24"'), '"Monitor ""Pro"", 24"""');

    const productsCsv = exportProductsToCsv([
        createProduct(
            {
                sku: 'SEC-01',
                name: '=HYPERLINK("http://evil.example","Click")',
                category: 'Test, "CSV"',
                priceCents: 1999,
                stock: 2,
                minStock: 1
            },
            { id: 'csv-1', now: '2026-11-19T10:00:00.000Z' }
        )
    ]);

    assert.ok(productsCsv.startsWith('\uFEFFSKU,Producto,'));
    assert.ok(productsCsv.includes('"\'=HYPERLINK(""http://evil.example"",""Click"")"'));
    assert.ok(productsCsv.includes('"Test, ""CSV"""'));

    const movementsCsv = exportMovementsToCsv([
        {
            createdAt: '2026-11-19T12:00:00.000Z',
            productSku: 'SEC-01',
            productName: 'Producto X',
            type: 'OUT',
            delta: -2,
            previousStock: 5,
            resultingStock: 3,
            reason: '+SUM(1,2)',
            reference: 'REF-1'
        }
    ]);

    assert.ok(movementsCsv.startsWith('\uFEFFFecha,SKU,Producto,Tipo,Variación,'));
    assert.ok(movementsCsv.includes('\'-2'));
    assert.ok(movementsCsv.includes('"\'+SUM(1,2)"'));
});

test('auth domain: enforces RBAC permission matrix and validates user/login inputs', () => {
    assert.equal(canPerform(ROLES.ADMIN, 'users:manage'), true);
    assert.equal(canPerform(ROLES.ADMIN, 'sales:cancel'), true);
    assert.equal(canPerform(ROLES.OPERATOR, 'sales:write'), true);
    assert.equal(canPerform(ROLES.OPERATOR, 'sales:cancel'), false);
    assert.equal(canPerform(ROLES.OPERATOR, 'inventory:delete'), false);
    assert.equal(canPerform(ROLES.AUDITOR, 'inventory:read'), true);
    assert.equal(canPerform(ROLES.AUDITOR, 'inventory:write'), false);

    const invalidUser = validateUserCreateInput({
        username: 'A',
        fullName: 'Ok Name',
        password: 'short',
        role: 'OPERATOR'
    });
    assert.equal(invalidUser.ok, false);
    assert.equal(invalidUser.field, 'username');

    const validUser = validateUserCreateInput({
        username: ' J.Perez ',
        fullName: ' Juan Pérez ',
        password: 'Password123!',
        role: 'operator'
    });
    assert.equal(validUser.ok, true);
    assert.deepEqual(validUser.data, {
        username: 'j.perez',
        fullName: 'Juan Pérez',
        password: 'Password123!',
        role: 'OPERATOR'
    });

    const loginOk = validateLoginInput({ username: ' Admin ', password: 'secret' });
    assert.equal(loginOk.ok, true);
    assert.equal(loginOk.data.username, 'admin');
});

test('operations domain: validates parties, purchase totals, duplicate-line sale stock check, and summary', () => {
    assert.equal(validatePartyInput({ name: 'Proveedor 1', email: 'bad-email' }).ok, false);
    const partyOk = validatePartyInput({ name: 'Proveedor 1', taxId: '30-11111111-1', email: 'v@p.com' });
    assert.equal(partyOk.ok, true);

    const products = new Map([
        ['p1', { id: 'p1', sku: 'TEC-01', name: 'Teclado', priceCents: 20000, stock: 5 }],
        ['p2', { id: 'p2', sku: 'MOU-01', name: 'Mouse', priceCents: 10000, stock: 3 }]
    ]);

    const purchaseOk = validatePurchaseOrderInput(
        {
            supplierId: 'sup-1',
            receiveNow: false,
            items: [
                { productId: 'p1', quantity: '2', unitCost: '120.50' },
                { productId: 'p2', quantity: '3', unitCost: '50' }
            ]
        },
        products
    );
    assert.equal(purchaseOk.ok, true);
    assert.equal(purchaseOk.data.totalCents, 2 * 12050 + 3 * 5000);
    assert.equal(purchaseOk.data.receiveNow, false);

    // Duplicate lines summing 4 + 2 = 6 > stock 5 must fail!
    const saleOverflow = validateSaleOrderInput(
        {
            items: [
                { productId: 'p1', quantity: '4' },
                { productId: 'p1', quantity: '2' }
            ]
        },
        products
    );
    assert.equal(saleOverflow.ok, false);
    assert.equal(saleOverflow.code, 'INSUFFICIENT_STOCK');

    const saleOk = validateSaleOrderInput(
        {
            customerId: '',
            items: [{ productId: 'p2', quantity: '2' }]
        },
        products
    );
    assert.equal(saleOk.ok, true);
    assert.equal(saleOk.data.customerId, null);
    assert.equal(saleOk.data.totalCents, 20000);

    assert.deepEqual(
        calculateOperationsSummary(
            [
                { status: PURCHASE_STATUS.RECEIVED, totalCents: 1000 },
                { status: PURCHASE_STATUS.DRAFT, totalCents: 500 }
            ],
            [
                { status: SALE_STATUS.CONFIRMED, totalCents: 2500 },
                { status: SALE_STATUS.CANCELLED, totalCents: 900 }
            ]
        ),
        {
            receivedPurchasesCount: 1,
            draftPurchasesCount: 1,
            receivedPurchasesTotalCents: 1000,
            confirmedSalesCount: 1,
            cancelledSalesCount: 1,
            confirmedSalesTotalCents: 2500
        }
    );
});

test('intake domain: reconciles catalog parties/items, warns on totals, validates edits, and checks RBAC', () => {
    assert.equal(canPerform(ROLES.ADMIN, 'intake:approve'), true);
    assert.equal(canPerform(ROLES.OPERATOR, 'intake:approve'), true);
    assert.equal(canPerform(ROLES.AUDITOR, 'intake:read'), true);
    assert.equal(canPerform(ROLES.AUDITOR, 'intake:write'), false);
    assert.equal(canPerform(ROLES.AUDITOR, 'intake:approve'), false);

    const catalog = {
        products: [
            createProduct(
                { sku: 'TEC-001', name: 'Teclado Mecánico', category: 'Periféricos', priceCents: 3000000, stock: 5, minStock: 2 },
                { id: 'p-1', now: '2026-11-20T10:00:00Z' }
            )
        ],
        suppliers: [{ id: 'sup-1', name: 'TechMayorista SA', taxId: '30-71122334-9', email: '', phone: '' }],
        customers: []
    };

    const reconciled = reconcileExtractedDocument(
        {
            documentType: 'PURCHASE',
            documentNumber: 'FC-A 0001-0001',
            party: { name: 'Tech Mayorista', taxId: '30711223349' },
            items: [
                { sku: 'tec-001', name: 'Teclado', quantity: 2, unitPrice: 15000 },
                { sku: 'NEW-99', name: 'Cable USB-C', quantity: 3, unitPrice: 2000 }
            ],
            declaredTotal: 50000,
            confidence: 0.65
        },
        catalog
    );

    assert.equal(reconciled.reviewPayload.partyId, 'sup-1');
    assert.equal(reconciled.reviewPayload.createParty, false);
    assert.equal(reconciled.reviewPayload.items[0].productId, 'p-1');
    assert.equal(reconciled.reviewPayload.items[0].createProduct, false);
    assert.equal(reconciled.reviewPayload.items[1].productId, '');
    assert.equal(reconciled.reviewPayload.items[1].createProduct, true);
    assert.ok(reconciled.warnings.some((w) => w.includes('no coincide con un producto existente')));
    assert.ok(reconciled.warnings.some((w) => w.includes('difiere de la suma')));
    assert.ok(reconciled.warnings.some((w) => w.includes('Confianza de extracción baja')));

    const dupNewSku = validateIntakeReviewPayload(
        {
            ...reconciled.reviewPayload,
            items: [
                { productId: '', createProduct: true, sku: 'NEW-99', name: 'A', quantity: 1, unitCost: '10', salePrice: '20' },
                { productId: '', createProduct: true, sku: 'new-99', name: 'B', quantity: 1, unitCost: '10', salePrice: '20' }
            ]
        },
        catalog
    );
    assert.equal(dupNewSku.ok, false);
    assert.equal(dupNewSku.code, 'DUPLICATE_SKU');

    const validEdit = validateIntakeReviewPayload(reconciled.reviewPayload, catalog);
    assert.equal(validEdit.ok, true);
    assert.equal(validEdit.data.totalCents, 2 * 1500000 + 3 * 200000);

    assert.deepEqual(
        calculateIntakeQueueStats([
            { status: INTAKE_STATUS.PENDING },
            { status: INTAKE_STATUS.READY_FOR_REVIEW, duplicateOfId: 'x' },
            { status: INTAKE_STATUS.APPROVED },
            { status: INTAKE_STATUS.ERROR }
        ]),
        {
            total: 4,
            processing: 1,
            readyForReview: 1,
            approved: 1,
            rejected: 0,
            error: 1,
            duplicates: 1
        }
    );

    // Reconciles Factura A totals cleanly when taxAmount (IVA 21%) explains declaredTotal
    const facturaA = reconcileExtractedDocument(
        {
            documentType: 'PURCHASE',
            documentNumber: '0011-00045569',
            party: { name: 'TechMayorista SA', taxId: '30-71122334-9' },
            items: [{ sku: 'TEC-001', name: 'Teclado Mecánico', quantity: 2, unitPrice: 10000 }],
            taxAmount: 4200,
            declaredTotal: 24200,
            confidence: 0.98
        },
        catalog
    );
    assert.equal(facturaA.reviewPayload.taxAmountCents, 420000);
    assert.equal(facturaA.warnings.length, 0);
});
