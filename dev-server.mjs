import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname);
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml; charset=utf-8']
]);

/**
 * Resolves a request pathname inside ROOT_DIR while blocking path traversal.
 * @param {string} requestUrl
 * @returns {string | null}
 */
function resolveSafeFilePath(requestUrl) {
    const rawPathname = (requestUrl || '/').split('?')[0];
    let decodedPathname;

    try {
        decodedPathname = decodeURIComponent(rawPathname);
    } catch {
        return null;
    }

    const relativePath = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '');
    const normalizedPath = path.normalize(relativePath);
    const resolvedPath = path.resolve(ROOT_DIR, normalizedPath);
    const rootPrefix = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;

    if (resolvedPath !== ROOT_DIR && !resolvedPath.startsWith(rootPrefix)) {
        return null;
    }

    return resolvedPath;
}

const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
    }

    const filePath = resolveSafeFilePath(req.url ?? '/');

    if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES.get(ext) ?? 'application/octet-stream';
        const content = req.method === 'HEAD' ? null : await fs.readFile(filePath);

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store'
        });
        res.end(content);
    } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }

        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
    }
});

server.listen(PORT, HOST, () => {
    console.log(`ERP dev server running at http://localhost:${PORT}`);
});

