import http from 'node:http';
import path from 'node:path';
import { createGeminiExtractor, DEFAULT_GEMINI_MODEL } from './ai/geminiExtractor.js';
import { createAuthStore } from './authStore.js';
import { createDatabase } from './db.js';
import { loadEnvFile } from './env.js';
import { createIntakeStore } from './intakeStore.js';
import { createInventoryStore } from './inventoryStore.js';
import { createOperationsStore } from './operationsStore.js';
import { createAppHandler } from './router.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
loadEnvFile(path.join(ROOT_DIR, '.env'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'erp.db');

const db = createDatabase(DB_PATH);
const store = createInventoryStore(db);
const authStore = createAuthStore(db);
const operationsStore = createOperationsStore(db);
const intakeStore = createIntakeStore(db, { inventoryStore: store, operationsStore });
const fallbackModelsEnv = (process.env.GEMINI_FALLBACK_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

const aiExtractor = createGeminiExtractor({
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    ...(fallbackModelsEnv.length > 0 ? { fallbackModels: fallbackModelsEnv } : {}),
    autoDiscover: process.env.GEMINI_AUTO_DISCOVER !== 'false'
});
const handler = createAppHandler({
    store,
    authStore,
    operationsStore,
    intakeStore,
    aiExtractor,
    staticRoot: ROOT_DIR
});
const server = http.createServer((req, res) => {
    void handler(req, res);
});

server.listen(PORT, HOST, () => {
    const aiStatus = aiExtractor.getStatus();
    console.log(`ERP server running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(
        `Gemini AI intake: ${aiStatus.configured ? `enabled (${aiStatus.model})` : 'not configured (set GEMINI_API_KEY in .env)'}`
    );

    if (aiStatus.configured) {
        void aiExtractor.refreshAvailableModels().then((discovered) => {
            console.log(
                `Gemini models detected: ${discovered.availableCount}/${discovered.totalModels} available (active: ${discovered.model})`
            );
        });
    }
});

function shutdown() {
    server.close(() => {
        db.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
