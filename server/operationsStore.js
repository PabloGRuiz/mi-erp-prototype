import crypto from 'node:crypto';
import { MOVEMENT_TYPES } from '../src/domain/movement.js';
import {
    PURCHASE_STATUS,
    SALE_STATUS,
    validatePartyInput,
    validatePurchaseOrderInput,
    validateSaleOrderInput
} from '../src/domain/operations.js';
import { runInTransaction } from './db.js';
import { DomainError } from './inventoryStore.js';

const SYSTEM_ACTOR = Object.freeze({ id: null, username: 'sistema' });

function normalizeActor(actor) {
    if (!actor || typeof actor !== 'object') {
        return SYSTEM_ACTOR;
    }
    return {
        id: typeof actor.id === 'string' && actor.id ? actor.id : null,
        username: typeof actor.username === 'string' && actor.username ? actor.username : 'sistema'
    };
}

function mapPartyRow(row) {
    return {
        id: row.id,
        name: row.name,
        taxId: row.tax_id,
        email: row.email,
        phone: row.phone,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapPurchaseItemRow(row) {
    return {
        id: row.id,
        purchaseId: row.purchase_id,
        productId: row.product_id,
        productSku: row.product_sku,
        productName: row.product_name,
        quantity: row.quantity,
        unitCostCents: row.unit_cost_cents,
        subtotalCents: row.subtotal_cents
    };
}

function mapPurchaseOrderRow(row, items = []) {
    return {
        id: row.id,
        orderNumber: row.order_number,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        status: row.status,
        totalCents: row.total_cents,
        notes: row.notes,
        userId: row.user_id,
        actorUsername: row.actor_username,
        createdAt: row.created_at,
        receivedAt: row.received_at,
        updatedAt: row.updated_at,
        items
    };
}

function mapSaleItemRow(row) {
    return {
        id: row.id,
        saleId: row.sale_id,
        productId: row.product_id,
        productSku: row.product_sku,
        productName: row.product_name,
        quantity: row.quantity,
        unitPriceCents: row.unit_price_cents,
        subtotalCents: row.subtotal_cents
    };
}

function mapSaleOrderRow(row, items = []) {
    return {
        id: row.id,
        saleNumber: row.sale_number,
        customerId: row.customer_id,
        customerName: row.customer_name,
        status: row.status,
        totalCents: row.total_cents,
        notes: row.notes,
        userId: row.user_id,
        actorUsername: row.actor_username,
        createdAt: row.created_at,
        cancelledAt: row.cancelled_at,
        updatedAt: row.updated_at,
        items
    };
}

/**
 * SQLite ACID store for Suppliers, Customers, Multi-Item Purchase Orders, and Sales Orders
 * connected directly to `products` and `stock_movements`.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createOperationsStore(db) {
    const selectAllSuppliersStmt = db.prepare('SELECT * FROM suppliers ORDER BY name ASC, rowid ASC');
    const selectSupplierByIdStmt = db.prepare('SELECT * FROM suppliers WHERE id = ?');
    const insertSupplierStmt = db.prepare(
        `INSERT INTO suppliers (id, name, tax_id, email, phone, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateSupplierStmt = db.prepare(
        `UPDATE suppliers
         SET name = ?, tax_id = ?, email = ?, phone = ?, notes = ?, updated_at = ?
         WHERE id = ?`
    );

    const selectAllCustomersStmt = db.prepare('SELECT * FROM customers ORDER BY name ASC, rowid ASC');
    const selectCustomerByIdStmt = db.prepare('SELECT * FROM customers WHERE id = ?');
    const insertCustomerStmt = db.prepare(
        `INSERT INTO customers (id, name, tax_id, email, phone, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateCustomerStmt = db.prepare(
        `UPDATE customers
         SET name = ?, tax_id = ?, email = ?, phone = ?, notes = ?, updated_at = ?
         WHERE id = ?`
    );

    const ensureSequenceStmt = db.prepare(
        'INSERT OR IGNORE INTO sequences (name, last_value) VALUES (?, 0)'
    );
    const incrementSequenceStmt = db.prepare(
        'UPDATE sequences SET last_value = last_value + 1 WHERE name = ?'
    );
    const selectSequenceStmt = db.prepare('SELECT last_value FROM sequences WHERE name = ?');

    const selectAllProductsStmt = db.prepare('SELECT * FROM products');
    const selectProductByIdStmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProductStockStmt = db.prepare(
        'UPDATE products SET stock = ?, updated_at = ? WHERE id = ?'
    );
    const insertMovementStmt = db.prepare(
        `INSERT INTO stock_movements (
            id, product_id, product_sku, product_name, type, quantity, delta,
            previous_stock, resulting_stock, reason, reference, unit_price_cents,
            user_id, actor_username, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const selectAllPurchasesStmt = db.prepare(
        'SELECT * FROM purchase_orders ORDER BY created_at DESC, rowid DESC'
    );
    const selectPurchaseByIdStmt = db.prepare('SELECT * FROM purchase_orders WHERE id = ?');
    const selectAllPurchaseItemsStmt = db.prepare('SELECT * FROM purchase_items ORDER BY rowid ASC');
    const selectPurchaseItemsByPurchaseIdStmt = db.prepare(
        'SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY rowid ASC'
    );
    const insertPurchaseStmt = db.prepare(
        `INSERT INTO purchase_orders (
            id, order_number, supplier_id, supplier_name, status, total_cents,
            notes, user_id, actor_username, created_at, received_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPurchaseItemStmt = db.prepare(
        `INSERT INTO purchase_items (
            id, purchase_id, product_id, product_sku, product_name,
            quantity, unit_cost_cents, subtotal_cents
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markPurchaseReceivedStmt = db.prepare(
        `UPDATE purchase_orders
         SET status = 'RECEIVED', received_at = ?, updated_at = ?
         WHERE id = ?`
    );
    const markPurchaseCancelledStmt = db.prepare(
        `UPDATE purchase_orders
         SET status = 'CANCELLED', updated_at = ?
         WHERE id = ?`
    );

    const selectAllSalesStmt = db.prepare(
        'SELECT * FROM sales_orders ORDER BY created_at DESC, rowid DESC'
    );
    const selectSaleByIdStmt = db.prepare('SELECT * FROM sales_orders WHERE id = ?');
    const selectAllSaleItemsStmt = db.prepare('SELECT * FROM sales_items ORDER BY rowid ASC');
    const selectSaleItemsBySaleIdStmt = db.prepare(
        'SELECT * FROM sales_items WHERE sale_id = ? ORDER BY rowid ASC'
    );
    const insertSaleStmt = db.prepare(
        `INSERT INTO sales_orders (
            id, sale_number, customer_id, customer_name, status, total_cents,
            notes, user_id, actor_username, created_at, cancelled_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSaleItemStmt = db.prepare(
        `INSERT INTO sales_items (
            id, sale_id, product_id, product_sku, product_name,
            quantity, unit_price_cents, subtotal_cents
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markSaleCancelledStmt = db.prepare(
        `UPDATE sales_orders
         SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
         WHERE id = ?`
    );

    function nextDocumentNumber(sequenceName, prefix) {
        ensureSequenceStmt.run(sequenceName);
        incrementSequenceStmt.run(sequenceName);
        const row = selectSequenceStmt.get(sequenceName);
        return `${prefix}-${String(row.last_value).padStart(5, '0')}`;
    }

    function loadProductsMap() {
        const productsById = new Map();
        for (const row of selectAllProductsStmt.all()) {
            productsById.set(row.id, {
                id: row.id,
                sku: row.sku,
                name: row.name,
                category: row.category,
                priceCents: row.price_cents,
                stock: row.stock,
                minStock: row.min_stock
            });
        }
        return productsById;
    }

    function applyStockDeltaWithKardex({
        product,
        runningStockMap,
        type,
        delta,
        reason,
        reference,
        unitPriceCents,
        actor,
        now
    }) {
        const safeActor = normalizeActor(actor);
        const previousStock = runningStockMap.has(product.id)
            ? runningStockMap.get(product.id)
            : product.stock;
        const resultingStock = previousStock + delta;

        if (resultingStock < 0) {
            throw new DomainError(
                `Stock insuficiente para "${product.name}". Disponible: ${previousStock}.`,
                {
                    status: 409,
                    field: 'items',
                    code: 'INSUFFICIENT_STOCK'
                }
            );
        }

        runningStockMap.set(product.id, resultingStock);
        updateProductStockStmt.run(resultingStock, now, product.id);

        insertMovementStmt.run(
            crypto.randomUUID(),
            product.id,
            product.sku,
            product.name,
            type,
            Math.abs(delta),
            delta,
            previousStock,
            resultingStock,
            reason,
            reference,
            unitPriceCents,
            safeActor.id,
            safeActor.username,
            now
        );
    }

    return {
        listSuppliers() {
            return selectAllSuppliersStmt.all().map(mapPartyRow);
        },

        createSupplier(rawInput) {
            return runInTransaction(db, () => {
                const validation = validatePartyInput(rawInput, 'Proveedor');
                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const now = new Date().toISOString();
                const id = crypto.randomUUID();
                const data = validation.data;
                insertSupplierStmt.run(
                    id,
                    data.name,
                    data.taxId,
                    data.email,
                    data.phone,
                    data.notes,
                    now,
                    now
                );

                return mapPartyRow(selectSupplierByIdStmt.get(id));
            });
        },

        updateSupplier(id, rawInput) {
            return runInTransaction(db, () => {
                const existing = selectSupplierByIdStmt.get(id);
                if (!existing) {
                    throw new DomainError('Proveedor no encontrado.', {
                        status: 404,
                        code: 'SUPPLIER_NOT_FOUND'
                    });
                }

                const validation = validatePartyInput(
                    {
                        name: rawInput?.name ?? existing.name,
                        taxId: rawInput?.taxId ?? existing.tax_id,
                        email: rawInput?.email ?? existing.email,
                        phone: rawInput?.phone ?? existing.phone,
                        notes: rawInput?.notes ?? existing.notes
                    },
                    'Proveedor'
                );

                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const now = new Date().toISOString();
                const data = validation.data;
                updateSupplierStmt.run(
                    data.name,
                    data.taxId,
                    data.email,
                    data.phone,
                    data.notes,
                    now,
                    id
                );

                return mapPartyRow(selectSupplierByIdStmt.get(id));
            });
        },

        listCustomers() {
            return selectAllCustomersStmt.all().map(mapPartyRow);
        },

        createCustomer(rawInput) {
            return runInTransaction(db, () => {
                const validation = validatePartyInput(rawInput, 'Cliente');
                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const now = new Date().toISOString();
                const id = crypto.randomUUID();
                const data = validation.data;
                insertCustomerStmt.run(
                    id,
                    data.name,
                    data.taxId,
                    data.email,
                    data.phone,
                    data.notes,
                    now,
                    now
                );

                return mapPartyRow(selectCustomerByIdStmt.get(id));
            });
        },

        updateCustomer(id, rawInput) {
            return runInTransaction(db, () => {
                const existing = selectCustomerByIdStmt.get(id);
                if (!existing) {
                    throw new DomainError('Cliente no encontrado.', {
                        status: 404,
                        code: 'CUSTOMER_NOT_FOUND'
                    });
                }

                const validation = validatePartyInput(
                    {
                        name: rawInput?.name ?? existing.name,
                        taxId: rawInput?.taxId ?? existing.tax_id,
                        email: rawInput?.email ?? existing.email,
                        phone: rawInput?.phone ?? existing.phone,
                        notes: rawInput?.notes ?? existing.notes
                    },
                    'Cliente'
                );

                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const now = new Date().toISOString();
                const data = validation.data;
                updateCustomerStmt.run(
                    data.name,
                    data.taxId,
                    data.email,
                    data.phone,
                    data.notes,
                    now,
                    id
                );

                return mapPartyRow(selectCustomerByIdStmt.get(id));
            });
        },

        listPurchases() {
            const itemsByPurchaseId = new Map();
            for (const row of selectAllPurchaseItemsStmt.all()) {
                const mapped = mapPurchaseItemRow(row);
                const list = itemsByPurchaseId.get(mapped.purchaseId) ?? [];
                list.push(mapped);
                itemsByPurchaseId.set(mapped.purchaseId, list);
            }

            return selectAllPurchasesStmt
                .all()
                .map((row) => mapPurchaseOrderRow(row, itemsByPurchaseId.get(row.id) ?? []));
        },

        createPurchase(rawInput, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const productsById = loadProductsMap();
                const validation = validatePurchaseOrderInput(rawInput, productsById);

                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const supplier = selectSupplierByIdStmt.get(validation.data.supplierId);
                if (!supplier) {
                    throw new DomainError('El proveedor seleccionado no existe.', {
                        status: 404,
                        field: 'supplierId',
                        code: 'SUPPLIER_NOT_FOUND'
                    });
                }

                const safeActor = normalizeActor(actor);
                const now = new Date().toISOString();
                const purchaseId = crypto.randomUUID();
                const orderNumber = nextDocumentNumber('purchase_order', 'OC');
                const status = validation.data.receiveNow
                    ? PURCHASE_STATUS.RECEIVED
                    : PURCHASE_STATUS.DRAFT;
                const receivedAt = validation.data.receiveNow ? now : null;

                insertPurchaseStmt.run(
                    purchaseId,
                    orderNumber,
                    supplier.id,
                    supplier.name,
                    status,
                    validation.data.totalCents,
                    validation.data.notes,
                    safeActor.id,
                    safeActor.username,
                    now,
                    receivedAt,
                    now
                );

                const runningStockMap = new Map();
                for (const item of validation.data.items) {
                    insertPurchaseItemStmt.run(
                        crypto.randomUUID(),
                        purchaseId,
                        item.productId,
                        item.productSku,
                        item.productName,
                        item.quantity,
                        item.unitCostCents,
                        item.subtotalCents
                    );

                    if (validation.data.receiveNow) {
                        const product = productsById.get(item.productId);
                        applyStockDeltaWithKardex({
                            product,
                            runningStockMap,
                            type: MOVEMENT_TYPES.IN,
                            delta: item.quantity,
                            reason: `Compra a ${supplier.name}`,
                            reference: orderNumber,
                            unitPriceCents: item.unitCostCents,
                            actor: safeActor,
                            now
                        });
                    }
                }

                const savedRow = selectPurchaseByIdStmt.get(purchaseId);
                const savedItems = selectPurchaseItemsByPurchaseIdStmt
                    .all(purchaseId)
                    .map(mapPurchaseItemRow);
                return mapPurchaseOrderRow(savedRow, savedItems);
            });
        },

        receivePurchase(id, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const purchase = selectPurchaseByIdStmt.get(id);
                if (!purchase) {
                    throw new DomainError('Orden de compra no encontrada.', {
                        status: 404,
                        code: 'PURCHASE_NOT_FOUND'
                    });
                }

                if (purchase.status !== PURCHASE_STATUS.DRAFT) {
                    throw new DomainError('Solo se pueden recibir órdenes en estado Borrador.', {
                        status: 409,
                        code: 'INVALID_STATUS'
                    });
                }

                const items = selectPurchaseItemsByPurchaseIdStmt
                    .all(id)
                    .map(mapPurchaseItemRow);
                const productsById = loadProductsMap();

                for (const item of items) {
                    if (!item.productId || !productsById.has(item.productId)) {
                        throw new DomainError(
                            `El producto "${item.productName}" (${item.productSku}) ya no existe en el catálogo.`,
                            {
                                status: 409,
                                code: 'PRODUCT_NOT_FOUND'
                            }
                        );
                    }
                }

                const safeActor = normalizeActor(actor);
                const now = new Date().toISOString();
                markPurchaseReceivedStmt.run(now, now, id);

                const runningStockMap = new Map();
                for (const item of items) {
                    const product = productsById.get(item.productId);
                    applyStockDeltaWithKardex({
                        product,
                        runningStockMap,
                        type: MOVEMENT_TYPES.IN,
                        delta: item.quantity,
                        reason: `Recepción de compra (${purchase.supplier_name})`,
                        reference: purchase.order_number,
                        unitPriceCents: item.unitCostCents,
                        actor: safeActor,
                        now
                    });
                }

                return mapPurchaseOrderRow(selectPurchaseByIdStmt.get(id), items);
            });
        },

        cancelPurchase(id) {
            return runInTransaction(db, () => {
                const purchase = selectPurchaseByIdStmt.get(id);
                if (!purchase) {
                    throw new DomainError('Orden de compra no encontrada.', {
                        status: 404,
                        code: 'PURCHASE_NOT_FOUND'
                    });
                }

                if (purchase.status !== PURCHASE_STATUS.DRAFT) {
                    throw new DomainError('Solo se pueden cancelar órdenes en estado Borrador.', {
                        status: 409,
                        code: 'INVALID_STATUS'
                    });
                }

                const now = new Date().toISOString();
                markPurchaseCancelledStmt.run(now, id);

                const items = selectPurchaseItemsByPurchaseIdStmt
                    .all(id)
                    .map(mapPurchaseItemRow);
                return mapPurchaseOrderRow(selectPurchaseByIdStmt.get(id), items);
            });
        },

        listSales() {
            const itemsBySaleId = new Map();
            for (const row of selectAllSaleItemsStmt.all()) {
                const mapped = mapSaleItemRow(row);
                const list = itemsBySaleId.get(mapped.saleId) ?? [];
                list.push(mapped);
                itemsBySaleId.set(mapped.saleId, list);
            }

            return selectAllSalesStmt
                .all()
                .map((row) => mapSaleOrderRow(row, itemsBySaleId.get(row.id) ?? []));
        },

        createSale(rawInput, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const productsById = loadProductsMap();
                const validation = validateSaleOrderInput(rawInput, productsById);

                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: validation.code === 'INSUFFICIENT_STOCK' ? 409 : 400,
                        field: validation.field,
                        code: validation.code ?? 'VALIDATION_ERROR'
                    });
                }

                let customerId = null;
                let customerName = 'Consumidor Final';

                if (validation.data.customerId) {
                    const customer = selectCustomerByIdStmt.get(validation.data.customerId);
                    if (!customer) {
                        throw new DomainError('El cliente seleccionado no existe.', {
                            status: 404,
                            field: 'customerId',
                            code: 'CUSTOMER_NOT_FOUND'
                        });
                    }
                    customerId = customer.id;
                    customerName = customer.name;
                }

                const safeActor = normalizeActor(actor);
                const now = new Date().toISOString();
                const saleId = crypto.randomUUID();
                const saleNumber = nextDocumentNumber('sales_order', 'VTA');

                insertSaleStmt.run(
                    saleId,
                    saleNumber,
                    customerId,
                    customerName,
                    SALE_STATUS.CONFIRMED,
                    validation.data.totalCents,
                    validation.data.notes,
                    safeActor.id,
                    safeActor.username,
                    now,
                    null,
                    now
                );

                const runningStockMap = new Map();
                for (const item of validation.data.items) {
                    insertSaleItemStmt.run(
                        crypto.randomUUID(),
                        saleId,
                        item.productId,
                        item.productSku,
                        item.productName,
                        item.quantity,
                        item.unitPriceCents,
                        item.subtotalCents
                    );

                    const product = productsById.get(item.productId);
                    applyStockDeltaWithKardex({
                        product,
                        runningStockMap,
                        type: MOVEMENT_TYPES.OUT,
                        delta: -item.quantity,
                        reason: `Venta a ${customerName}`,
                        reference: saleNumber,
                        unitPriceCents: item.unitPriceCents,
                        actor: safeActor,
                        now
                    });
                }

                const savedRow = selectSaleByIdStmt.get(saleId);
                const savedItems = selectSaleItemsBySaleIdStmt
                    .all(saleId)
                    .map(mapSaleItemRow);
                return mapSaleOrderRow(savedRow, savedItems);
            });
        },

        cancelSale(id, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const sale = selectSaleByIdStmt.get(id);
                if (!sale) {
                    throw new DomainError('Venta no encontrada.', {
                        status: 404,
                        code: 'SALE_NOT_FOUND'
                    });
                }

                if (sale.status !== SALE_STATUS.CONFIRMED) {
                    throw new DomainError('La venta ya se encuentra anulada.', {
                        status: 409,
                        code: 'INVALID_STATUS'
                    });
                }

                const safeActor = normalizeActor(actor);
                const now = new Date().toISOString();
                markSaleCancelledStmt.run(now, now, id);

                const items = selectSaleItemsBySaleIdStmt.all(id).map(mapSaleItemRow);
                const runningStockMap = new Map();

                for (const item of items) {
                    if (!item.productId) {
                        continue;
                    }
                    const productRow = selectProductByIdStmt.get(item.productId);
                    if (!productRow) {
                        continue;
                    }

                    const product = {
                        id: productRow.id,
                        sku: productRow.sku,
                        name: productRow.name,
                        priceCents: productRow.price_cents,
                        stock: productRow.stock
                    };

                    applyStockDeltaWithKardex({
                        product,
                        runningStockMap,
                        type: MOVEMENT_TYPES.IN,
                        delta: item.quantity,
                        reason: `Anulación de venta ${sale.sale_number}`,
                        reference: sale.sale_number,
                        unitPriceCents: item.unitPriceCents,
                        actor: safeActor,
                        now
                    });
                }

                return mapSaleOrderRow(selectSaleByIdStmt.get(id), items);
            });
        }
    };
}

