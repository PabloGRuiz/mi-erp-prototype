export const ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    OPERATOR: 'OPERATOR',
    AUDITOR: 'AUDITOR'
});

export const ROLE_LABELS = Object.freeze({
    ADMIN: 'Administrador',
    OPERATOR: 'Operador',
    AUDITOR: 'Auditor'
});

export const VALID_ROLES = Object.freeze(Object.values(ROLES));

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_FULLNAME_LENGTH = 2;
const MAX_FULLNAME_LENGTH = 80;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.ADMIN]: new Set([
        'inventory:read',
        'inventory:write',
        'inventory:delete',
        'purchases:read',
        'purchases:write',
        'purchases:cancel',
        'sales:read',
        'sales:write',
        'sales:cancel',
        'intake:read',
        'intake:write',
        'intake:approve',
        'users:manage'
    ]),
    [ROLES.OPERATOR]: new Set([
        'inventory:read',
        'inventory:write',
        'purchases:read',
        'purchases:write',
        'sales:read',
        'sales:write',
        'intake:read',
        'intake:write',
        'intake:approve'
    ]),
    [ROLES.AUDITOR]: new Set([
        'inventory:read',
        'purchases:read',
        'sales:read',
        'intake:read'
    ])
});

/**
 * Checks whether a role holds a specific RBAC permission.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function canPerform(role, permission) {
    return Boolean(ROLE_PERMISSIONS[role]?.has(permission));
}

/**
 * Normalizes a username to trimmed lowercase.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUsername(raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Validates payload for initial admin setup or user creation.
 * @param {Record<string, unknown>} rawInput
 * @param {{ requireRole?: boolean }} [options]
 */
export function validateUserCreateInput(rawInput, { requireRole = true } = {}) {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: 'Datos de usuario inválidos.', field: 'username' };
    }

    const username = normalizeUsername(rawInput.username);
    if (!USERNAME_PATTERN.test(username)) {
        return {
            ok: false,
            error: 'El usuario debe tener entre 3 y 32 caracteres (minúsculas, números, ".", "_" o "-").',
            field: 'username'
        };
    }

    const fullName = typeof rawInput.fullName === 'string' ? rawInput.fullName.trim() : '';
    if (fullName.length < MIN_FULLNAME_LENGTH || fullName.length > MAX_FULLNAME_LENGTH) {
        return {
            ok: false,
            error: `El nombre completo debe tener entre ${MIN_FULLNAME_LENGTH} y ${MAX_FULLNAME_LENGTH} caracteres.`,
            field: 'fullName'
        };
    }

    const password = typeof rawInput.password === 'string' ? rawInput.password : '';
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return {
            ok: false,
            error: `La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres.`,
            field: 'password'
        };
    }

    const role = requireRole
        ? (typeof rawInput.role === 'string' ? rawInput.role.trim().toUpperCase() : '')
        : ROLES.ADMIN;

    if (!VALID_ROLES.includes(role)) {
        return {
            ok: false,
            error: 'El rol seleccionado no es válido.',
            field: 'role'
        };
    }

    return {
        ok: true,
        data: {
            username,
            fullName,
            password,
            role
        }
    };
}

/**
 * Validates login request credentials.
 * @param {Record<string, unknown>} rawInput
 */
export function validateLoginInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') {
        return { ok: false, error: 'Credenciales inválidas.', field: 'username' };
    }

    const username = normalizeUsername(rawInput.username);
    if (!username) {
        return { ok: false, error: 'Ingresá tu nombre de usuario.', field: 'username' };
    }

    const password = typeof rawInput.password === 'string' ? rawInput.password : '';
    if (!password) {
        return { ok: false, error: 'Ingresá tu contraseña.', field: 'password' };
    }

    return {
        ok: true,
        data: { username, password }
    };
}

