import {
    calculateInventoryMetrics,
    createProduct,
    filterAndSortProducts,
    getUniqueCategories,
    validateProductInput
} from './domain/product.js';
import { createLocalStorageProductRepository } from './repositories/localStorageProductRepository.js';
import { createInventoryView } from './ui/inventoryView.js';

const productRepository = createLocalStorageProductRepository();
const view = createInventoryView();

const state = {
    products: [],
    editingId: null,
    filters: {
        query: '',
        category: 'all',
        stockFilter: 'all',
        sortBy: 'createdAt-desc'
    }
};

function render() {
    const metrics = calculateInventoryMetrics(state.products);
    const categories = getUniqueCategories(state.products);

    if (state.filters.category !== 'all' && !categories.includes(state.filters.category)) {
        state.filters.category = 'all';
    }

    const visibleProducts = filterAndSortProducts(state.products, state.filters);

    view.renderMetrics(metrics);
    view.renderCategoryOptions(categories, state.filters.category);
    view.renderTable(visibleProducts, state.products.length, state.editingId);
}

function exitEditMode() {
    state.editingId = null;
    view.clearError();
    view.setFormMode(null);
    render();
    view.focusField('sku');
}

async function handleFormSubmit(event) {
    event.preventDefault();
    view.clearError();
    view.clearStatus();

    const rawInput = view.readFormValues();
    const validation = validateProductInput(rawInput, state.products, state.editingId);

    if (!validation.ok) {
        view.showError(validation.error, validation.field);
        return;
    }

    try {
        if (state.editingId) {
            const updated = await productRepository.update(state.editingId, validation.data);
            state.products = state.products.map((product) =>
                product.id === updated.id ? updated : product
            );
            state.editingId = null;
            view.setFormMode(null);
            view.showStatus(`Producto "${updated.name}" (${updated.sku}) actualizado.`);
        } else {
            const product = createProduct(validation.data);
            const saved = await productRepository.create(product);
            state.products = [saved, ...state.products];
            view.setFormMode(null);
            view.showStatus(`Producto "${saved.name}" (${saved.sku}) agregado al inventario.`);
        }

        render();
        view.focusField('sku');
    } catch (error) {
        view.showError(error instanceof Error ? error.message : 'No se pudo guardar el producto.');
    }
}

async function handleQuickStockAdjust(product, delta) {
    const nextStock = Math.max(0, product.stock + delta);
    if (nextStock === product.stock) {
        return;
    }

    view.clearError();

    try {
        const updated = await productRepository.update(product.id, { stock: nextStock });
        state.products = state.products.map((item) =>
            item.id === updated.id ? updated : item
        );

        if (state.editingId === updated.id) {
            view.elements.stockInput.value = String(updated.stock);
        }

        view.showStatus(`Stock de "${updated.name}" actualizado a ${updated.stock} unidades.`);
        render();
    } catch (error) {
        view.showError(error instanceof Error ? error.message : 'No se pudo actualizar el stock.');
    }
}

async function handleDeleteProduct(product) {
    const confirmed = await view.confirmDelete(product);
    if (!confirmed) {
        return;
    }

    view.clearError();

    try {
        const removed = await productRepository.remove(product.id);
        if (!removed) {
            return;
        }

        state.products = state.products.filter((item) => item.id !== product.id);

        if (state.editingId === product.id) {
            state.editingId = null;
            view.setFormMode(null);
        }

        view.showStatus(`Producto "${product.name}" (${product.sku}) eliminado del inventario.`);
        render();
    } catch (error) {
        view.showError(error instanceof Error ? error.message : 'No se pudo eliminar el producto.');
    }
}

function handleTableClick(event) {
    const actionButton = event.target.closest('button[data-action]');
    if (!actionButton) {
        return;
    }

    const { action, id } = actionButton.dataset;
    const product = state.products.find((item) => item.id === id);
    if (!product) {
        return;
    }

    if (action === 'increment') {
        void handleQuickStockAdjust(product, 1);
        return;
    }

    if (action === 'decrement') {
        void handleQuickStockAdjust(product, -1);
        return;
    }

    if (action === 'edit') {
        state.editingId = product.id;
        view.clearError();
        view.clearStatus();
        view.setFormMode(product);
        render();
        view.focusField('name');
        return;
    }

    if (action === 'delete') {
        void handleDeleteProduct(product);
    }
}

function bindEvents() {
    view.elements.form.addEventListener('submit', (event) => {
        void handleFormSubmit(event);
    });

    view.elements.cancelEditBtn.addEventListener('click', exitEditMode);

    view.elements.tableBody.addEventListener('click', handleTableClick);

    view.elements.searchInput.addEventListener('input', (event) => {
        state.filters.query = event.target.value;
        render();
    });

    view.elements.categoryFilter.addEventListener('change', (event) => {
        state.filters.category = event.target.value;
        render();
    });

    view.elements.stockFilter.addEventListener('change', (event) => {
        state.filters.stockFilter = event.target.value;
        render();
    });

    view.elements.sortSelect.addEventListener('change', (event) => {
        state.filters.sortBy = event.target.value;
        render();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.editingId && !view.elements.confirmDialog.open) {
            exitEditMode();
        }
    });
}

async function init() {
    bindEvents();

    try {
        state.products = await productRepository.getAll();
    } catch (error) {
        view.showError(error instanceof Error ? error.message : 'No se pudo cargar el inventario inicial.');
    }

    view.setFormMode(null);
    render();
}

void init();

