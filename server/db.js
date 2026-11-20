import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock INTEGER NOT NULL CHECK (stock >= 0),
    min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUSTMENT')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    delta INTEGER NOT NULL CHECK (delta != 0),
    previous_stock INTEGER NOT NULL CHECK (previous_stock >= 0),
    resulting_stock INTEGER NOT NULL CHECK (resulting_stock >= 0),
    reason TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at
    ON stock_movements (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created_at
    ON stock_movements (product_id, created_at DESC);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR', 'AUDITOR')),
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tax_id TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tax_id TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
    name TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED')),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    notes TEXT NOT NULL DEFAULT '',
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    received_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at
    ON purchase_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id
    ON purchase_items (purchase_id);

CREATE TABLE IF NOT EXISTS sales_orders (
    id TEXT PRIMARY KEY,
    sale_number TEXT NOT NULL UNIQUE,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    notes TEXT NOT NULL DEFAULT '',
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_items (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_orders_created_at
    ON sales_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_items_sale_id
    ON sales_items (sale_id);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS document_intakes (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    document_type TEXT NOT NULL CHECK (document_type IN ('PURCHASE', 'SALE')),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'ERROR')),
    ai_provider TEXT NOT NULL DEFAULT 'gemini',
    ai_model TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    duplicate_of_id TEXT REFERENCES document_intakes(id) ON DELETE SET NULL,
    raw_extraction_json TEXT NOT NULL DEFAULT '{}',
    review_payload_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error_message TEXT NOT NULL DEFAULT '',
    approved_order_type TEXT DEFAULT NULL,
    approved_order_id TEXT DEFAULT NULL,
    approved_order_number TEXT DEFAULT NULL,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by_username TEXT NOT NULL DEFAULT 'sistema',
    reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by_username TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_intakes_created_at
    ON document_intakes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_intakes_status_created_at
    ON document_intakes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_intakes_content_hash
    ON document_intakes (content_hash);
`;

const txDepthByDb = new WeakMap();
let savepointCounter = 0;

function applyMigrations(db) {
    const row = db.prepare('PRAGMA user_version').get();
    const currentVersion = row ? Number(row.user_version) : 0;

    if (currentVersion < 1) {
        runInTransaction(db, () => {
            db.exec(SCHEMA_V1_SQL);
            db.exec('PRAGMA user_version = 1;');
        });
    }

    if (currentVersion < 2) {
        runInTransaction(db, () => {
            const movementColumns = db.prepare('PRAGMA table_info(stock_movements)').all();
            const columnNames = new Set(movementColumns.map((col) => col.name));

            if (!columnNames.has('user_id')) {
                db.exec('ALTER TABLE stock_movements ADD COLUMN user_id TEXT;');
            }
            if (!columnNames.has('actor_username')) {
                db.exec("ALTER TABLE stock_movements ADD COLUMN actor_username TEXT NOT NULL DEFAULT 'sistema';");
            }

            db.exec(SCHEMA_V2_SQL);
            db.exec('PRAGMA user_version = 2;');
        });
    }

    if (currentVersion < 3) {
        runInTransaction(db, () => {
            db.exec(SCHEMA_V3_SQL);
            db.exec('PRAGMA user_version = 3;');
        });
    }
}

/**
 * Opens or initializes the SQLite database with strict constraints, WAL mode, and schema migrations.
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
export function createDatabase(dbPath) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    const db = new DatabaseSync(dbPath);

    if (dbPath !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL;');
    }

    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    applyMigrations(db);

    return db;
}

/**
 * Executes a synchronous callback inside an ACID BEGIN IMMEDIATE transaction.
 * Supports composable nesting via SQLite SAVEPOINTs so multi-store operations commit atomically.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} callback
 * @returns {T}
 */
export function runInTransaction(db, callback) {
    const depth = txDepthByDb.get(db) ?? 0;

    if (depth === 0) {
        db.exec('BEGIN IMMEDIATE;');
        txDepthByDb.set(db, 1);
        try {
            const result = callback();
            db.exec('COMMIT;');
            return result;
        } catch (error) {
            try {
                db.exec('ROLLBACK;');
            } catch {
                // Ignore rollback failure when transaction is already aborted.
            }
            throw error;
        } finally {
            txDepthByDb.delete(db);
        }
    }

    savepointCounter += 1;
    const spName = `sp_erp_${savepointCounter}`;
    db.exec(`SAVEPOINT ${spName};`);
    txDepthByDb.set(db, depth + 1);
    try {
        const result = callback();
        db.exec(`RELEASE SAVEPOINT ${spName};`);
        return result;
    } catch (error) {
        try {
            db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
            db.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
            // Ignore savepoint rollback errors if outer transaction aborted.
        }
        throw error;
    } finally {
        txDepthByDb.set(db, depth);
    }
}
