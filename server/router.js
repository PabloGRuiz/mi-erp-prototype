import fs from 'node:fs/promises';
import path from 'node:path';
import { canPerform } from '../src/domain/auth.js';
import {
    buildClearSessionCookie,
    buildSessionCookie,
    parseCookies,
    SESSION_COOKIE_NAME
} from './auth.js';
import { DomainError } from './inventoryStore.js';

const MAX_JSON_BODY_BYTES = 65536;
const MAX_INTAKE_BODY_BYTES = 25 * 1024 * 1024;

const MIME_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8']
]);

const PROTECTED_PREFIXES = ['server/', 'data/', 'tests/', '.git/'];
const PROTECTED_FILES = new Set([
    'package.json',
    'package-lock.json',
    '.gitignore',
    '.env',
    '.env.example',
    'README.md'
]);

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
};

function sendJson(res, status, payload, extraHeaders = {}) {
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        ...extraHeaders
    });
    res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end(text);
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
            throw new DomainError('El cuerpo de la solicitud supera el límite permitido.', {
                status: 413,
                code: 'PAYLOAD_TOO_LARGE'
            });
        }
        chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (!rawBody) {
        return {};
    }

    try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new DomainError('El JSON debe representar un objeto.', {
                status: 400,
                code: 'INVALID_JSON'
            });
        }
        return parsed;
    } catch (error) {
        if (error instanceof DomainError) {
            throw error;
        }
        throw new DomainError('JSON malformado en el cuerpo de la solicitud.', {
            status: 400,
            code: 'INVALID_JSON'
        });
    }
}

function isAllowedStaticRelativePath(relPath) {
    if (relPath === 'index.html' || relPath === 'styles.css') {
        return true;
    }

    return relPath.startsWith('src/') && path.extname(relPath).toLowerCase() === '.js';
}

function isProtectedRelativePath(relPath) {
    if (PROTECTED_FILES.has(relPath) || relPath.startsWith('.env')) {
        return true;
    }
    return PROTECTED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Builds the combined REST API (with Auth, RBAC & AI Intake) + allowlisted static asset handler.
 * @param {{
 *   store: ReturnType<import('./inventoryStore.js').createInventoryStore>,
 *   authStore: ReturnType<import('./authStore.js').createAuthStore>,
 *   operationsStore: ReturnType<import('./operationsStore.js').createOperationsStore>,
 *   intakeStore?: ReturnType<import('./intakeStore.js').createIntakeStore>,
 *   aiExtractor?: ReturnType<import('./ai/geminiExtractor.js').createGeminiExtractor>,
 *   staticRoot: string
 * }} options
 */
export function createAppHandler({
    store,
    authStore,
    operationsStore,
    intakeStore = null,
    aiExtractor = null,
    staticRoot
}) {
    const normalizedRoot = path.resolve(staticRoot);
    const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;

    function getRequestToken(req) {
        const cookies = parseCookies(req.headers.cookie);
        return cookies[SESSION_COOKIE_NAME] ?? '';
    }

    function requireAuth(req, res, permission = null) {
        const token = getRequestToken(req);
        const session = authStore.getSessionUser(token);

        if (!session) {
            const extraHeaders = token ? { 'Set-Cookie': buildClearSessionCookie() } : {};
            sendJson(
                res,
                401,
                {
                    error: 'Tenés que iniciar sesión para operar en el ERP.',
                    code: 'UNAUTHORIZED'
                },
                extraHeaders
            );
            return null;
        }

        if (permission && !canPerform(session.user.role, permission)) {
            sendJson(res, 403, {
                error: 'No tenés permisos suficientes para realizar esta acción.',
                code: 'FORBIDDEN'
            });
            return null;
        }

        return session.user;
    }

    async function handleAuthRoutes(req, res, pathname) {
        if (req.method === 'GET' && pathname === '/api/auth/status') {
            const token = getRequestToken(req);
            const session = authStore.getSessionUser(token);
            const extraHeaders = token && !session ? { 'Set-Cookie': buildClearSessionCookie() } : {};
            sendJson(
                res,
                200,
                {
                    initialized: authStore.hasUsers(),
                    authenticated: Boolean(session),
                    user: session?.user ?? null
                },
                extraHeaders
            );
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/setup') {
            const body = await readJsonBody(req);
            const result = authStore.setupInitialAdmin(body);
            sendJson(
                res,
                201,
                { user: result.user },
                { 'Set-Cookie': buildSessionCookie(result.sessionToken) }
            );
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/login') {
            const body = await readJsonBody(req);
            const result = authStore.login(body);
            sendJson(
                res,
                200,
                { user: result.user },
                { 'Set-Cookie': buildSessionCookie(result.sessionToken) }
            );
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
            authStore.logout(getRequestToken(req));
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': buildClearSessionCookie() });
            return true;
        }

        return false;
    }

    async function handleInventoryRoutes(req, res, pathname, searchParams) {
        if (req.method === 'GET' && pathname === '/api/products') {
            if (!requireAuth(req, res, 'inventory:read')) return true;
            sendJson(res, 200, { products: store.listProducts() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/products') {
            const actor = requireAuth(req, res, 'inventory:write');
            if (!actor) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, store.createProduct(body, actor));
            return true;
        }

        const productMatch = /^\/api\/products\/([^/]+)$/.exec(pathname);
        if (productMatch) {
            const productId = decodeURIComponent(productMatch[1]);

            if (req.method === 'GET') {
                if (!requireAuth(req, res, 'inventory:read')) return true;
                const product = store.getProductById(productId);
                if (!product) {
                    sendJson(res, 404, { error: 'Producto no encontrado.', code: 'PRODUCT_NOT_FOUND' });
                    return true;
                }
                sendJson(res, 200, { product });
                return true;
            }

            if (req.method === 'PUT') {
                const actor = requireAuth(req, res, 'inventory:write');
                if (!actor) return true;
                const body = await readJsonBody(req);
                sendJson(res, 200, store.updateProduct(productId, body, actor));
                return true;
            }

            if (req.method === 'DELETE') {
                const actor = requireAuth(req, res, 'inventory:delete');
                if (!actor) return true;
                sendJson(res, 200, store.deleteProduct(productId, actor));
                return true;
            }
        }

        if (req.method === 'GET' && pathname === '/api/movements') {
            if (!requireAuth(req, res, 'inventory:read')) return true;
            const movements = store.listMovements({
                productId: searchParams.get('productId') ?? '',
                type: searchParams.get('type') ?? '',
                limit: searchParams.get('limit') ?? '200'
            });
            sendJson(res, 200, { movements });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/movements') {
            const actor = requireAuth(req, res, 'inventory:write');
            if (!actor) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, store.recordMovement(body, actor));
            return true;
        }

        return false;
    }

    async function handleOperationsRoutes(req, res, pathname) {
        if (req.method === 'GET' && pathname === '/api/suppliers') {
            if (!requireAuth(req, res, 'purchases:read')) return true;
            sendJson(res, 200, { suppliers: operationsStore.listSuppliers() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/suppliers') {
            if (!requireAuth(req, res, 'purchases:write')) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, { supplier: operationsStore.createSupplier(body) });
            return true;
        }

        const supplierMatch = /^\/api\/suppliers\/([^/]+)$/.exec(pathname);
        if (supplierMatch && req.method === 'PUT') {
            if (!requireAuth(req, res, 'purchases:write')) return true;
            const supplierId = decodeURIComponent(supplierMatch[1]);
            const body = await readJsonBody(req);
            sendJson(res, 200, { supplier: operationsStore.updateSupplier(supplierId, body) });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/purchases') {
            if (!requireAuth(req, res, 'purchases:read')) return true;
            sendJson(res, 200, { purchases: operationsStore.listPurchases() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/purchases') {
            const actor = requireAuth(req, res, 'purchases:write');
            if (!actor) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, { purchase: operationsStore.createPurchase(body, actor) });
            return true;
        }

        const receiveMatch = /^\/api\/purchases\/([^/]+)\/receive$/.exec(pathname);
        if (receiveMatch && req.method === 'POST') {
            const actor = requireAuth(req, res, 'purchases:write');
            if (!actor) return true;
            const purchaseId = decodeURIComponent(receiveMatch[1]);
            sendJson(res, 200, { purchase: operationsStore.receivePurchase(purchaseId, actor) });
            return true;
        }

        const cancelPurchaseMatch = /^\/api\/purchases\/([^/]+)\/cancel$/.exec(pathname);
        if (cancelPurchaseMatch && req.method === 'POST') {
            if (!requireAuth(req, res, 'purchases:cancel')) return true;
            const purchaseId = decodeURIComponent(cancelPurchaseMatch[1]);
            sendJson(res, 200, { purchase: operationsStore.cancelPurchase(purchaseId) });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/customers') {
            if (!requireAuth(req, res, 'sales:read')) return true;
            sendJson(res, 200, { customers: operationsStore.listCustomers() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/customers') {
            if (!requireAuth(req, res, 'sales:write')) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, { customer: operationsStore.createCustomer(body) });
            return true;
        }

        const customerMatch = /^\/api\/customers\/([^/]+)$/.exec(pathname);
        if (customerMatch && req.method === 'PUT') {
            if (!requireAuth(req, res, 'sales:write')) return true;
            const customerId = decodeURIComponent(customerMatch[1]);
            const body = await readJsonBody(req);
            sendJson(res, 200, { customer: operationsStore.updateCustomer(customerId, body) });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/sales') {
            if (!requireAuth(req, res, 'sales:read')) return true;
            sendJson(res, 200, { sales: operationsStore.listSales() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/sales') {
            const actor = requireAuth(req, res, 'sales:write');
            if (!actor) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, { sale: operationsStore.createSale(body, actor) });
            return true;
        }

        const cancelSaleMatch = /^\/api\/sales\/([^/]+)\/cancel$/.exec(pathname);
        if (cancelSaleMatch && req.method === 'POST') {
            const actor = requireAuth(req, res, 'sales:cancel');
            if (!actor) return true;
            const saleId = decodeURIComponent(cancelSaleMatch[1]);
            sendJson(res, 200, { sale: operationsStore.cancelSale(saleId, actor) });
            return true;
        }

        return false;
    }

    async function handleIntakeRoutes(req, res, pathname, searchParams) {
        if (req.method === 'GET' && pathname === '/api/ai/status') {
            if (!requireAuth(req, res, 'intake:read')) return true;
            if (!aiExtractor) {
                sendJson(res, 200, {
                    configured: false,
                    provider: 'gemini',
                    model: '',
                    preferredModel: '',
                    autoRotate: false,
                    availableCount: 0,
                    totalModels: 0,
                    lastDiscoveryAt: null,
                    models: []
                });
                return true;
            }
            const forceRefresh = searchParams.get('refresh') === 'true';
            if (
                typeof aiExtractor.refreshAvailableModels === 'function' &&
                (forceRefresh || !aiExtractor.getStatus().lastDiscoveryAt)
            ) {
                await aiExtractor.refreshAvailableModels({ force: forceRefresh });
            }
            sendJson(res, 200, aiExtractor.getStatus());
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/ai/refresh') {
            if (!requireAuth(req, res, 'intake:write')) return true;
            if (!aiExtractor) {
                sendJson(res, 200, {
                    configured: false,
                    provider: 'gemini',
                    model: '',
                    preferredModel: '',
                    autoRotate: false,
                    availableCount: 0,
                    totalModels: 0,
                    lastDiscoveryAt: null,
                    models: []
                });
                return true;
            }
            if (typeof aiExtractor.refreshAvailableModels === 'function') {
                await aiExtractor.refreshAvailableModels({ force: true, resetCooldowns: true });
            }
            sendJson(res, 200, aiExtractor.getStatus());
            return true;
        }

        if (!intakeStore) {
            return false;
        }

        if (req.method === 'GET' && pathname === '/api/intake') {
            if (!requireAuth(req, res, 'intake:read')) return true;
            const intakes = intakeStore.listIntakes({
                status: searchParams.get('status') ?? '',
                batchId: searchParams.get('batchId') ?? '',
                limit: searchParams.get('limit') ?? '100'
            });
            sendJson(res, 200, { intakes, stats: intakeStore.getStats() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/intake/upload') {
            const actor = requireAuth(req, res, 'intake:write');
            if (!actor) return true;
            const body = await readJsonBody(req, MAX_INTAKE_BODY_BYTES);
            const enqueued = intakeStore.enqueueBatch(body.documents, actor);
            const processPromise = intakeStore.processBatch(enqueued.payloadsForProcessing, aiExtractor);

            if (searchParams.get('wait') === 'true') {
                const updatedIntakes = await processPromise;
                sendJson(res, 201, {
                    batchId: enqueued.batchId,
                    intakes: updatedIntakes,
                    stats: intakeStore.getStats()
                });
                return true;
            }

            void processPromise;
            sendJson(res, 202, {
                batchId: enqueued.batchId,
                intakes: enqueued.intakes,
                stats: intakeStore.getStats()
            });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/intake/approve-batch') {
            const actor = requireAuth(req, res, 'intake:approve');
            if (!actor) return true;
            const body = await readJsonBody(req);
            sendJson(res, 200, intakeStore.approveBatch(body.ids, actor));
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/intake/reject-errors') {
            const actor = requireAuth(req, res, 'intake:write');
            if (!actor) return true;
            const result = intakeStore.rejectAllErrors(actor);
            sendJson(res, 200, {
                rejectedCount: result.rejectedCount,
                stats: intakeStore.getStats()
            });
            return true;
        }

        const approveMatch = /^\/api\/intake\/([^/]+)\/approve$/.exec(pathname);
        if (approveMatch && req.method === 'POST') {
            const actor = requireAuth(req, res, 'intake:approve');
            if (!actor) return true;
            const intakeId = decodeURIComponent(approveMatch[1]);
            sendJson(res, 200, intakeStore.approveIntake(intakeId, actor));
            return true;
        }

        const rejectMatch = /^\/api\/intake\/([^/]+)\/reject$/.exec(pathname);
        if (rejectMatch && req.method === 'POST') {
            const actor = requireAuth(req, res, 'intake:write');
            if (!actor) return true;
            const intakeId = decodeURIComponent(rejectMatch[1]);
            sendJson(res, 200, { intake: intakeStore.rejectIntake(intakeId, actor) });
            return true;
        }

        const intakeMatch = /^\/api\/intake\/([^/]+)$/.exec(pathname);
        if (intakeMatch) {
            const intakeId = decodeURIComponent(intakeMatch[1]);

            if (req.method === 'GET') {
                if (!requireAuth(req, res, 'intake:read')) return true;
                const intake = intakeStore.getIntakeById(intakeId);
                if (!intake) {
                    sendJson(res, 404, {
                        error: 'Registro de ingesta no encontrado.',
                        code: 'INTAKE_NOT_FOUND'
                    });
                    return true;
                }
                sendJson(res, 200, { intake });
                return true;
            }

            if (req.method === 'PUT') {
                const actor = requireAuth(req, res, 'intake:write');
                if (!actor) return true;
                const body = await readJsonBody(req);
                sendJson(res, 200, { intake: intakeStore.updateIntakeReview(intakeId, body, actor) });
                return true;
            }
        }

        return false;
    }

    async function handleUserRoutes(req, res, pathname) {
        if (req.method === 'GET' && pathname === '/api/users') {
            if (!requireAuth(req, res, 'users:manage')) return true;
            sendJson(res, 200, { users: authStore.listUsers() });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/users') {
            if (!requireAuth(req, res, 'users:manage')) return true;
            const body = await readJsonBody(req);
            sendJson(res, 201, { user: authStore.createUser(body) });
            return true;
        }

        const userMatch = /^\/api\/users\/([^/]+)$/.exec(pathname);
        if (userMatch && req.method === 'PUT') {
            const actor = requireAuth(req, res, 'users:manage');
            if (!actor) return true;
            const userId = decodeURIComponent(userMatch[1]);
            const body = await readJsonBody(req);
            sendJson(res, 200, { user: authStore.updateUser(userId, body, actor) });
            return true;
        }

        return false;
    }

    async function handleApiRequest(req, res, pathname, searchParams) {
        try {
            if (req.method === 'GET' && pathname === '/api/health') {
                sendJson(res, 200, {
                    ok: true,
                    storage: 'sqlite',
                    version: 4,
                    aiConfigured: Boolean(aiExtractor?.getStatus().configured)
                });
                return;
            }

            if (await handleAuthRoutes(req, res, pathname)) return;
            if (await handleInventoryRoutes(req, res, pathname, searchParams)) return;
            if (await handleOperationsRoutes(req, res, pathname)) return;
            if (await handleIntakeRoutes(req, res, pathname, searchParams)) return;
            if (await handleUserRoutes(req, res, pathname)) return;

            sendJson(res, 404, { error: 'Ruta de API no encontrada.' });
        } catch (error) {
            if (error instanceof DomainError) {
                sendJson(res, error.status, {
                    error: error.message,
                    field: error.field,
                    code: error.code
                });
                return;
            }

            if (error && String(error.message).includes('UNIQUE constraint failed')) {
                sendJson(res, 409, {
                    error: 'Ya existe un registro con ese identificador único.',
                    code: 'UNIQUE_CONFLICT'
                });
                return;
            }

            sendJson(res, 500, { error: 'Error interno del servidor.' });
        }
    }

    async function handleStaticRequest(req, res, pathname) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendText(res, 405, 'Method Not Allowed');
            return;
        }

        const requested = pathname === '/' ? '/index.html' : pathname;
        const relativeInput = requested.replace(/^\/+/, '');
        const resolvedPath = path.resolve(normalizedRoot, relativeInput);

        if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(rootPrefix)) {
            sendText(res, 403, 'Forbidden');
            return;
        }

        const relPath = path.relative(normalizedRoot, resolvedPath).split(path.sep).join('/');

        if (!isAllowedStaticRelativePath(relPath)) {
            if (isProtectedRelativePath(relPath)) {
                sendText(res, 403, 'Forbidden');
                return;
            }
            sendText(res, 404, 'Not Found');
            return;
        }

        try {
            const stats = await fs.stat(resolvedPath);
            if (!stats.isFile()) {
                sendText(res, 404, 'Not Found');
                return;
            }

            const ext = path.extname(resolvedPath).toLowerCase();
            const contentType = MIME_TYPES.get(ext) ?? 'application/octet-stream';
            const body = req.method === 'HEAD' ? null : await fs.readFile(resolvedPath);

            res.writeHead(200, {
                ...SECURITY_HEADERS,
                'Content-Type': contentType
            });
            res.end(body);
        } catch (error) {
            if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
                sendText(res, 404, 'Not Found');
                return;
            }
            sendText(res, 500, 'Internal Server Error');
        }
    }

    return async (req, res) => {
        const rawUrl = req.url ?? '/';
        const queryIndex = rawUrl.indexOf('?');
        const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
        const searchString = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);

        let pathname;
        try {
            pathname = decodeURIComponent(rawPath);
        } catch {
            sendText(res, 400, 'Bad Request');
            return;
        }

        if (pathname === '/api' || pathname.startsWith('/api/')) {
            const searchParams = new URLSearchParams(searchString);
            await handleApiRequest(req, res, pathname, searchParams);
            return;
        }

        await handleStaticRequest(req, res, pathname);
    };
}
