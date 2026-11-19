export const STORAGE_KEY = 'erp_inventory_v1';
export const SCHEMA_VERSION = 1;

function cloneProduct(product) {
    return { ...product };
}

function isValidStoredProduct(item) {
    return (
        item !== null &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        typeof item.sku === 'string' &&
        item.sku.length > 0 &&
        typeof item.name === 'string' &&
        item.name.length > 0 &&
        typeof item.category === 'string' &&
        Number.isSafeInteger(item.priceCents) &&
        item.priceCents >= 0 &&
        Number.isSafeInteger(item.stock) &&
        item.stock >= 0 &&
        Number.isSafeInteger(item.minStock) &&
        item.minStock >= 0
    );
}

/**
 * Async Repository adapter backed by Web Storage (`localStorage`).
 * Exposes the same contract expected from a future SQLite/REST API repository.
 * @param {Storage} [storage=globalThis.localStorage]
 */
export function createLocalStorageProductRepository(storage = globalThis.localStorage) {
    function readAllRecords() {
        try {
            const raw = storage.getItem(STORAGE_KEY);
            if (!raw) {
                return [];
            }

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.products)) {
                return [];
            }

            return parsed.products.filter(isValidStoredProduct).map(cloneProduct);
        } catch {
            return [];
        }
    }

    function writeAllRecords(records) {
        try {
            const payload = JSON.stringify({
                version: SCHEMA_VERSION,
                products: records
            });
            storage.setItem(STORAGE_KEY, payload);
        } catch {
            throw new Error('No se pudo guardar el inventario en el almacenamiento local.');
        }
    }

    return {
        async getAll() {
            return readAllRecords().map(cloneProduct);
        },

        async getById(id) {
            const found = readAllRecords().find((product) => product.id === id);
            return found ? cloneProduct(found) : null;
        },

        async create(product) {
            const records = readAllRecords();
            if (records.some((item) => item.id === product.id)) {
                throw new Error(`Ya existe un producto con el identificador "${product.id}".`);
            }

            const record = cloneProduct(product);
            records.push(record);
            writeAllRecords(records);
            return cloneProduct(record);
        },

        async update(id, patch) {
            const records = readAllRecords();
            const index = records.findIndex((item) => item.id === id);

            if (index === -1) {
                throw new Error(`No se encontró el producto con identificador "${id}".`);
            }

            const existing = records[index];
            const updated = {
                ...existing,
                ...patch,
                id: existing.id,
                createdAt: existing.createdAt,
                updatedAt: new Date().toISOString()
            };

            records[index] = updated;
            writeAllRecords(records);
            return cloneProduct(updated);
        },

        async remove(id) {
            const records = readAllRecords();
            const nextRecords = records.filter((item) => item.id !== id);

            if (nextRecords.length === records.length) {
                return false;
            }

            writeAllRecords(nextRecords);
            return true;
        }
    };
}

