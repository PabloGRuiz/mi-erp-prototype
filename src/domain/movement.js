import { parseNonNegativeInteger } from './product.js';

export const MOVEMENT_TYPES = Object.freeze({
    IN: 'IN',
    OUT: 'OUT',
    ADJUSTMENT: 'ADJUSTMENT'
});

const VALID_TYPES = new Set(Object.values(MOVEMENT_TYPES));
const MAX_REASON_LENGTH = 200;
const MAX_REFERENCE_LENGTH = 60;

/**
 * Validates and computes stock transition data for a Kardex movement.
 * @param {Record<string, unknown>} rawInput
 * @param {{ id: string, name: string, stock: number } | null | undefined} product
 */
export function validateMovementInput(rawInput, product) {
    if (!rawInput || typeof rawInput !== 'object') {
        return {
            ok: false,
            error: 'Los datos del movimiento son inválidos.',
            field: 'type',
            code: 'INVALID_INPUT'
        };
    }

    if (!product || typeof product !== 'object' || !Number.isSafeInteger(product.stock)) {
        return {
            ok: false,
            error: 'Seleccioná un producto válido.',
            field: 'productId',
            code: 'PRODUCT_NOT_FOUND'
        };
    }

    const type = typeof rawInput.type === 'string' ? rawInput.type.trim().toUpperCase() : '';
    if (!VALID_TYPES.has(type)) {
        return {
            ok: false,
            error: 'El tipo de movimiento debe ser Entrada, Salida o Ajuste.',
            field: 'type',
            code: 'INVALID_TYPE'
        };
    }

    const reason = typeof rawInput.reason === 'string' ? rawInput.reason.trim() : '';
    if (!reason) {
        return {
            ok: false,
            error: 'El motivo del movimiento es obligatorio.',
            field: 'reason',
            code: 'INVALID_REASON'
        };
    }

    if (reason.length > MAX_REASON_LENGTH) {
        return {
            ok: false,
            error: `El motivo no puede superar los ${MAX_REASON_LENGTH} caracteres.`,
            field: 'reason',
            code: 'INVALID_REASON'
        };
    }

    const reference = typeof rawInput.reference === 'string' ? rawInput.reference.trim() : '';
    if (reference.length > MAX_REFERENCE_LENGTH) {
        return {
            ok: false,
            error: `La referencia no puede superar los ${MAX_REFERENCE_LENGTH} caracteres.`,
            field: 'reference',
            code: 'INVALID_REFERENCE'
        };
    }

    let quantity;
    let delta;
    let resultingStock;

    if (type === MOVEMENT_TYPES.ADJUSTMENT) {
        const rawTarget = rawInput.targetStock !== undefined ? rawInput.targetStock : rawInput.quantity;
        const targetStock = parseNonNegativeInteger(rawTarget);

        if (targetStock === null) {
            return {
                ok: false,
                error: 'El stock real debe ser un número entero mayor o igual a 0.',
                field: 'quantity',
                code: 'INVALID_QUANTITY'
            };
        }

        if (targetStock === product.stock) {
            return {
                ok: false,
                error: `El stock real ya coincide con el stock actual (${product.stock}).`,
                field: 'quantity',
                code: 'NO_CHANGE'
            };
        }

        delta = targetStock - product.stock;
        quantity = Math.abs(delta);
        resultingStock = targetStock;
    } else {
        const parsedQuantity = parseNonNegativeInteger(rawInput.quantity);
        if (parsedQuantity === null || parsedQuantity < 1) {
            return {
                ok: false,
                error: 'La cantidad debe ser un número entero mayor o igual a 1.',
                field: 'quantity',
                code: 'INVALID_QUANTITY'
            };
        }

        if (type === MOVEMENT_TYPES.OUT && parsedQuantity > product.stock) {
            return {
                ok: false,
                error: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, solicitado: ${parsedQuantity}.`,
                field: 'quantity',
                code: 'INSUFFICIENT_STOCK'
            };
        }

        quantity = parsedQuantity;
        delta = type === MOVEMENT_TYPES.IN ? parsedQuantity : -parsedQuantity;
        resultingStock = product.stock + delta;
    }

    return {
        ok: true,
        data: {
            productId: product.id,
            type,
            quantity,
            delta,
            previousStock: product.stock,
            resultingStock,
            reason,
            reference
        }
    };
}

/**
 * Aggregates movement totals in a single pass.
 * @param {Array<{ delta: number }>} movements
 */
export function calculateMovementSummary(movements) {
    return movements.reduce(
        (summary, movement) => {
            summary.totalMovements += 1;
            if (movement.delta > 0) {
                summary.totalInUnits += movement.delta;
            } else if (movement.delta < 0) {
                summary.totalOutUnits += Math.abs(movement.delta);
            }
            summary.netUnits += movement.delta;
            return summary;
        },
        {
            totalMovements: 0,
            totalInUnits: 0,
            totalOutUnits: 0,
            netUnits: 0
        }
    );
}

