import fs from 'node:fs';

/**
 * Loads KEY=VALUE pairs from a local `.env` file into `process.env` without overwriting
 * variables already set by the host environment or process runner.
 * @param {string} filePath
 */
export function loadEnvFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return {};
    }

    const loaded = {};
    const raw = fs.readFileSync(filePath, 'utf8');

    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) {
            continue;
        }

        const key = line.slice(0, eqIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }

        let value = line.slice(eqIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }

        loaded[key] = value;
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }

    return loaded;
}

