import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
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

/**
 * Opens or initializes the SQLite database with strict constraints and WAL mode.
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
    db.exec(SCHEMA_SQL);

    return db;
}

/**
 * Executes a synchronous callback inside an ACID BEGIN IMMEDIATE transaction.
 * Rolls back automatically if any statement throws.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} callback
 * @returns {T}
 */
export function runInTransaction(db, callback) {
    db.exec('BEGIN IMMEDIATE;');
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
    }
}

