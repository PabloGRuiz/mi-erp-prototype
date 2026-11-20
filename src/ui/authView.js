import { ROLE_LABELS, VALID_ROLES } from '../domain/auth.js';

function createTextCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = text;
    return cell;
}

/**
 * Pure XSS-safe DOM view layer for authentication, setup, session header, and RBAC user management.
 * @param {Document} [doc=document]
 */
export function createAuthView(doc = document) {
    const elements = {
        authScreen: doc.getElementById('auth-screen'),
        authHeading: doc.getElementById('auth-heading'),
        authSubtitle: doc.getElementById('auth-subtitle'),
        authErrorMsg: doc.getElementById('auth-error-msg'),
        authForm: doc.getElementById('auth-form'),
        authFullnameGroup: doc.getElementById('auth-fullname-group'),
        authFullname: doc.getElementById('auth-fullname'),
        authUsername: doc.getElementById('auth-username'),
        authPassword: doc.getElementById('auth-password'),
        authSubmitBtn: doc.getElementById('auth-submit-btn'),

        sessionBar: doc.getElementById('session-bar'),
        sessionUserName: doc.getElementById('session-user-name'),
        sessionUserRole: doc.getElementById('session-user-role'),
        logoutBtn: doc.getElementById('logout-btn'),

        appShell: doc.getElementById('app-shell'),
        moduleNav: doc.getElementById('module-nav'),
        tabButtons: Array.from(doc.querySelectorAll('#module-nav [data-tab]')),
        tabUsers: doc.getElementById('tab-users'),
        panels: {
            inventory: doc.getElementById('panel-inventory'),
            purchases: doc.getElementById('panel-purchases'),
            sales: doc.getElementById('panel-sales'),
            intake: doc.getElementById('panel-intake'),
            kardex: doc.getElementById('panel-kardex'),
            users: doc.getElementById('panel-users')
        },

        usersErrorMsg: doc.getElementById('users-error-msg'),
        usersStatusMsg: doc.getElementById('users-status-msg'),
        userForm: doc.getElementById('user-form'),
        userUsername: doc.getElementById('user-username'),
        userFullname: doc.getElementById('user-fullname'),
        userRole: doc.getElementById('user-role'),
        userPassword: doc.getElementById('user-password'),
        usersTableBody: doc.getElementById('users-table-body')
    };

    const authInputs = {
        fullName: elements.authFullname,
        username: elements.authUsername,
        password: elements.authPassword
    };

    const userInputs = {
        username: elements.userUsername,
        fullName: elements.userFullname,
        role: elements.userRole,
        password: elements.userPassword
    };

    return {
        elements,

        showAuthScreen({ isSetupMode }) {
            elements.authScreen.hidden = false;
            elements.appShell.hidden = true;
            elements.sessionBar.hidden = true;
            elements.authForm.reset();
            this.clearAuthError();

            if (isSetupMode) {
                elements.authHeading.textContent = 'Configuración inicial del ERP';
                elements.authSubtitle.textContent =
                    'Creá la primera cuenta de Administrador para habilitar el sistema y la auditoría de usuarios.';
                elements.authFullnameGroup.hidden = false;
                elements.authFullname.required = true;
                elements.authPassword.autocomplete = 'new-password';
                elements.authSubmitBtn.textContent = 'Crear administrador e ingresar';
                elements.authFullname.focus();
            } else {
                elements.authHeading.textContent = 'Iniciar sesión';
                elements.authSubtitle.textContent =
                    'Ingresá con tus credenciales asignadas para operar en el ERP.';
                elements.authFullnameGroup.hidden = true;
                elements.authFullname.required = false;
                elements.authPassword.autocomplete = 'current-password';
                elements.authSubmitBtn.textContent = 'Ingresar al sistema';
                elements.authUsername.focus();
            }
        },

        showAppShell(user, { canManageUsers }) {
            elements.authScreen.hidden = true;
            elements.appShell.hidden = false;
            elements.sessionBar.hidden = false;
            elements.sessionUserName.textContent = `${user.fullName} (@${user.username})`;
            elements.sessionUserRole.textContent = ROLE_LABELS[user.role] ?? user.role;
            elements.tabUsers.hidden = !canManageUsers;
        },

        setActiveTab(tabName) {
            for (const btn of elements.tabButtons) {
                const isSelected = btn.dataset.tab === tabName;
                btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                btn.classList.toggle('is-active', isSelected);
            }

            for (const [key, panel] of Object.entries(elements.panels)) {
                if (panel) {
                    panel.hidden = key !== tabName;
                }
            }
        },

        readAuthFormValues() {
            return {
                fullName: elements.authFullname.value,
                username: elements.authUsername.value,
                password: elements.authPassword.value
            };
        },

        showAuthError(message, field = null) {
            for (const input of Object.values(authInputs)) {
                input.removeAttribute('aria-invalid');
            }
            elements.authErrorMsg.textContent = message;
            if (field && authInputs[field]) {
                authInputs[field].setAttribute('aria-invalid', 'true');
                authInputs[field].focus();
            }
        },

        clearAuthError() {
            elements.authErrorMsg.textContent = '';
            for (const input of Object.values(authInputs)) {
                input.removeAttribute('aria-invalid');
            }
        },

        readUserFormValues() {
            return {
                username: elements.userUsername.value,
                fullName: elements.userFullname.value,
                role: elements.userRole.value,
                password: elements.userPassword.value
            };
        },

        resetUserForm() {
            elements.userForm.reset();
            elements.userRole.value = 'OPERATOR';
        },

        showUsersError(message, field = null) {
            for (const input of Object.values(userInputs)) {
                input.removeAttribute('aria-invalid');
            }
            elements.usersErrorMsg.textContent = message;
            if (field && userInputs[field]) {
                userInputs[field].setAttribute('aria-invalid', 'true');
                userInputs[field].focus();
            }
        },

        clearUsersError() {
            elements.usersErrorMsg.textContent = '';
            for (const input of Object.values(userInputs)) {
                input.removeAttribute('aria-invalid');
            }
        },

        showUsersStatus(message) {
            elements.usersStatusMsg.textContent = message;
        },

        clearUsersStatus() {
            elements.usersStatusMsg.textContent = '';
        },

        renderUsers(users, currentUserId) {
            const fragment = doc.createDocumentFragment();

            if (users.length === 0) {
                const emptyRow = doc.createElement('tr');
                const cell = doc.createElement('td');
                cell.colSpan = 5;
                cell.className = 'empty-state';
                cell.textContent = 'No hay usuarios registrados.';
                emptyRow.appendChild(cell);
                fragment.appendChild(emptyRow);
            } else {
                for (const user of users) {
                    const row = doc.createElement('tr');

                    const usernameCell = doc.createElement('td');
                    const code = doc.createElement('code');
                    code.className = 'sku-code';
                    code.textContent = `@${user.username}`;
                    usernameCell.appendChild(code);

                    const nameCell = createTextCell(user.fullName, 'cell-name');

                    const roleCell = doc.createElement('td');
                    const roleSelect = doc.createElement('select');
                    roleSelect.className = 'inline-select';
                    roleSelect.dataset.action = 'change-role';
                    roleSelect.dataset.id = user.id;
                    roleSelect.setAttribute('aria-label', `Rol de ${user.username}`);
                    roleSelect.disabled = user.id === currentUserId;

                    for (const roleKey of VALID_ROLES) {
                        const option = doc.createElement('option');
                        option.value = roleKey;
                        option.textContent = ROLE_LABELS[roleKey] ?? roleKey;
                        roleSelect.appendChild(option);
                    }
                    roleSelect.value = user.role;
                    roleCell.appendChild(roleSelect);

                    const statusCell = doc.createElement('td');
                    const statusBadge = doc.createElement('span');
                    statusBadge.className = user.isActive ? 'badge badge-ok' : 'badge badge-out';
                    statusBadge.textContent = user.isActive ? 'Activo' : 'Inactivo';
                    statusCell.appendChild(statusBadge);

                    const actionsCell = doc.createElement('td');
                    const toggleBtn = doc.createElement('button');
                    toggleBtn.type = 'button';
                    toggleBtn.className = user.isActive
                        ? 'action-btn action-delete'
                        : 'action-btn action-edit';
                    toggleBtn.dataset.action = 'toggle-active';
                    toggleBtn.dataset.id = user.id;
                    toggleBtn.textContent = user.isActive ? 'Desactivar' : 'Activar';
                    toggleBtn.disabled = user.id === currentUserId;
                    toggleBtn.setAttribute(
                        'aria-label',
                        `${user.isActive ? 'Desactivar' : 'Activar'} a ${user.username}`
                    );
                    actionsCell.appendChild(toggleBtn);

                    row.append(usernameCell, nameCell, roleCell, statusCell, actionsCell);
                    fragment.appendChild(row);
                }
            }

            elements.usersTableBody.replaceChildren(fragment);
        }
    };
}

