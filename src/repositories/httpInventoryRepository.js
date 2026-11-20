import { createHttpClient } from './httpClient.js';

/**
 * Async Repository adapter backed by the local Node.js + SQLite REST API.
 * Implements the product CRUD contract plus Kardex movement methods.
 * @param {string} [baseUrl='/api']
 */
export function createHttpInventoryRepository(baseUrl = '/api') {
    const request = createHttpClient(baseUrl);

    return {
        async getAll() {
            const data = await request('/products');
            return data.products;
        },

        async getById(id) {
            try {
                const data = await request(`/products/${encodeURIComponent(id)}`);
                return data.product;
            } catch (error) {
                if (error && error.status === 404) {
                    return null;
                }
                throw error;
            }
        },

        async create(rawProductInput) {
            const data = await request('/products', {
                method: 'POST',
                body: JSON.stringify(rawProductInput)
            });
            return data.product;
        },

        async update(id, patch) {
            const data = await request(`/products/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: JSON.stringify(patch)
            });
            return data.product;
        },

        async remove(id) {
            try {
                await request(`/products/${encodeURIComponent(id)}`, {
                    method: 'DELETE'
                });
                return true;
            } catch (error) {
                if (error && error.status === 404) {
                    return false;
                }
                throw error;
            }
        },

        async getMovements({ productId = '', type = '', limit = 200 } = {}) {
            const params = new URLSearchParams();
            if (productId) {
                params.set('productId', productId);
            }
            if (type && type !== 'all') {
                params.set('type', type);
            }
            if (limit) {
                params.set('limit', String(limit));
            }

            const query = params.toString();
            const data = await request(`/movements${query ? `?${query}` : ''}`);
            return data.movements;
        },

        async recordMovement(rawMovementInput) {
            return request('/movements', {
                method: 'POST',
                body: JSON.stringify(rawMovementInput)
            });
        }
    };
}
