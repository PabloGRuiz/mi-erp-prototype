import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'erp_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

const SCRYPT_KEYLEN = 64;

/**
 * Hashes a plain-text password using scrypt and a per-user random 16-byte salt.
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return `${salt}:${derivedKey}`;
}

/**
 * Verifies a plain-text password against a stored `salt:hash` using timing-safe comparison.
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string') {
        return false;
    }

    const parts = storedHash.split(':');
    if (parts.length !== 2) {
        return false;
    }

    const [salt, expectedHex] = parts;
    if (!salt || !expectedHex) {
        return false;
    }

    try {
        const expectedBuffer = Buffer.from(expectedHex, 'hex');
        const actualBuffer = crypto.scryptSync(password, salt, expectedBuffer.length);
        if (actualBuffer.length !== expectedBuffer.length) {
            return false;
        }
        return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
        return false;
    }
}

/**
 * Generates a high-entropy opaque session token for cookies.
 * @returns {string}
 */
export function generateSessionToken() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Computes the SHA-256 hex digest of a session token for database storage.
 * @param {string} token
 * @returns {string}
 */
export function hashSessionToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Parses an HTTP `Cookie` header into a plain key-value map.
 * @param {string | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') {
        return cookies;
    }

    for (const pair of cookieHeader.split(';')) {
        const separatorIndex = pair.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }
        const name = pair.slice(0, separatorIndex).trim();
        const rawValue = pair.slice(separatorIndex + 1).trim();
        try {
            cookies[name] = decodeURIComponent(rawValue);
        } catch {
            cookies[name] = rawValue;
        }
    }

    return cookies;
}

/**
 * Builds an HttpOnly SameSite=Lax cookie string for an authenticated session.
 * @param {string} token
 * @param {number} [maxAgeSeconds=Math.floor(SESSION_TTL_MS / 1000)]
 * @returns {string}
 */
export function buildSessionCookie(token, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
    const secureFlag = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

/**
 * Builds a clearing Set-Cookie header value for logout/revocation.
 * @returns {string}
 */
export function buildClearSessionCookie() {
    const secureFlag = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`;
}

