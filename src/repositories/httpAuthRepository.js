import { createHttpClient } from './httpClient.js';

/**
 * Async Repository adapter for authentication, sessions, and RBAC user administration.
 * @param {string} [baseUrl='/api']
 */
export function createHttpAuthRepository(baseUrl = '/api') {
    const request = createHttpClient(baseUrl);

    return {
        async getStatus() {
            return request('/auth/status');
        },

        async setupAdmin(payload) {
            const data = await request('/auth/setup', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.user;
        },

        async login(payload) {
            const data = await request('/auth/login', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.user;
        },

        async logout() {
            return request('/auth/logout', { method: 'POST' });
        },

        async listUsers() {
            const data = await request('/users');
            return data.users;
        },

        async createUser(payload) {
            const data = await request('/users', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.user;
        },

        async updateUser(id, patch) {
            const data = await request(`/users/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: JSON.stringify(patch)
            });
            return data.user;
        }
    };
}

