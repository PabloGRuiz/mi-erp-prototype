import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { createDatabase } from '../server/db.js';
import { createInventoryStore } from '../server/inventoryStore.js';
import { createAppHandler } from '../server/router.js';

const STATIC_ROOT = path.resolve(import.meta.dirname, '..');

function rawHttpGet(port, rawPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function createTestContext() {
    const db = createDatabase(':memory:');
    const store = createInventoryStore(db);
    const handler = createAppHandler({ store, staticRoot: STATIC_ROOT });
    const server = http.createServer((req, res) => {
        void handler(req, res);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
        db,
        port,
        baseUrl,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            db.close();
        }
    };
}

test('api: health check reports sqlite storage', async () => {
    const ctx = await createTestContext();
    try {
        const res = await fetch(`${ctx.baseUrl}/api/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { ok: true, storage: 'sqlite' });
    } finally {
        await ctx.close();
    }
});

test('api: full product CRUD + Kardex movements + ACID rollback + accounting invariant', async () => {
    const ctx = await createTestContext();
    try {
        // 1. Create product with initial stock -> auto-logs IN movement
        const createRes = await fetch(`${ctx.baseUrl}/api/products`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sku: 'tec-001',
                name: 'Teclado Mecánico',
                category: 'Periféricos',
                price: '45000.50',
                stock: '10',
                minStock: '3'
            })
        });
        assert.equal(createRes.status, 201);
        const createdPayload = await createRes.json();
        const productId = createdPayload.product.id;
        assert.equal(createdPayload.product.sku, 'TEC-001');
        assert.equal(createdPayload.product.priceCents, 4500050);
        assert.equal(createdPayload.movement.type, 'IN');
        assert.equal(createdPayload.movement.delta, 10);

        // 2. Duplicate SKU returns 409
        const dupRes = await fetch(`${ctx.baseUrl}/api/products`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sku: 'TEC-001',
                name: 'Duplicado',
                category: 'Periféricos',
                price: '100',
                stock: '1',
                minStock: '0'
            })
        });
        assert.equal(dupRes.status, 409);
        const dupBody = await dupRes.json();
        assert.equal(dupBody.code, 'DUPLICATE_SKU');

        // 3. Record IN movement (+5 -> 15)
        const inRes = await fetch(`${ctx.baseUrl}/api/movements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId,
                type: 'IN',
                quantity: '5',
                reason: 'Compra a proveedor',
                reference: 'FC-001'
            })
        });
        assert.equal(inRes.status, 201);
        const inBody = await inRes.json();
        assert.equal(inBody.product.stock, 15);
        assert.equal(inBody.movement.delta, 5);

        // 4. Record OUT movement (-4 -> 11)
        const outRes = await fetch(`${ctx.baseUrl}/api/movements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId,
                type: 'OUT',
                quantity: '4',
                reason: 'Venta mostrador',
                reference: 'TK-100'
            })
        });
        assert.equal(outRes.status, 201);
        const outBody = await outRes.json();
        assert.equal(outBody.product.stock, 11);
        assert.equal(outBody.movement.delta, -4);

        // 5. Reject OUT movement exceeding available stock (409 + rollback)
        const failOutRes = await fetch(`${ctx.baseUrl}/api/movements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId,
                type: 'OUT',
                quantity: '999',
                reason: 'Venta inválida'
            })
        });
        assert.equal(failOutRes.status, 409);
        const failOutBody = await failOutRes.json();
        assert.equal(failOutBody.code, 'INSUFFICIENT_STOCK');

        // Verify stock remained 11 after rollback
        const getAfterFail = await fetch(`${ctx.baseUrl}/api/products/${productId}`);
        const productAfterFail = (await getAfterFail.json()).product;
        assert.equal(productAfterFail.stock, 11);

        // 6. Record ADJUSTMENT to 8 (-3 -> 8)
        const adjRes = await fetch(`${ctx.baseUrl}/api/movements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productId,
                type: 'ADJUSTMENT',
                targetStock: '8',
                reason: 'Conteo físico'
            })
        });
        assert.equal(adjRes.status, 201);
        const adjBody = await adjRes.json();
        assert.equal(adjBody.product.stock, 8);
        assert.equal(adjBody.movement.delta, -3);

        // 7. Update product metadata without stock change -> no new movement
        const editMetaRes = await fetch(`${ctx.baseUrl}/api/products/${productId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sku: 'TEC-001',
                name: 'Teclado Mecánico RGB',
                category: 'Periféricos',
                price: '49000',
                stock: '8',
                minStock: '3'
            })
        });
        assert.equal(editMetaRes.status, 200);
        const editMetaBody = await editMetaRes.json();
        assert.equal(editMetaBody.movement, null);

        // 8. Accounting invariant: sum(delta) === live stock (10 + 5 - 4 - 3 = 8)
        const movRes = await fetch(`${ctx.baseUrl}/api/movements?productId=${productId}`);
        const movBody = await movRes.json();
        assert.equal(movBody.movements.length, 4);
        const deltaSum = movBody.movements.reduce((acc, m) => acc + m.delta, 0);
        assert.equal(deltaSum, 8);

        // 9. Delete product -> logs final OUT closure movement & preserves Kardex audit history
        const delRes = await fetch(`${ctx.baseUrl}/api/products/${productId}`, { method: 'DELETE' });
        assert.equal(delRes.status, 200);

        const listRes = await fetch(`${ctx.baseUrl}/api/products`);
        assert.deepEqual((await listRes.json()).products, []);

        const allMovementsRes = await fetch(`${ctx.baseUrl}/api/movements`);
        const allMovements = (await allMovementsRes.json()).movements;
        assert.equal(allMovements.length, 5);
        assert.equal(allMovements[0].productId, null);
        assert.equal(allMovements[0].productSku, 'TEC-001');
        assert.equal(allMovements[0].delta, -8);
        assert.equal(allMovements.reduce((acc, m) => acc + m.delta, 0), 0);
    } finally {
        await ctx.close();
    }
});

test('api: static file allowlist protects server, database, package.json, and traversal', async () => {
    const ctx = await createTestContext();
    try {
        const okIndex = await rawHttpGet(ctx.port, '/');
        assert.equal(okIndex.status, 200);
        assert.match(okIndex.headers['content-type'], /text\/html/);

        const okCss = await rawHttpGet(ctx.port, '/styles.css');
        assert.equal(okCss.status, 200);
        assert.match(okCss.headers['content-type'], /text\/css/);

        const okJs = await rawHttpGet(ctx.port, '/src/main.js');
        assert.equal(okJs.status, 200);
        assert.match(okJs.headers['content-type'], /text\/javascript/);

        for (const blockedPath of [
            '/data/erp.db',
            '/server/db.js',
            '/package.json',
            '/tests/domain.test.js',
            '/../package.json'
        ]) {
            const blocked = await rawHttpGet(ctx.port, blockedPath);
            assert.equal(blocked.status, 403, `Expected 403 for ${blockedPath}`);
        }

        const missing = await rawHttpGet(ctx.port, '/src/does-not-exist.js');
        assert.equal(missing.status, 404);
    } finally {
        await ctx.close();
    }
});

