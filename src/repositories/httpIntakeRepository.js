import { createHttpClient } from './httpClient.js';

/**
 * Async Repository adapter for AI configuration status and staged document intake queue.
 * @param {string} [baseUrl='/api']
 */
export function createHttpIntakeRepository(baseUrl = '/api') {
    const request = createHttpClient(baseUrl);

    return {
        async getAiStatus() {
            return request('/ai/status');
        },

        async refreshAiModels() {
            return request('/ai/refresh', {
                method: 'POST'
            });
        },

        async listIntakes({ status = '', batchId = '', limit = 100 } = {}) {
            const params = new URLSearchParams();
            if (status && status !== 'all') {
                params.set('status', status);
            }
            if (batchId) {
                params.set('batchId', batchId);
            }
            if (limit) {
                params.set('limit', String(limit));
            }
            const query = params.toString();
            return request(`/intake${query ? `?${query}` : ''}`);
        },

        async getIntake(id) {
            const data = await request(`/intake/${encodeURIComponent(id)}`);
            return data.intake;
        },

        async uploadBatch(documents, { wait = false } = {}) {
            return request(`/intake/upload${wait ? '?wait=true' : ''}`, {
                method: 'POST',
                body: JSON.stringify({ documents })
            });
        },

        async updateReview(id, reviewPayload) {
            const data = await request(`/intake/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: JSON.stringify(reviewPayload)
            });
            return data.intake;
        },

        async approveIntake(id) {
            return request(`/intake/${encodeURIComponent(id)}/approve`, {
                method: 'POST'
            });
        },

        async approveBatch(ids) {
            return request('/intake/approve-batch', {
                method: 'POST',
                body: JSON.stringify({ ids })
            });
        },

        async rejectIntake(id) {
            const data = await request(`/intake/${encodeURIComponent(id)}/reject`, {
                method: 'POST'
            });
            return data.intake;
        },

        async rejectAllErrors() {
            return request('/intake/reject-errors', {
                method: 'POST'
            });
        }
    };
}

