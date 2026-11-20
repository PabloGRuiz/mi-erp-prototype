/**
 * Shared HTTP JSON client for browser repositories.
 * Sends same-origin HttpOnly cookies and preserves structured backend validation errors.
 * @param {string} [baseUrl='/api']
 */
export function createHttpClient(baseUrl = '/api') {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

    return async function request(path, options = {}) {
        const response = await fetch(`${normalizedBase}${path}`, {
            credentials: 'same-origin',
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers ?? {})
            }
        });

        const payload = await response.json().catch(() => null);

        if (!response.ok) {
            const error = new Error(payload?.error || `Error del servidor (HTTP ${response.status}).`);
            error.status = response.status;
            error.field = payload?.field ?? null;
            error.code = payload?.code ?? 'HTTP_ERROR';
            throw error;
        }

        return payload;
    };
}

