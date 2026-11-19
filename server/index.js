import http from 'node:http';
import path from 'node:path';
import { createDatabase } from './db.js';
import { createInventoryStore } from './inventoryStore.js';
import { createAppHandler } from './router.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'erp.db');

const db = createDatabase(DB_PATH);
const store = createInventoryStore(db);
const handler = createAppHandler({ store, staticRoot: ROOT_DIR });
const server = http.createServer((req, res) => {
    void handler(req, res);
});

server.listen(PORT, HOST, () => {
    console.log(`ERP server running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
});

function shutdown() {
    server.close(() => {
        db.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

