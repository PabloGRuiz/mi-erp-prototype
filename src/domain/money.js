const CURRENCY_FORMATTER = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS'
});

const INTEGER_FORMATTER = new Intl.NumberFormat('es-AR', {
    maximumFractionDigits: 0
});

const DECIMAL_PRICE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a non-negative decimal price string or number into integer cents.
 * Returns null when the value is invalid, negative, or exceeds two decimal places.
 * @param {string | number} rawValue
 * @returns {number | null}
 */
export function parsePriceToCents(rawValue) {
    let normalized;

    if (typeof rawValue === 'number') {
        if (!Number.isFinite(rawValue) || rawValue < 0) {
            return null;
        }
        normalized = String(rawValue);
    } else if (typeof rawValue === 'string') {
        normalized = rawValue.trim();
    } else {
        return null;
    }

    const match = DECIMAL_PRICE_PATTERN.exec(normalized);
    if (!match) {
        return null;
    }

    const integerPart = Number(match[1]);
    const fractionalPart = Number((match[2] ?? '').padEnd(2, '0'));
    const cents = integerPart * 100 + fractionalPart;

    return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Converts integer cents to a fixed-point string suitable for `<input type="number">`.
 * @param {number} cents
 * @returns {string}
 */
export function centsToInputValue(cents) {
    if (!Number.isFinite(cents)) {
        return '0.00';
    }
    return (cents / 100).toFixed(2);
}

/**
 * Formats an integer amount in cents as localized ARS currency.
 * @param {number} cents
 * @returns {string}
 */
export function formatCurrencyFromCents(cents) {
    return CURRENCY_FORMATTER.format((Number.isFinite(cents) ? cents : 0) / 100);
}

/**
 * Formats an integer quantity using es-AR grouping rules.
 * @param {number} value
 * @returns {string}
 */
export function formatInteger(value) {
    return INTEGER_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

