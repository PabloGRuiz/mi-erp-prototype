import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    createGeminiExtractor,
    isSupportedExtractionModel,
    parseRetryAfterMs,
    rankGeminiModels
} from '../server/ai/geminiExtractor.js';
import { createAuthStore } from '../server/authStore.js';
import { createDatabase } from '../server/db.js';
import { loadEnvFile } from '../server/env.js';
import { createIntakeStore } from '../server/intakeStore.js';
import { createInventoryStore } from '../server/inventoryStore.js';
import { createOperationsStore } from '../server/operationsStore.js';
import { createAppHandler } from '../server/router.js';

const STATIC_ROOT = path.resolve(import.meta.dirname, '..');

function extractSessionCookie(res) {
    const rawCookie = res.headers.get('set-cookie');
    assert.ok(rawCookie, 'Expected Set-Cookie header');
    return rawCookie.split(';')[0];
}

test('etapa4 env loader: parses .env without overwriting existing process.env vars', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-env-'));
    const envPath = path.join(tmpDir, '.env');
    const prevTestVar = process.env.ERP_TEST_PRESET;
    const prevLoadedVar = process.env.ERP_TEST_FROM_FILE;

    try {
        process.env.ERP_TEST_PRESET = 'host-value';
        delete process.env.ERP_TEST_FROM_FILE;

        fs.writeFileSync(
            envPath,
            '# comment line\nERP_TEST_PRESET=file-value\nERP_TEST_FROM_FILE="secret-key-123"\n',
            'utf8'
        );

        loadEnvFile(envPath);
        assert.equal(process.env.ERP_TEST_PRESET, 'host-value');
        assert.equal(process.env.ERP_TEST_FROM_FILE, 'secret-key-123');
    } finally {
        if (prevTestVar === undefined) delete process.env.ERP_TEST_PRESET;
        else process.env.ERP_TEST_PRESET = prevTestVar;
        if (prevLoadedVar === undefined) delete process.env.ERP_TEST_FROM_FILE;
        else process.env.ERP_TEST_FROM_FILE = prevLoadedVar;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('etapa4 geminiExtractor: uses x-goog-api-key header, multimodal PDF base64, and retries 429', async () => {
    const calls = [];
    let attempt = 0;

    const fakeFetch = async (url, init) => {
        attempt += 1;
        calls.push({ url, init });
        if (attempt === 1) {
            return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
                status: 429,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(
            JSON.stringify({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: JSON.stringify({
                                        documentType: 'PURCHASE',
                                        documentNumber: 'FC-A 0001-00000099',
                                        party: { name: 'Mayorista Norte', taxId: '30-71112223-4' },
                                        items: [{ sku: 'TEC-001', name: 'Teclado', quantity: 5, unitPrice: 15000 }],
                                        declaredTotal: 75000,
                                        confidence: 0.94
                                    })
                                }
                            ]
                        }
                    }
                ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    };

    const extractor = createGeminiExtractor({
        apiKey: 'secret-gemini-key',
        model: 'gemini-2.5-flash',
        fallbackModels: [],
        autoDiscover: false,
        fetchImpl: fakeFetch,
        retryDelayMs: 0
    });

    const initialStatus = extractor.getStatus();
    assert.equal(initialStatus.configured, true);
    assert.equal(initialStatus.provider, 'gemini');
    assert.equal(initialStatus.model, 'gemini-2.5-flash');

    const result = await extractor.extractInvoice({
        fileName: 'factura-99.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 mock'),
        documentTypeHint: 'PURCHASE',
        catalog: { products: [], suppliers: [], customers: [] }
    });

    assert.equal(calls.length, 2);
    assert.ok(!calls[0].url.includes('secret-gemini-key'));
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'secret-gemini-key');

    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
    assert.equal(sentBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(result.rawExtraction.documentNumber, 'FC-A 0001-00000099');
    assert.equal(result.rawExtraction.confidence, 0.94);
    assert.deepEqual(result.attemptedModels, ['gemini-2.5-flash']);
});

function buildOkGeminiResponse(docNum = 'FC-001') {
    return new Response(
        JSON.stringify({
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: JSON.stringify({
                                    documentType: 'PURCHASE',
                                    documentNumber: docNum,
                                    party: { name: 'Proveedor Demo SA', taxId: '30-71112223-4' },
                                    items: [{ sku: 'TEC-001', name: 'Teclado', quantity: 2, unitPrice: 1000 }],
                                    taxAmount: 0,
                                    declaredTotal: 2000,
                                    confidence: 0.96
                                })
                            }
                        ]
                    }
                }
            ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}

test('etapa4 model discovery: filters unsupported modalities and ranks compatible Gemini models', async () => {
    assert.equal(isSupportedExtractionModel('models/gemini-3.8-flash'), true);
    assert.equal(isSupportedExtractionModel('gemini-2.5-flash-preview-tts'), false);
    assert.equal(isSupportedExtractionModel('gemini-2.5-flash-image'), false);
    assert.equal(isSupportedExtractionModel('gemini-3.5-transcribe'), false);
    assert.equal(isSupportedExtractionModel('gemini-robotics-er-2-preview'), false);
    assert.equal(isSupportedExtractionModel('gemini-omni-flash-preview'), false);
    assert.equal(isSupportedExtractionModel('gemma-4-31b-it'), false);
    assert.equal(isSupportedExtractionModel('lyria-3.5'), false);

    assert.equal(parseRetryAfterMs('Please retry in 17h52m55.5s.'), Math.ceil((17 * 3600 + 52 * 60 + 55.5) * 1000));
    assert.equal(parseRetryAfterMs('', { 'Retry-After': '45' }), 45000);

    const ranked = rankGeminiModels(
        ['gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-flash-latest'],
        ['gemini-3.7-flash']
    );
    assert.deepEqual(ranked, [
        'gemini-3.7-flash',
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-flash-latest',
        'gemini-3.1-pro-preview'
    ]);

    const fakeFetch = async (url) => {
        assert.match(url, /\/v1beta\/models\?pageSize=100$/);
        return new Response(
            JSON.stringify({
                models: [
                    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/lyria-3.5', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-robotics-er-2-preview', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-omni-1.2-flash', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-embed-no-gen', supportedGenerationMethods: ['embedContent'] },
                    { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
                    { name: 'models/gemini-3.9-flash', supportedGenerationMethods: ['generateContent'] }
                ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    };

    const extractor = createGeminiExtractor({
        apiKey: 'key-123',
        model: 'gemini-3.8-flash',
        fallbackModels: [],
        autoDiscover: true,
        fetchImpl: fakeFetch
    });

    const status = await extractor.refreshAvailableModels();
    assert.equal(status.configured, true);
    assert.ok(status.lastDiscoveryAt);
    assert.deepEqual(
        status.models.map((m) => m.model),
        ['gemini-3.8-flash', 'gemini-3.9-flash', 'gemini-3.6-flash']
    );
});

test('etapa4 model rotation: skips deprecated 404/400 models and marks them UNAVAILABLE', async () => {
    const calledModels = [];
    const fakeFetch = async (url) => {
        const modelMatch = /\/models\/([^:]+):generateContent/.exec(url);
        const model = decodeURIComponent(modelMatch[1]);
        calledModels.push(model);

        if (model === 'gemini-2.5-flash') {
            return new Response(
                JSON.stringify({ error: { message: 'This model models/gemini-2.5-flash is no longer available to new users.' } }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return buildOkGeminiResponse('FC-ROT-1');
    };

    const extractor = createGeminiExtractor({
        apiKey: 'key-123',
        model: 'gemini-2.5-flash',
        fallbackModels: ['gemini-3.8-flash'],
        autoDiscover: false,
        fetchImpl: fakeFetch
    });

    const res = await extractor.extractInvoice({
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4'),
        catalog: { products: [], suppliers: [], customers: [] }
    });

    assert.equal(res.model, 'gemini-3.8-flash');
    assert.deepEqual(res.attemptedModels, ['gemini-2.5-flash', 'gemini-3.8-flash']);
    assert.deepEqual(calledModels, ['gemini-2.5-flash', 'gemini-3.8-flash']);

    const status = extractor.getStatus();
    assert.equal(status.model, 'gemini-3.8-flash');
    assert.equal(status.models.find((m) => m.model === 'gemini-2.5-flash').status, 'UNAVAILABLE');
});

test('etapa4 model rotation: rotates on daily 429 quota and skips exhausted model on subsequent calls', async () => {
    let now = 1_700_000_000_000;
    const calledModels = [];

    const fakeFetch = async (url) => {
        const model = decodeURIComponent(/\/models\/([^:]+):generateContent/.exec(url)[1]);
        calledModels.push(model);

        if (model === 'gemini-3.8-flash') {
            return new Response(
                JSON.stringify({
                    error: {
                        message:
                            'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, per day. Please retry in 17h50m0s.'
                    }
                }),
                { status: 429, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return buildOkGeminiResponse('FC-ROT-2');
    };

    const extractor = createGeminiExtractor({
        apiKey: 'key-123',
        model: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash'],
        autoDiscover: false,
        fetchImpl: fakeFetch,
        nowFn: () => now
    });

    const first = await extractor.extractInvoice({
        fileName: '1.txt',
        mimeType: 'text/plain',
        textContent: 'hola',
        buffer: Buffer.from('hola'),
        catalog: { products: [], suppliers: [], customers: [] }
    });
    assert.equal(first.model, 'gemini-3.7-flash');
    assert.equal(extractor.getStatus().models.find((m) => m.model === 'gemini-3.8-flash').status, 'QUOTA_EXCEEDED');

    const second = await extractor.extractInvoice({
        fileName: '2.txt',
        mimeType: 'text/plain',
        textContent: 'hola2',
        buffer: Buffer.from('hola2'),
        catalog: { products: [], suppliers: [], customers: [] }
    });
    assert.equal(second.model, 'gemini-3.7-flash');
    // Zero wasted calls on gemini-3.8-flash on second request
    assert.deepEqual(calledModels, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.7-flash']);
});

test('etapa4 model rotation: rotates immediately on 503 high demand (COOLDOWN)', async () => {
    const calledModels = [];
    const fakeFetch = async (url) => {
        const model = decodeURIComponent(/\/models\/([^:]+):generateContent/.exec(url)[1]);
        calledModels.push(model);
        if (model === 'gemini-3.8-flash') {
            return new Response(
                JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return buildOkGeminiResponse('FC-503-OK');
    };

    const extractor = createGeminiExtractor({
        apiKey: 'key-123',
        model: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.6-flash'],
        autoDiscover: false,
        fetchImpl: fakeFetch
    });

    const res = await extractor.extractInvoice({
        fileName: '1.txt',
        mimeType: 'text/plain',
        textContent: 'factura',
        buffer: Buffer.from('factura'),
        catalog: { products: [], suppliers: [], customers: [] }
    });

    assert.equal(res.model, 'gemini-3.6-flash');
    assert.deepEqual(calledModels, ['gemini-3.8-flash', 'gemini-3.6-flash']);
    assert.equal(extractor.getStatus().models.find((m) => m.model === 'gemini-3.8-flash').status, 'COOLDOWN');
});

test('etapa4 model rotation: fatal 401 auth error fails fast without rotating', async () => {
    let calls = 0;
    const fakeFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    const extractor = createGeminiExtractor({
        apiKey: 'bad-key',
        model: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
        autoDiscover: false,
        fetchImpl: fakeFetch
    });

    await assert.rejects(
        () =>
            extractor.extractInvoice({
                fileName: '1.txt',
                mimeType: 'text/plain',
                textContent: 'hola',
                buffer: Buffer.from('hola'),
                catalog: { products: [], suppliers: [], customers: [] }
            }),
        (err) => err?.code === 'AI_AUTH_ERROR' && err?.status === 502
    );
    assert.equal(calls, 1);
});

test('etapa4 model rotation: throws AI_ALL_MODELS_UNAVAILABLE and batch short-circuits remaining items', async () => {
    let fetchCalls = 0;
    const fakeFetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ error: { message: 'Quota exceeded per day' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    const extractor = createGeminiExtractor({
        apiKey: 'key-123',
        model: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash'],
        autoDiscover: false,
        fetchImpl: fakeFetch
    });

    const db = createDatabase(':memory:');
    try {
        const store = createInventoryStore(db);
        const operationsStore = createOperationsStore(db);
        const intakeStore = createIntakeStore(db, { inventoryStore: store, operationsStore });

        const enqueued = intakeStore.enqueueBatch([
            { fileName: 'f1.txt', mimeType: 'text/plain', textContent: 'doc 1' },
            { fileName: 'f2.txt', mimeType: 'text/plain', textContent: 'doc 2' },
            { fileName: 'f3.txt', mimeType: 'text/plain', textContent: 'doc 3' }
        ]);

        const results = await intakeStore.processBatch(enqueued.payloadsForProcessing, extractor);
        assert.equal(fetchCalls, 2); // Only tried 2 models on first item, aborted remaining 2 items!
        assert.equal(results.length, 3);
        for (const r of results) {
            assert.equal(r.status, 'ERROR');
            assert.match(r.errorMessage, /Ningún modelo de Gemini pudo procesar/);
        }
    } finally {
        db.close();
    }
});

test('etapa4 duplicates: re-uploading a file whose previous intake is in ERROR does not flag duplicate', async () => {
    const db = createDatabase(':memory:');
    try {
        const store = createInventoryStore(db);
        const operationsStore = createOperationsStore(db);
        const intakeStore = createIntakeStore(db, { inventoryStore: store, operationsStore });

        const failingExtractor = {
            async extractInvoice() {
                throw new Error('Falla temporal');
            }
        };
        const workingExtractor = {
            async extractInvoice() {
                return {
                    provider: 'gemini',
                    model: 'gemini-3.8-flash',
                    rawExtraction: {
                        documentType: 'PURCHASE',
                        party: { name: 'Prov' },
                        items: [],
                        confidence: 0.9
                    }
                };
            }
        };

        const batch1 = intakeStore.enqueueBatch([
            { fileName: 'factura.txt', mimeType: 'text/plain', textContent: 'FACTURA UNICA 123' }
        ]);
        const [firstRun] = await intakeStore.processBatch(batch1.payloadsForProcessing, failingExtractor);
        assert.equal(firstRun.status, 'ERROR');
        assert.equal(firstRun.duplicateOfId, null);

        const batch2 = intakeStore.enqueueBatch([
            { fileName: 'factura.txt', mimeType: 'text/plain', textContent: 'FACTURA UNICA 123' }
        ]);
        const [secondRun] = await intakeStore.processBatch(batch2.payloadsForProcessing, workingExtractor);
        assert.equal(secondRun.status, 'READY_FOR_REVIEW');
        assert.equal(secondRun.duplicateOfId, null);
    } finally {
        db.close();
    }
});

test('etapa4 migration: upgrades Etapa 3 DB (user_version = 2) non-destructively to user_version 3', () => {
    const tempDbPath = path.join(os.tmpdir(), `erp-mig-v3-${crypto.randomUUID()}.db`);

    try {
        const dbV2 = new DatabaseSync(tempDbPath);
        dbV2.exec(`
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General', price_cents INTEGER NOT NULL,
                stock INTEGER NOT NULL, min_stock INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE stock_movements (
                id TEXT PRIMARY KEY, product_id TEXT, product_sku TEXT NOT NULL, product_name TEXT NOT NULL,
                type TEXT NOT NULL, quantity INTEGER NOT NULL, delta INTEGER NOT NULL,
                previous_stock INTEGER NOT NULL, resulting_stock INTEGER NOT NULL,
                reason TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '',
                unit_price_cents INTEGER NOT NULL, user_id TEXT, actor_username TEXT NOT NULL DEFAULT 'sistema',
                created_at TEXT NOT NULL
            );
            INSERT INTO products VALUES ('p1', 'OLD-1', 'Viejo', 'General', 5000, 3, 1, '2026-11-19T10:00:00Z', '2026-11-19T10:00:00Z');
            PRAGMA user_version = 2;
        `);
        dbV2.close();

        const upgradedDb = createDatabase(tempDbPath);
        try {
            assert.equal(upgradedDb.prepare('PRAGMA user_version').get().user_version, 3);
            const tableExists = upgradedDb
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_intakes'")
                .get();
            assert.equal(tableExists?.name, 'document_intakes');
            assert.equal(upgradedDb.prepare('SELECT COUNT(*) AS c FROM products').get().c, 1);
        } finally {
            upgradedDb.close();
        }
    } finally {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${tempDbPath}${suffix}`, { force: true });
        }
    }
});

test('etapa4 batch intake E2E: staging, duplicate detection, partial error, human edit, ACID approval, and RBAC', async () => {
    const db = createDatabase(':memory:');
    const store = createInventoryStore(db);
    const authStore = createAuthStore(db);
    const operationsStore = createOperationsStore(db);
    const intakeStore = createIntakeStore(db, { inventoryStore: store, operationsStore });

    const mockAiExtractor = {
        getStatus() {
            return { configured: true, provider: 'gemini', model: 'gemini-2.5-flash' };
        },
        async extractInvoice({ fileName }) {
            if (fileName.includes('corrupt')) {
                throw new Error('Imagen ilegible por el modelo');
            }
            if (fileName.includes('venta-exceso')) {
                return {
                    provider: 'gemini',
                    model: 'gemini-2.5-flash',
                    rawExtraction: {
                        documentType: 'SALE',
                        documentNumber: 'PED-900',
                        party: { name: 'Consumidor' },
                        items: [{ sku: 'TEC-001', name: 'Teclado Base', quantity: 99, unitPrice: 30000 }],
                        declaredTotal: 2970000,
                        confidence: 0.85
                    }
                };
            }
            return {
                provider: 'gemini',
                model: 'gemini-2.5-flash',
                rawExtraction: {
                    documentType: 'PURCHASE',
                    documentNumber: 'FC-A 0001-00000501',
                    issueDate: '2026-11-20',
                    party: { name: 'Distribuidora Sur SA', taxId: '30-70999888-1' },
                    items: [
                        { sku: 'TEC-001', name: 'Teclado Base', quantity: 4, unitPrice: 12000 },
                        { sku: 'MOU-NEW', name: 'Mouse Inalambrico', quantity: 6, unitPrice: 5000 }
                    ],
                    declaredTotal: 78000,
                    confidence: 0.92
                }
            };
        }
    };

    const handler = createAppHandler({
        store,
        authStore,
        operationsStore,
        intakeStore,
        aiExtractor: mockAiExtractor,
        staticRoot: STATIC_ROOT
    });

    const server = http.createServer((req, res) => {
        void handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
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

    try {
        const setupRes = await api('/api/auth/setup', {
            method: 'POST',
            body: { fullName: 'Admin ERP', username: 'admin', password: 'AdminPassword1!' }
        });
        const adminCookie = extractSessionCookie(setupRes.res);

        await api('/api/users', {
            method: 'POST',
            cookie: adminCookie,
            body: { username: 'aud1', fullName: 'Auditor', role: 'AUDITOR', password: 'AuditorPassword1!' }
        });
        const audLogin = await api('/api/auth/login', {
            method: 'POST',
            body: { username: 'aud1', password: 'AuditorPassword1!' }
        });
        const audCookie = extractSessionCookie(audLogin.res);

        // Seed 1 existing product (TEC-001, stock 2)
        const prodRes = await api('/api/products', {
            method: 'POST',
            cookie: adminCookie,
            body: { sku: 'TEC-001', name: 'Teclado Base', category: 'Periféricos', price: '30000', stock: '2', minStock: '2' }
        });
        const existingProdId = prodRes.data.product.id;

        // Upload batch of 4 docs: valid invoice, exact duplicate, sale exceeding stock, and unreadable file
        const sameInvoiceText = 'Factura FC-A 0001-00000501 Distribuidora Sur SA 4x TEC-001 6x MOU-NEW';
        const uploadRes = await api('/api/intake/upload?wait=true', {
            method: 'POST',
            cookie: adminCookie,
            body: {
                documents: [
                    { fileName: 'factura-1.txt', mimeType: 'text/plain', documentTypeHint: 'PURCHASE', textContent: sameInvoiceText },
                    { fileName: 'factura-1-copia.txt', mimeType: 'text/plain', documentTypeHint: 'PURCHASE', textContent: sameInvoiceText },
                    { fileName: 'venta-exceso.txt', mimeType: 'text/plain', documentTypeHint: 'SALE', textContent: 'Pedido 99x TEC-001' },
                    { fileName: 'corrupt-scan.pdf', mimeType: 'application/pdf', documentTypeHint: 'PURCHASE', contentBase64: Buffer.from('%PDF-broken').toString('base64') }
                ]
            }
        });

        assert.equal(uploadRes.status, 201);
        assert.equal(uploadRes.data.intakes.length, 4);

        const [okIntake, dupIntake, overSaleIntake, errIntake] = uploadRes.data.intakes;
        assert.equal(okIntake.status, 'READY_FOR_REVIEW');
        assert.equal(okIntake.duplicateOfId, null);
        assert.equal(dupIntake.status, 'READY_FOR_REVIEW');
        assert.equal(dupIntake.duplicateOfId, okIntake.id);
        assert.equal(overSaleIntake.status, 'READY_FOR_REVIEW');
        assert.equal(errIntake.status, 'ERROR');
        assert.match(errIntake.errorMessage, /ilegible/);

        // ZERO catalog/stock mutation before human approval
        assert.equal((await api('/api/products', { cookie: adminCookie })).data.products.length, 1);
        assert.equal((await api('/api/purchases', { cookie: adminCookie })).data.purchases.length, 0);

        // RBAC: AUDITOR can read queue, cannot upload/edit/approve/reject/refresh
        assert.equal((await api('/api/intake', { cookie: audCookie })).status, 200);
        assert.equal((await api('/api/ai/refresh', { method: 'POST', cookie: audCookie })).status, 403);
        const adminRefresh = await api('/api/ai/refresh', { method: 'POST', cookie: adminCookie });
        assert.equal(adminRefresh.status, 200);
        assert.equal(adminRefresh.data.configured, true);
        assert.equal(
            (await api('/api/intake/upload', {
                method: 'POST',
                cookie: audCookie,
                body: { documents: [{ fileName: 'a.txt', mimeType: 'text/plain', textContent: 'hola' }] }
            })).status,
            403
        );
        assert.equal((await api(`/api/intake/${okIntake.id}/approve`, { method: 'POST', cookie: audCookie })).status, 403);

        // Edit review payload before approving (adjust salePrice on new SKU MOU-NEW)
        const updatedPayload = {
            ...okIntake.reviewPayload,
            items: okIntake.reviewPayload.items.map((item) =>
                item.sku === 'MOU-NEW' ? { ...item, salePrice: '12500.00' } : item
            )
        };
        const editRes = await api(`/api/intake/${okIntake.id}`, {
            method: 'PUT',
            cookie: adminCookie,
            body: updatedPayload
        });
        assert.equal(editRes.status, 200);

        // Approve okIntake -> ACID creates Supplier, MOU-NEW product, OC-00001, and Kardex IN entries
        const approveRes = await api(`/api/intake/${okIntake.id}/approve`, {
            method: 'POST',
            cookie: adminCookie
        });
        assert.equal(approveRes.status, 200);
        assert.equal(approveRes.data.intake.status, 'APPROVED');
        assert.equal(approveRes.data.intake.approvedOrderNumber, 'OC-00001');
        assert.equal(approveRes.data.createdParty.name, 'Distribuidora Sur SA');
        assert.equal(approveRes.data.createdProducts.length, 1);
        assert.equal(approveRes.data.createdProducts[0].sku, 'MOU-NEW');

        // Verify live stock and accounting invariant sum(delta) === stock
        const allProds = (await api('/api/products', { cookie: adminCookie })).data.products;
        const tec = allProds.find((p) => p.id === existingProdId);
        const mou = allProds.find((p) => p.sku === 'MOU-NEW');
        assert.equal(tec.stock, 6); // 2 + 4
        assert.equal(mou.stock, 6); // 0 + 6
        assert.equal(mou.priceCents, 1250000);

        const tecMovements = (await api(`/api/movements?productId=${tec.id}`, { cookie: adminCookie })).data.movements;
        assert.equal(tecMovements.reduce((acc, m) => acc + m.delta, 0), 6);

        // Reject duplicate and attempt batch approval on remaining ready intake (overSaleIntake fails 409 rollback)
        const rejectDup = await api(`/api/intake/${dupIntake.id}/reject`, {
            method: 'POST',
            cookie: adminCookie
        });
        assert.equal(rejectDup.status, 200);
        assert.equal(rejectDup.data.intake.status, 'REJECTED');

        const batchApprove = await api('/api/intake/approve-batch', {
            method: 'POST',
            cookie: adminCookie,
            body: { ids: [overSaleIntake.id] }
        });
        assert.equal(batchApprove.status, 200);
        assert.equal(batchApprove.data.approved.length, 0);
        assert.equal(batchApprove.data.failed.length, 1);
        assert.equal(batchApprove.data.failed[0].code, 'INSUFFICIENT_STOCK');
        assert.equal((await api(`/api/intake/${overSaleIntake.id}`, { cookie: adminCookie })).data.intake.status, 'READY_FOR_REVIEW');

        // RBAC + bulk error dismissal: AUDITOR 403, ADMIN rejects only ERROR rows
        assert.equal((await api('/api/intake/reject-errors', { method: 'POST', cookie: audCookie })).status, 403);
        const rejectErrorsRes = await api('/api/intake/reject-errors', { method: 'POST', cookie: adminCookie });
        assert.equal(rejectErrorsRes.status, 200);
        assert.equal(rejectErrorsRes.data.rejectedCount, 1);
        assert.equal(rejectErrorsRes.data.stats.error, 0);
        assert.equal((await api(`/api/intake/${errIntake.id}`, { cookie: adminCookie })).data.intake.status, 'REJECTED');
        assert.equal((await api(`/api/intake/${overSaleIntake.id}`, { cookie: adminCookie })).data.intake.status, 'READY_FOR_REVIEW');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        db.close();
    }
});

