import { createHttpClient } from './httpClient.js';

/**
 * Async Repository adapter for Suppliers, Customers, Purchase Orders, and Sales Orders.
 * @param {string} [baseUrl='/api']
 */
export function createHttpOperationsRepository(baseUrl = '/api') {
    const request = createHttpClient(baseUrl);

    return {
        async listSuppliers() {
            const data = await request('/suppliers');
            return data.suppliers;
        },

        async createSupplier(payload) {
            const data = await request('/suppliers', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.supplier;
        },

        async listPurchases() {
            const data = await request('/purchases');
            return data.purchases;
        },

        async createPurchase(payload) {
            const data = await request('/purchases', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.purchase;
        },

        async receivePurchase(id) {
            const data = await request(`/purchases/${encodeURIComponent(id)}/receive`, {
                method: 'POST'
            });
            return data.purchase;
        },

        async cancelPurchase(id) {
            const data = await request(`/purchases/${encodeURIComponent(id)}/cancel`, {
                method: 'POST'
            });
            return data.purchase;
        },

        async listCustomers() {
            const data = await request('/customers');
            return data.customers;
        },

        async createCustomer(payload) {
            const data = await request('/customers', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.customer;
        },

        async listSales() {
            const data = await request('/sales');
            return data.sales;
        },

        async createSale(payload) {
            const data = await request('/sales', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            return data.sale;
        },

        async cancelSale(id) {
            const data = await request(`/sales/${encodeURIComponent(id)}/cancel`, {
                method: 'POST'
            });
            return data.sale;
        }
    };
}

