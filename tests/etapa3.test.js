import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAuthStore } from '../server/authStore.js';
import { createDatabase } from '../server/db.js';
import { createInventoryStore } from '../server/inventoryStore.js';
import { createOperationsStore } from '../server/operationsStore.js';
import { createAppHandler } from '../server/router.js';

const STATIC_ROOT = path.resolve(import.meta.dirname, '..');

function extractSessionCookie(res) {
    const rawCookie = res.headers.get('set-cookie');
    assert.ok(rawCookie, 'Expected Set-Cookie header');
    assert.match(rawCookie, /HttpOnly/i);
    assert.match(rawCookie, /SameSite=Lax/i);
    return rawCookie.split(';')[0];
}

async function createServerContext() {
    const db = createDatabase(':memory:');
    const store = createInventoryStore(db);
    const authStore = createAuthStore(db);
    const operationsStore = createOperationsStore(db);
    const handler = createAppHandler({ store, authStore, operationsStore, staticRoot: STATIC_ROOT });
    const server = http.createServer((req, res) => {
        void handler(req, res);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function api(pathname, { method = 'GET', body = undefined, cookie = '' } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(`${baseUrl}${pathname}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => null);
        return { res, status: res.status, data };
    }

    return {
        db,
        baseUrl,
        api,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            db.close();
        }
    };
}

test('etapa3 migration: upgrades Etapa 2 SQLite DB non-destructively to user_version 2', () => {
    const tempDbPath = path.join(os.tmpdir(), `erp-mig-${crypto.randomUUID()}.db`);

    try {
        // Simulate legacy Etapa 2 database (user_version = 0, no user_id/actor_username columns)
        const legacyDb = new DatabaseSync(tempDbPath);
        legacyDb.exec(`
            CREATE TABLE products (
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
            CREATE TABLE stock_movements (
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
            INSERT INTO products VALUES ('p-legacy', 'LEG-01', 'Producto Legacy', 'General', 15000, 7, 2, '2026-11-19T10:00:00Z', '2026-11-19T10:00:00Z');
            INSERT INTO stock_movements VALUES ('m-legacy', 'p-legacy', 'LEG-01', 'Producto Legacy', 'IN', 7, 7, 0, 7, 'Stock inicial', '', 15000, '2026-11-19T10:00:00Z');
        `);
        legacyDb.close();

        // Run Etapa 3+ createDatabase migration
        const migratedDb = createDatabase(tempDbPath);
        try {
            const versionRow = migratedDb.prepare('PRAGMA user_version').get();
            assert.equal(versionRow.user_version, 3);

            const store = createInventoryStore(migratedDb);
            const products = store.listProducts();
            assert.equal(products.length, 1);
            assert.equal(products[0].sku, 'LEG-01');
            assert.equal(products[0].stock, 7);

            const movements = store.listMovements();
            assert.equal(movements.length, 1);
            assert.equal(movements[0].actorUsername, 'sistema');
            assert.equal(movements[0].userId, null);

            const authStore = createAuthStore(migratedDb);
            assert.equal(authStore.hasUsers(), false);
        } finally {
            migratedDb.close();
        }
    } finally {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${tempDbPath}${suffix}`, { force: true });
        }
    }
});

test('etapa3 auth & RBAC: setup, login/logout, role enforcement, last-admin protection, and session revocation', async () => {
    const ctx = await createServerContext();
    try {
        // 1. Initial status uninitialized
        const initStatus = await ctx.api('/api/auth/status');
        assert.equal(initStatus.status, 200);
        assert.deepEqual(initStatus.data, {
            initialized: false,
            authenticated: false,
            user: null
        });

        // 2. Setup first ADMIN
        const setupRes = await ctx.api('/api/auth/setup', {
            method: 'POST',
            body: { fullName: 'Pablo Ruiz', username: 'admin', password: 'AdminPassword1!' }
        });
        assert.equal(setupRes.status, 201);
        assert.equal(setupRes.data.user.role, 'ADMIN');
        const adminCookie = extractSessionCookie(setupRes.res);

        // 3. Duplicate setup blocked with 409
        const dupSetup = await ctx.api('/api/auth/setup', {
            method: 'POST',
            body: { fullName: 'Hacker', username: 'hacker', password: 'Password123!' }
        });
        assert.equal(dupSetup.status, 409);

        // 4. Create OPERATOR and AUDITOR
        const opCreate = await ctx.api('/api/users', {
            method: 'POST',
            cookie: adminCookie,
            body: {
                username: 'op1',
                fullName: 'Operador Uno',
                role: 'OPERATOR',
                password: 'OperatorPassword1!'
            }
        });
        assert.equal(opCreate.status, 201);
        const opUserId = opCreate.data.user.id;

        const audCreate = await ctx.api('/api/users', {
            method: 'POST',
            cookie: adminCookie,
            body: {
                username: 'aud1',
                fullName: 'Auditor Uno',
                role: 'AUDITOR',
                password: 'AuditorPassword1!'
            }
        });
        assert.equal(audCreate.status, 201);

        // 5. Invalid login fails with 401
        const badLogin = await ctx.api('/api/auth/login', {
            method: 'POST',
            body: { username: 'op1', password: 'WrongPassword!' }
        });
        assert.equal(badLogin.status, 401);

        // 6. Login OPERATOR & AUDITOR
        const opLogin = await ctx.api('/api/auth/login', {
            method: 'POST',
            body: { username: 'op1', password: 'OperatorPassword1!' }
        });
        assert.equal(opLogin.status, 200);
        const opCookie = extractSessionCookie(opLogin.res);

        const audLogin = await ctx.api('/api/auth/login', {
            method: 'POST',
            body: { username: 'aud1', password: 'AuditorPassword1!' }
        });
        assert.equal(audLogin.status, 200);
        const audCookie = extractSessionCookie(audLogin.res);

        // 7. RBAC Matrix Checks
        const prodCreate = await ctx.api('/api/products', {
            method: 'POST',
            cookie: opCookie,
            body: { sku: 'RBAC-1', name: 'Item RBAC', category: 'General', price: '100', stock: '5', minStock: '1' }
        });
        assert.equal(prodCreate.status, 201);
        const productId = prodCreate.data.product.id;

        // AUDITOR can read, cannot write or manage users
        assert.equal((await ctx.api('/api/products', { cookie: audCookie })).status, 200);
        assert.equal(
            (await ctx.api('/api/products', {
                method: 'POST',
                cookie: audCookie,
                body: { sku: 'X-1', name: 'X', price: '10', stock: '1' }
            })).status,
            403
        );
        assert.equal((await ctx.api('/api/users', { cookie: audCookie })).status, 403);

        // OPERATOR cannot delete products or manage users
        assert.equal((await ctx.api(`/api/products/${productId}`, { method: 'DELETE', cookie: opCookie })).status, 403);
        assert.equal((await ctx.api('/api/users', { cookie: opCookie })).status, 403);

        // 8. Cannot deactivate last active ADMIN
        const adminId = setupRes.data.user.id;
        const lastAdminAttempt = await ctx.api(`/api/users/${adminId}`, {
            method: 'PUT',
            cookie: adminCookie,
            body: { isActive: false }
        });
        assert.equal(lastAdminAttempt.status, 409);
        assert.equal(lastAdminAttempt.data.code, 'LAST_ADMIN_PROTECTED');

        // 9. Deactivating op1 revokes op1's session immediately
        const deactivateOp = await ctx.api(`/api/users/${opUserId}`, {
            method: 'PUT',
            cookie: adminCookie,
            body: { isActive: false }
        });
        assert.equal(deactivateOp.status, 200);
        assert.equal(deactivateOp.data.user.isActive, false);

        const revokedCheck = await ctx.api('/api/products', { cookie: opCookie });
        assert.equal(revokedCheck.status, 401);

        // 10. Logout clears and revokes AUDITOR session
        const logoutRes = await ctx.api('/api/auth/logout', { method: 'POST', cookie: audCookie });
        assert.equal(logoutRes.status, 200);
        assert.equal((await ctx.api('/api/products', { cookie: audCookie })).status, 401);
    } finally {
        await ctx.close();
    }
});

test('etapa3 operations: connected purchases, multi-item sales rollback, price snapshot, cancellation, and Kardex invariant', async () => {
    const ctx = await createServerContext();
    try {
        const setupRes = await ctx.api('/api/auth/setup', {
            method: 'POST',
            body: { fullName: 'Admin ERP', username: 'admin', password: 'AdminPassword1!' }
        });
        const adminCookie = extractSessionCookie(setupRes.res);

        await ctx.api('/api/users', {
            method: 'POST',
            cookie: adminCookie,
            body: { username: 'op1', fullName: 'Operador', role: 'OPERATOR', password: 'OperatorPassword1!' }
        });
        const opLogin = await ctx.api('/api/auth/login', {
            method: 'POST',
            body: { username: 'op1', password: 'OperatorPassword1!' }
        });
        const opCookie = extractSessionCookie(opLogin.res);

        // Create product (stock 5, price $1000.00) & supplier & customer
        const prodRes = await ctx.api('/api/products', {
            method: 'POST',
            cookie: opCookie,
            body: { sku: 'SKU-A', name: 'Placa Red', category: 'Redes', price: '1000.00', stock: '5', minStock: '2' }
        });
        const productId = prodRes.data.product.id;

        const supRes = await ctx.api('/api/suppliers', {
            method: 'POST',
            cookie: opCookie,
            body: { name: 'Mayorista Tech', taxId: '30-11223344-5' }
        });
        assert.equal(supRes.status, 201);
        const supplierId = supRes.data.supplier.id;

        const custRes = await ctx.api('/api/customers', {
            method: 'POST',
            cookie: opCookie,
            body: { name: 'Cliente Pyme SRL', taxId: '30-99887766-1' }
        });
        assert.equal(custRes.status, 201);
        const customerId = custRes.data.customer.id;

        // 1. Draft purchase OC-00001 -> does NOT increment stock yet
        const draftPurchaseRes = await ctx.api('/api/purchases', {
            method: 'POST',
            cookie: opCookie,
            body: {
                supplierId,
                receiveNow: false,
                notes: 'Pedido semanal',
                items: [{ productId, quantity: '4', unitCost: '600.00' }]
            }
        });
        assert.equal(draftPurchaseRes.status, 201);
        assert.equal(draftPurchaseRes.data.purchase.orderNumber, 'OC-00001');
        assert.equal(draftPurchaseRes.data.purchase.status, 'DRAFT');
        assert.equal(draftPurchaseRes.data.purchase.totalCents, 240000);

        let prodNow = (await ctx.api(`/api/products/${productId}`, { cookie: opCookie })).data.product;
        assert.equal(prodNow.stock, 5);

        // 2. Receive OC-00001 -> increments stock 5 -> 9 & logs Kardex IN
        const receiveRes = await ctx.api(`/api/purchases/${draftPurchaseRes.data.purchase.id}/receive`, {
            method: 'POST',
            cookie: opCookie
        });
        assert.equal(receiveRes.status, 200);
        assert.equal(receiveRes.data.purchase.status, 'RECEIVED');

        prodNow = (await ctx.api(`/api/products/${productId}`, { cookie: opCookie })).data.product;
        assert.equal(prodNow.stock, 9);

        // 3. Multi-line sale exceeding stock (5 + 5 = 10 > 9) -> 409 rollback, stock remains 9
        const failSale = await ctx.api('/api/sales', {
            method: 'POST',
            cookie: opCookie,
            body: {
                customerId,
                items: [
                    { productId, quantity: '5' },
                    { productId, quantity: '5' }
                ]
            }
        });
        assert.equal(failSale.status, 409);
        assert.equal(failSale.data.code, 'INSUFFICIENT_STOCK');
        prodNow = (await ctx.api(`/api/products/${productId}`, { cookie: opCookie })).data.product;
        assert.equal(prodNow.stock, 9);

        // 4. Valid sale VTA-00001 (3 units @ $1000.00) -> stock 9 -> 6
        const saleRes = await ctx.api('/api/sales', {
            method: 'POST',
            cookie: opCookie,
            body: {
                customerId,
                notes: 'FC-A 0001',
                items: [{ productId, quantity: '3' }]
            }
        });
        assert.equal(saleRes.status, 201);
        assert.equal(saleRes.data.sale.saleNumber, 'VTA-00001');
        assert.equal(saleRes.data.sale.totalCents, 300000);

        // 5. Catalog price change to $1500.00 does NOT mutate historical sale snapshot ($1000.00)
        await ctx.api(`/api/products/${productId}`, {
            method: 'PUT',
            cookie: opCookie,
            body: { price: '1500.00' }
        });
        const salesList = (await ctx.api('/api/sales', { cookie: opCookie })).data.sales;
        assert.equal(salesList[0].items[0].unitPriceCents, 100000);
        assert.equal(salesList[0].totalCents, 300000);

        // 6. OPERATOR cannot cancel sale (403); ADMIN cancels VTA-00001 -> restores stock 6 -> 9 + Kardex IN
        assert.equal(
            (await ctx.api(`/api/sales/${saleRes.data.sale.id}/cancel`, { method: 'POST', cookie: opCookie })).status,
            403
        );
        const cancelSale = await ctx.api(`/api/sales/${saleRes.data.sale.id}/cancel`, {
            method: 'POST',
            cookie: adminCookie
        });
        assert.equal(cancelSale.status, 200);
        assert.equal(cancelSale.data.sale.status, 'CANCELLED');

        prodNow = (await ctx.api(`/api/products/${productId}`, { cookie: adminCookie })).data.product;
        assert.equal(prodNow.stock, 9);

        // 7. Kardex accounting invariant + actor attribution
        const movements = (await ctx.api(`/api/movements?productId=${productId}`, { cookie: adminCookie })).data.movements;
        assert.equal(movements.length, 4); // +5 (alta op1), +4 (OC-00001 op1), -3 (VTA-00001 op1), +3 (cancel VTA-00001 admin)
        assert.equal(movements.reduce((acc, m) => acc + m.delta, 0), 9);
        assert.equal(movements[0].actorUsername, 'admin');
        assert.equal(movements[1].actorUsername, 'op1');
        assert.equal(movements[1].reference, 'VTA-00001');
        assert.equal(movements[2].reference, 'OC-00001');
    } finally {
        await ctx.close();
    }
});

