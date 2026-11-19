import fs from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from './inventoryStore.js';

const MAX_JSON_BODY_BYTES = 65536;

const MIME_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8']
]);

const PROTECTED_PREFIXES = ['server/', 'data/', 'tests/', '.git/'];
const PROTECTED_FILES = new Set(['package.json', 'package-lock.json', '.gitignore', 'README.md']);

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

async function readJsonBody(req) {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_JSON_BODY_BYTES) {
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
 * Builds the combined REST API + allowlisted static asset HTTP handler.
 * @param {{ store: ReturnType<import('./inventoryStore.js').createInventoryStore>, staticRoot: string }} options
 */
export function createAppHandler({ store, staticRoot }) {
    const normalizedRoot = path.resolve(staticRoot);
    const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;

    async function handleApiRequest(req, res, pathname, searchParams) {
        try {
            if (req.method === 'GET' && pathname === '/api/health') {
                sendJson(res, 200, { ok: true, storage: 'sqlite' });
                return;
            }

            if (req.method === 'GET' && pathname === '/api/products') {
                sendJson(res, 200, { products: store.listProducts() });
                return;
            }

            if (req.method === 'POST' && pathname === '/api/products') {
                const body = await readJsonBody(req);
                const result = store.createProduct(body);
                sendJson(res, 201, result);
                return;
            }

            const productMatch = /^\/api\/products\/([^/]+)$/.exec(pathname);
            if (productMatch) {
                const productId = decodeURIComponent(productMatch[1]);

                if (req.method === 'GET') {
                    const product = store.getProductById(productId);
                    if (!product) {
                        sendJson(res, 404, { error: 'Producto no encontrado.', code: 'PRODUCT_NOT_FOUND' });
                        return;
                    }
                    sendJson(res, 200, { product });
                    return;
                }

                if (req.method === 'PUT') {
                    const body = await readJsonBody(req);
                    const result = store.updateProduct(productId, body);
                    sendJson(res, 200, result);
                    return;
                }

                if (req.method === 'DELETE') {
                    const result = store.deleteProduct(productId);
                    sendJson(res, 200, result);
                    return;
                }
            }

            if (req.method === 'GET' && pathname === '/api/movements') {
                const movements = store.listMovements({
                    productId: searchParams.get('productId') ?? '',
                    type: searchParams.get('type') ?? '',
                    limit: searchParams.get('limit') ?? '200'
                });
                sendJson(res, 200, { movements });
                return;
            }

            if (req.method === 'POST' && pathname === '/api/movements') {
                const body = await readJsonBody(req);
                const result = store.recordMovement(body);
                sendJson(res, 201, result);
                return;
            }

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
                    error: 'Ya existe un registro con ese identificador o SKU.',
                    field: 'sku',
                    code: 'DUPLICATE_SKU'
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
                'Content-Type': contentType,
                'Cache-Control': 'no-store'
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

