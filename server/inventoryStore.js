import crypto from 'node:crypto';
import { centsToInputValue } from '../src/domain/money.js';
import { MOVEMENT_TYPES, validateMovementInput } from '../src/domain/movement.js';
import { createProduct as buildProductEntity, validateProductInput } from '../src/domain/product.js';
import { runInTransaction } from './db.js';

export class DomainError extends Error {
    /**
     * @param {string} message
     * @param {{ status?: number, field?: string | null, code?: string }} [options]
     */
    constructor(message, { status = 400, field = null, code = 'DOMAIN_ERROR' } = {}) {
        super(message);
        this.name = 'DomainError';
        this.status = status;
        this.field = field;
        this.code = code;
    }
}

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

function mapProductRow(row) {
    return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        category: row.category,
        priceCents: row.price_cents,
        stock: row.stock,
        minStock: row.min_stock,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapMovementRow(row) {
    return {
        id: row.id,
        productId: row.product_id,
        productSku: row.product_sku,
        productName: row.product_name,
        type: row.type,
        quantity: row.quantity,
        delta: row.delta,
        previousStock: row.previous_stock,
        resultingStock: row.resulting_stock,
        reason: row.reason,
        reference: row.reference,
        unitPriceCents: row.unit_price_cents,
        userId: row.user_id ?? null,
        actorUsername: row.actor_username ?? 'sistema',
        createdAt: row.created_at
    };
}

/**
 * SQLite ACID data-access layer for ERP products and immutable Kardex stock movements.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createInventoryStore(db) {
    const selectAllProductsStmt = db.prepare(
        'SELECT * FROM products ORDER BY created_at DESC, rowid DESC'
    );
    const selectProductByIdStmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const insertProductStmt = db.prepare(
        `INSERT INTO products (id, sku, name, category, price_cents, stock, min_stock, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateProductStmt = db.prepare(
        `UPDATE products
         SET sku = ?, name = ?, category = ?, price_cents = ?, stock = ?, min_stock = ?, updated_at = ?
         WHERE id = ?`
    );
    const updateProductStockStmt = db.prepare(
        'UPDATE products SET stock = ?, updated_at = ? WHERE id = ?'
    );
    const deleteProductStmt = db.prepare('DELETE FROM products WHERE id = ?');
    const insertMovementStmt = db.prepare(
        `INSERT INTO stock_movements (
            id, product_id, product_sku, product_name, type, quantity, delta,
            previous_stock, resulting_stock, reason, reference, unit_price_cents,
            user_id, actor_username, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    function listProducts() {
        return selectAllProductsStmt.all().map(mapProductRow);
    }

    function getProductById(id) {
        const row = selectProductByIdStmt.get(id);
        return row ? mapProductRow(row) : null;
    }

    function insertMovementRecord({
        productId,
        productSku,
        productName,
        type,
        quantity,
        delta,
        previousStock,
        resultingStock,
        reason,
        reference = '',
        unitPriceCents,
        actor = SYSTEM_ACTOR,
        createdAt = new Date().toISOString()
    }) {
        const safeActor = normalizeActor(actor);
        const movement = {
            id: crypto.randomUUID(),
            productId,
            productSku,
            productName,
            type,
            quantity,
            delta,
            previousStock,
            resultingStock,
            reason,
            reference,
            unitPriceCents,
            userId: safeActor.id,
            actorUsername: safeActor.username,
            createdAt
        };

        insertMovementStmt.run(
            movement.id,
            movement.productId,
            movement.productSku,
            movement.productName,
            movement.type,
            movement.quantity,
            movement.delta,
            movement.previousStock,
            movement.resultingStock,
            movement.reason,
            movement.reference,
            movement.unitPriceCents,
            movement.userId,
            movement.actorUsername,
            movement.createdAt
        );

        return movement;
    }

    function buildValidationError(validation) {
        const isDuplicateSku =
            validation.field === 'sku' && validation.error.startsWith('Ya existe');
        return new DomainError(validation.error, {
            status: isDuplicateSku ? 409 : 400,
            field: validation.field,
            code: isDuplicateSku ? 'DUPLICATE_SKU' : 'VALIDATION_ERROR'
        });
    }

    return {
        listProducts,
        getProductById,

        createProduct(rawInput, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const existingProducts = listProducts();
                const validation = validateProductInput(rawInput, existingProducts, null);

                if (!validation.ok) {
                    throw buildValidationError(validation);
                }

                const now = new Date().toISOString();
                const product = buildProductEntity(validation.data, { now });

                insertProductStmt.run(
                    product.id,
                    product.sku,
                    product.name,
                    product.category,
                    product.priceCents,
                    product.stock,
                    product.minStock,
                    product.createdAt,
                    product.updatedAt
                );

                let movement = null;
                if (product.stock > 0) {
                    movement = insertMovementRecord({
                        productId: product.id,
                        productSku: product.sku,
                        productName: product.name,
                        type: MOVEMENT_TYPES.IN,
                        quantity: product.stock,
                        delta: product.stock,
                        previousStock: 0,
                        resultingStock: product.stock,
                        reason: 'Stock inicial de alta',
                        reference: '',
                        unitPriceCents: product.priceCents,
                        actor,
                        createdAt: now
                    });
                }

                return { product, movement };
            });
        },

        updateProduct(id, rawInput, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const existing = getProductById(id);
                if (!existing) {
                    throw new DomainError('Producto no encontrado.', {
                        status: 404,
                        code: 'PRODUCT_NOT_FOUND'
                    });
                }

                const mergedInput = {
                    sku: rawInput?.sku !== undefined ? rawInput.sku : existing.sku,
                    name: rawInput?.name !== undefined ? rawInput.name : existing.name,
                    category: rawInput?.category !== undefined ? rawInput.category : existing.category,
                    price:
                        rawInput?.price !== undefined
                            ? rawInput.price
                            : centsToInputValue(rawInput?.priceCents ?? existing.priceCents),
                    stock: rawInput?.stock !== undefined ? rawInput.stock : existing.stock,
                    minStock: rawInput?.minStock !== undefined ? rawInput.minStock : existing.minStock
                };

                const existingProducts = listProducts();
                const validation = validateProductInput(mergedInput, existingProducts, id);

                if (!validation.ok) {
                    throw buildValidationError(validation);
                }

                const now = new Date().toISOString();
                const data = validation.data;

                updateProductStmt.run(
                    data.sku,
                    data.name,
                    data.category,
                    data.priceCents,
                    data.stock,
                    data.minStock,
                    now,
                    id
                );

                let movement = null;
                if (data.stock !== existing.stock) {
                    const delta = data.stock - existing.stock;
                    movement = insertMovementRecord({
                        productId: existing.id,
                        productSku: data.sku,
                        productName: data.name,
                        type: MOVEMENT_TYPES.ADJUSTMENT,
                        quantity: Math.abs(delta),
                        delta,
                        previousStock: existing.stock,
                        resultingStock: data.stock,
                        reason: 'Ajuste desde edición de producto',
                        reference: '',
                        unitPriceCents: data.priceCents,
                        actor,
                        createdAt: now
                    });
                }

                return {
                    product: {
                        id: existing.id,
                        ...data,
                        createdAt: existing.createdAt,
                        updatedAt: now
                    },
                    movement
                };
            });
        },

        deleteProduct(id, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const existing = getProductById(id);
                if (!existing) {
                    throw new DomainError('Producto no encontrado.', {
                        status: 404,
                        code: 'PRODUCT_NOT_FOUND'
                    });
                }

                if (existing.stock > 0) {
                    insertMovementRecord({
                        productId: existing.id,
                        productSku: existing.sku,
                        productName: existing.name,
                        type: MOVEMENT_TYPES.OUT,
                        quantity: existing.stock,
                        delta: -existing.stock,
                        previousStock: existing.stock,
                        resultingStock: 0,
                        reason: 'Baja de producto del catálogo',
                        reference: '',
                        unitPriceCents: existing.priceCents,
                        actor
                    });
                }

                deleteProductStmt.run(id);
                return { deleted: true, id };
            });
        },

        listMovements({ productId = '', type = '', limit = 200 } = {}) {
            const conditions = [];
            const params = [];

            if (productId) {
                conditions.push('product_id = ?');
                params.push(String(productId));
            }

            if (type) {
                const normalizedType = String(type).trim().toUpperCase();
                if (normalizedType && normalizedType !== 'ALL') {
                    conditions.push('type = ?');
                    params.push(normalizedType);
                }
            }

            const parsedLimit = Number(limit);
            const safeLimit =
                Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
            params.push(safeLimit);

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const sql = `SELECT * FROM stock_movements ${whereClause} ORDER BY created_at DESC, rowid DESC LIMIT ?`;

            return db.prepare(sql).all(...params).map(mapMovementRow);
        },

        recordMovement(rawInput, actor = SYSTEM_ACTOR) {
            return runInTransaction(db, () => {
                const productId = typeof rawInput?.productId === 'string' ? rawInput.productId.trim() : '';
                const product = productId ? getProductById(productId) : null;

                if (!product) {
                    throw new DomainError('Producto no encontrado.', {
                        status: 404,
                        field: 'productId',
                        code: 'PRODUCT_NOT_FOUND'
                    });
                }

                const validation = validateMovementInput(rawInput, product);
                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: validation.code === 'INSUFFICIENT_STOCK' ? 409 : 400,
                        field: validation.field,
                        code: validation.code
                    });
                }

                const now = new Date().toISOString();
                const data = validation.data;

                updateProductStockStmt.run(data.resultingStock, now, product.id);

                const movement = insertMovementRecord({
                    productId: product.id,
                    productSku: product.sku,
                    productName: product.name,
                    type: data.type,
                    quantity: data.quantity,
                    delta: data.delta,
                    previousStock: data.previousStock,
                    resultingStock: data.resultingStock,
                    reason: data.reason,
                    reference: data.reference,
                    unitPriceCents: product.priceCents,
                    actor,
                    createdAt: now
                });

                return {
                    product: {
                        ...product,
                        stock: data.resultingStock,
                        updatedAt: now
                    },
                    movement
                };
            });
        }
    };
}
