import crypto from 'node:crypto';
import {
    ROLES,
    VALID_ROLES,
    validateLoginInput,
    validateUserCreateInput
} from '../src/domain/auth.js';
import {
    generateSessionToken,
    hashPassword,
    hashSessionToken,
    SESSION_TTL_MS,
    verifyPassword
} from './auth.js';
import { runInTransaction } from './db.js';
import { DomainError } from './inventoryStore.js';

function mapUserRow(row) {
    return {
        id: row.id,
        username: row.username,
        fullName: row.full_name,
        role: row.role,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * SQLite store for users, scrypt credentials, opaque sessions, and RBAC administration.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createAuthStore(db) {
    const countUsersStmt = db.prepare('SELECT COUNT(*) AS count FROM users');
    const selectUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
    const selectUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const listUsersStmt = db.prepare(
        'SELECT id, username, full_name, role, is_active, created_at, updated_at FROM users ORDER BY created_at ASC, rowid ASC'
    );
    const countOtherActiveAdminsStmt = db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1 AND id != ?"
    );
    const insertUserStmt = db.prepare(
        `INSERT INTO users (id, username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateUserStmt = db.prepare(
        `UPDATE users
         SET full_name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ?
         WHERE id = ?`
    );
    const insertSessionStmt = db.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const selectSessionWithUserStmt = db.prepare(
        `SELECT s.id AS session_id, s.expires_at,
                u.id, u.username, u.full_name, u.role, u.is_active, u.created_at, u.updated_at
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
    );
    const deleteSessionByTokenHashStmt = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    const deleteSessionsByUserIdStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
    const purgeExpiredSessionsStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

    function hasUsers() {
        const row = countUsersStmt.get();
        return Number(row?.count ?? 0) > 0;
    }

    function issueSession(userId, nowMs = Date.now()) {
        const nowIso = new Date(nowMs).toISOString();
        const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
        const rawToken = generateSessionToken();
        const tokenHash = hashSessionToken(rawToken);

        purgeExpiredSessionsStmt.run(nowIso);
        insertSessionStmt.run(crypto.randomUUID(), userId, tokenHash, expiresAt, nowIso);
        return rawToken;
    }

    return {
        hasUsers,

        setupInitialAdmin(rawInput) {
            return runInTransaction(db, () => {
                if (hasUsers()) {
                    throw new DomainError('El sistema ya fue inicializado.', {
                        status: 409,
                        code: 'ALREADY_INITIALIZED'
                    });
                }

                const validation = validateUserCreateInput(rawInput, { requireRole: false });
                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const now = new Date().toISOString();
                const id = crypto.randomUUID();
                const passwordHash = hashPassword(validation.data.password);

                insertUserStmt.run(
                    id,
                    validation.data.username,
                    validation.data.fullName,
                    ROLES.ADMIN,
                    passwordHash,
                    1,
                    now,
                    now
                );

                const sessionToken = issueSession(id);
                const user = mapUserRow(selectUserByIdStmt.get(id));
                return { user, sessionToken };
            });
        },

        login(rawInput) {
            const validation = validateLoginInput(rawInput);
            if (!validation.ok) {
                throw new DomainError(validation.error, {
                    status: 400,
                    field: validation.field,
                    code: 'VALIDATION_ERROR'
                });
            }

            return runInTransaction(db, () => {
                const row = selectUserByUsernameStmt.get(validation.data.username);
                const isValid =
                    Boolean(row) &&
                    row.is_active === 1 &&
                    verifyPassword(validation.data.password, row.password_hash);

                if (!isValid) {
                    throw new DomainError('Usuario o contraseña incorrectos.', {
                        status: 401,
                        code: 'INVALID_CREDENTIALS'
                    });
                }

                const sessionToken = issueSession(row.id);
                return {
                    user: mapUserRow(row),
                    sessionToken
                };
            });
        },

        getSessionUser(rawToken) {
            if (!rawToken || typeof rawToken !== 'string') {
                return null;
            }

            const tokenHash = hashSessionToken(rawToken);
            const row = selectSessionWithUserStmt.get(tokenHash);
            if (!row) {
                return null;
            }

            const nowIso = new Date().toISOString();
            if (row.expires_at <= nowIso) {
                deleteSessionByTokenHashStmt.run(tokenHash);
                return null;
            }

            if (row.is_active !== 1) {
                return null;
            }

            return {
                sessionId: row.session_id,
                user: mapUserRow(row)
            };
        },

        logout(rawToken) {
            if (!rawToken || typeof rawToken !== 'string') {
                return;
            }
            deleteSessionByTokenHashStmt.run(hashSessionToken(rawToken));
        },

        listUsers() {
            return listUsersStmt.all().map(mapUserRow);
        },

        createUser(rawInput) {
            return runInTransaction(db, () => {
                const validation = validateUserCreateInput(rawInput, { requireRole: true });
                if (!validation.ok) {
                    throw new DomainError(validation.error, {
                        status: 400,
                        field: validation.field,
                        code: 'VALIDATION_ERROR'
                    });
                }

                const existing = selectUserByUsernameStmt.get(validation.data.username);
                if (existing) {
                    throw new DomainError(
                        `Ya existe un usuario registrado con el nombre "${validation.data.username}".`,
                        {
                            status: 409,
                            field: 'username',
                            code: 'DUPLICATE_USERNAME'
                        }
                    );
                }

                const now = new Date().toISOString();
                const id = crypto.randomUUID();
                const passwordHash = hashPassword(validation.data.password);

                insertUserStmt.run(
                    id,
                    validation.data.username,
                    validation.data.fullName,
                    validation.data.role,
                    passwordHash,
                    1,
                    now,
                    now
                );

                return mapUserRow(selectUserByIdStmt.get(id));
            });
        },

        updateUser(targetId, patch) {
            return runInTransaction(db, () => {
                const existing = selectUserByIdStmt.get(targetId);
                if (!existing) {
                    throw new DomainError('Usuario no encontrado.', {
                        status: 404,
                        code: 'USER_NOT_FOUND'
                    });
                }

                const nextFullName =
                    patch?.fullName !== undefined ? String(patch.fullName).trim() : existing.full_name;
                if (nextFullName.length < 2 || nextFullName.length > 80) {
                    throw new DomainError('El nombre completo debe tener entre 2 y 80 caracteres.', {
                        status: 400,
                        field: 'fullName',
                        code: 'VALIDATION_ERROR'
                    });
                }

                const nextRole =
                    patch?.role !== undefined ? String(patch.role).trim().toUpperCase() : existing.role;
                if (!VALID_ROLES.includes(nextRole)) {
                    throw new DomainError('El rol seleccionado no es válido.', {
                        status: 400,
                        field: 'role',
                        code: 'VALIDATION_ERROR'
                    });
                }

                const nextIsActive =
                    patch?.isActive !== undefined ? Boolean(patch.isActive) : Boolean(existing.is_active);

                let nextPasswordHash = existing.password_hash;
                let passwordChanged = false;
                if (typeof patch?.password === 'string' && patch.password.length > 0) {
                    if (patch.password.length < 8 || patch.password.length > 128) {
                        throw new DomainError('La contraseña debe tener entre 8 y 128 caracteres.', {
                            status: 400,
                            field: 'password',
                            code: 'VALIDATION_ERROR'
                        });
                    }
                    nextPasswordHash = hashPassword(patch.password);
                    passwordChanged = true;
                }

                const wasActiveAdmin = existing.role === ROLES.ADMIN && existing.is_active === 1;
                const willRemainActiveAdmin = nextRole === ROLES.ADMIN && nextIsActive;

                if (wasActiveAdmin && !willRemainActiveAdmin) {
                    const otherAdmins = countOtherActiveAdminsStmt.get(targetId);
                    if (Number(otherAdmins?.count ?? 0) === 0) {
                        throw new DomainError(
                            'No podés desactivar ni cambiar el rol del último administrador activo.',
                            {
                                status: 409,
                                code: 'LAST_ADMIN_PROTECTED'
                            }
                        );
                    }
                }

                const now = new Date().toISOString();
                updateUserStmt.run(
                    nextFullName,
                    nextRole,
                    nextIsActive ? 1 : 0,
                    nextPasswordHash,
                    now,
                    targetId
                );

                if (!nextIsActive || passwordChanged) {
                    deleteSessionsByUserIdStmt.run(targetId);
                }

                return mapUserRow(selectUserByIdStmt.get(targetId));
            });
        }
    };
}

