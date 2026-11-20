import { DomainError } from '../inventoryStore.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export const DEFAULT_FALLBACK_MODELS = Object.freeze([
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
]);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_SINGLE_MODEL_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 503]);
const EXCLUDED_MODEL_PATTERN =
    /(?:^|-)(?:tts|image|transcribe|robotics|computer-use|customtools|omni|embedding|aqa|vision)(?:$|-)|nano-banana/i;

const MODEL_COOLDOWN_UNAVAILABLE_MS = 24 * 60 * 60 * 1000;
const MODEL_COOLDOWN_QUOTA_DEFAULT_MS = 60 * 60 * 1000;
const MODEL_COOLDOWN_503_MS = 90 * 1000;
const MODEL_COOLDOWN_RPM_MS = 60 * 1000;
const MODEL_COOLDOWN_TRANSIENT_MS = 30 * 1000;

export const MODEL_HEALTH_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    COOLDOWN: 'COOLDOWN',
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
    UNAVAILABLE: 'UNAVAILABLE'
});

const EXTRACTION_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        documentType: {
            type: 'STRING',
            enum: ['PURCHASE', 'SALE']
        },
        documentNumber: { type: 'STRING' },
        issueDate: { type: 'STRING' },
        party: {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING' },
                taxId: { type: 'STRING' },
                email: { type: 'STRING' },
                phone: { type: 'STRING' }
            },
            required: ['name']
        },
        items: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    sku: { type: 'STRING' },
                    name: { type: 'STRING' },
                    category: { type: 'STRING' },
                    quantity: { type: 'NUMBER' },
                    unitPrice: { type: 'NUMBER' }
                },
                required: ['name', 'quantity', 'unitPrice']
            }
        },
        taxAmount: { type: 'NUMBER' },
        declaredTotal: { type: 'NUMBER' },
        notes: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
        warnings: {
            type: 'ARRAY',
            items: { type: 'STRING' }
        }
    },
    required: ['documentType', 'party', 'items', 'confidence']
};

function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelId(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/^models\//i, '');
}

/**
 * Checks whether a Gemini model ID or ListModels entry supports structured multimodal invoice extraction.
 * @param {string | { name?: string, supportedGenerationMethods?: string[] }} modelEntryOrId
 */
export function isSupportedExtractionModel(modelEntryOrId) {
    if (!modelEntryOrId) {
        return false;
    }

    let rawName = '';
    if (typeof modelEntryOrId === 'string') {
        rawName = modelEntryOrId;
    } else if (typeof modelEntryOrId === 'object') {
        if (
            !Array.isArray(modelEntryOrId.supportedGenerationMethods) ||
            !modelEntryOrId.supportedGenerationMethods.includes('generateContent')
        ) {
            return false;
        }
        rawName = modelEntryOrId.name ?? '';
    } else {
        return false;
    }

    const id = normalizeModelId(rawName);
    if (!id || !/^gemini-/i.test(id)) {
        return false;
    }

    return !EXCLUDED_MODEL_PATTERN.test(id);
}

function parseGeminiVersion(modelId) {
    const match = /^gemini-(\d+)(?:\.(\d+))?-/i.exec(modelId);
    if (!match) {
        return { major: 0, minor: 0 };
    }
    return {
        major: Number(match[1]) || 0,
        minor: Number(match[2]) || 0
    };
}

function getModelTierInfo(modelId, preferredRankMap) {
    const lower = modelId.toLowerCase();
    const { major, minor } = parseGeminiVersion(lower);

    if (preferredRankMap.has(lower)) {
        return {
            tier: 1,
            preferredIndex: preferredRankMap.get(lower),
            previewRank: 0,
            major,
            minor,
            id: modelId
        };
    }

    const isLite = /flash-lite/.test(lower);
    const isFlash = /flash/.test(lower) && !isLite;
    const isPro = /(?:^|-)pro(?:$|-)/.test(lower);
    const isLatest = /-latest$/.test(lower);
    const isPreview = /-preview(?:$|-)/.test(lower);

    if (isFlash && !isPreview && !isLatest) {
        return { tier: 2, preferredIndex: 0, previewRank: 0, major, minor, id: modelId };
    }

    if (isLite && !isPreview && !isLatest) {
        return { tier: 3, preferredIndex: 0, previewRank: 0, major, minor, id: modelId };
    }

    if ((isFlash || isLite) && (isLatest || isPreview)) {
        return {
            tier: 4,
            preferredIndex: isLite ? 1 : 0,
            previewRank: isLatest ? 0 : 1,
            major,
            minor,
            id: modelId
        };
    }

    if (isPro) {
        return {
            tier: 5,
            preferredIndex: 0,
            previewRank: isPreview ? 1 : 0,
            major,
            minor,
            id: modelId
        };
    }

    return { tier: 6, preferredIndex: 0, previewRank: 0, major: 0, minor: 0, id: modelId };
}

/**
 * Deduplicates and ranks eligible Gemini models by preference and extraction suitability.
 * @param {string[]} modelIds
 * @param {string[]} [preferredModels=[]]
 */
export function rankGeminiModels(modelIds, preferredModels = []) {
    const preferredRankMap = new Map();
    const cleanPreferred = [];
    for (const rawPref of preferredModels) {
        const clean = normalizeModelId(rawPref);
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (!preferredRankMap.has(lower)) {
            preferredRankMap.set(lower, cleanPreferred.length);
            cleanPreferred.push(clean);
        }
    }

    const uniqueByLower = new Map();
    for (const rawId of modelIds) {
        const clean = normalizeModelId(rawId);
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (!uniqueByLower.has(lower)) {
            uniqueByLower.set(lower, clean);
        }
    }

    return Array.from(uniqueByLower.values()).sort((idA, idB) => {
        const a = getModelTierInfo(idA, preferredRankMap);
        const b = getModelTierInfo(idB, preferredRankMap);

        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.tier === 1) return a.preferredIndex - b.preferredIndex;
        if (a.tier === 5 && a.previewRank !== b.previewRank) return a.previewRank - b.previewRank;
        if (a.tier >= 2 && a.tier <= 5) {
            if (b.major !== a.major) return b.major - a.major;
            if (b.minor !== a.minor) return b.minor - a.minor;
        }
        if (a.tier === 4 && a.preferredIndex !== b.preferredIndex) {
            return a.preferredIndex - b.preferredIndex;
        }
        return a.id.localeCompare(b.id);
    });
}

function readHeaderValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
        return headers.get(name) ?? '';
    }
    const lowerTarget = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lowerTarget && typeof v === 'string') {
            return v;
        }
    }
    return '';
}

/**
 * Parses retry delay hints from Google API error messages and HTTP Retry-After headers.
 * Returns delay in milliseconds, or `null` when absent/unparseable.
 * @param {string} [message='']
 * @param {Headers | Record<string, string> | null} [headers=null]
 * @param {number} [nowMs=Date.now()]
 */
export function parseRetryAfterMs(message = '', headers = null, nowMs = Date.now()) {
    let bestMs = 0;

    const retryHeader = readHeaderValue(headers, 'retry-after').trim();
    if (retryHeader) {
        if (/^\d+(?:\.\d+)?$/.test(retryHeader)) {
            const sec = Number(retryHeader);
            if (Number.isFinite(sec) && sec > 0) {
                bestMs = Math.max(bestMs, Math.ceil(sec * 1000));
            }
        } else {
            const targetMs = Date.parse(retryHeader);
            if (Number.isFinite(targetMs) && targetMs > nowMs) {
                bestMs = Math.max(bestMs, targetMs - nowMs);
            }
        }
    }

    if (typeof message === 'string' && message) {
        const match = /retry\s+in\s+([0-9hms.]+)/i.exec(message);
        if (match && match[1]) {
            const token = match[1];
            const hMatch = /(\d+(?:\.\d+)?)h/i.exec(token);
            const mMatch = /(\d+(?:\.\d+)?)m/i.exec(token);
            const sMatch = /(\d+(?:\.\d+)?)s/i.exec(token);

            const hours = hMatch ? Number(hMatch[1]) : 0;
            const mins = mMatch ? Number(mMatch[1]) : 0;
            const secs = sMatch ? Number(sMatch[1]) : 0;

            if (hours > 0 || mins > 0 || secs > 0) {
                const msgMs = Math.ceil((hours * 3600 + mins * 60 + secs) * 1000);
                if (Number.isFinite(msgMs) && msgMs > 0) {
                    bestMs = Math.max(bestMs, msgMs);
                }
            }
        }
    }

    return bestMs > 0 ? bestMs : null;
}

function buildExtractionPrompt({ fileName, documentTypeHint, catalog }) {
    const productsList = (catalog?.products ?? [])
        .slice(0, 120)
        .map((p) => `- SKU: ${p.sku} | Nombre: ${p.name} | Cat: ${p.category}`)
        .join('\n');

    const suppliersList = (catalog?.suppliers ?? [])
        .slice(0, 60)
        .map((s) => `- ${s.name}${s.taxId ? ` (CUIT/ID: ${s.taxId})` : ''}`)
        .join('\n');

    const customersList = (catalog?.customers ?? [])
        .slice(0, 60)
        .map((c) => `- ${c.name}${c.taxId ? ` (CUIT/DNI: ${c.taxId})` : ''}`)
        .join('\n');

    return [
        'Sos un motor de extracción contable para un sistema ERP en español (Argentina / LatAm).',
        `Archivo recibido: "${fileName}". Tipo sugerido por el usuario: ${documentTypeHint === 'SALE' ? 'SALE (venta/pedido de cliente)' : 'PURCHASE (compra/factura de proveedor)'}.`,
        'Extraé los datos estructurados del comprobante siguiendo estas reglas:',
        '1. Si el comprobante corresponde claramente a una factura de proveedor o remito de compra, usá documentType="PURCHASE". Si es una factura emitida o pedido de cliente, usá documentType="SALE". Si es ambiguo, respetá el tipo sugerido.',
        '2. En "party" colocá los datos de la contraparte (el emisor si es PURCHASE, el comprador si es SALE).',
        '3. Extraé TODAS las líneas de ítems visibles en la tabla del comprobante sin omitir filas. Para cada ítem, si coincide con alguno de los productos del catálogo existente abajo, reutilizá exactamente su SKU. Si es un producto nuevo, proponé un SKU corto alfanumérico en mayúsculas o dejalo vacío.',
        '4. Devolvé precios unitarios ("unitPrice") y cantidades enteras positivas sin símbolo de moneda. Si la factura discrimina impuestos (por ejemplo Factura A con IVA 21%), en "unitPrice" colocá el precio unitario neto de la línea, en "taxAmount" el monto total de impuestos discriminados (o 0 en Factura C / Monotributo), y en "declaredTotal" el total final del comprobante.',
        '5. En "confidence" indicá un número entre 0 y 1. Si algún dato es ilegible o dudoso, agregalo como advertencia en "warnings" sin inventar cifras.',
        '',
        'Catálogo actual de productos:',
        productsList || '(sin productos cargados aún)',
        '',
        'Proveedores registrados:',
        suppliersList || '(sin proveedores registrados aún)',
        '',
        'Clientes registrados:',
        customersList || '(sin clientes registrados aún)'
    ].join('\n');
}

function normalizeFallbackList(fallbackModels, cleanModel, autoDiscover) {
    if (!Array.isArray(fallbackModels)) {
        return [...DEFAULT_FALLBACK_MODELS];
    }
    const clean = fallbackModels.map(normalizeModelId).filter(Boolean);
    if (clean.length === 0 && !autoDiscover) {
        return [];
    }
    return clean;
}

function classifyFailure({ status, message, headers, nowMs }) {
    const text = typeof message === 'string' ? message.trim() : '';
    const isAuthError =
        status === 401 ||
        (status === 403 && /api[_ ]?key|unregistered|credentials|invalid.*key|not valid/i.test(text));

    if (isAuthError) {
        return {
            fatalAuth: true,
            healthStatus: MODEL_HEALTH_STATUS.UNAVAILABLE,
            cooldownMs: MODEL_COOLDOWN_UNAVAILABLE_MS,
            retryableSameModel: false,
            errorMessage: 'La GEMINI_API_KEY configurada es inválida o no tiene permisos para este modelo.'
        };
    }

    const isUnavailable =
        status === 404 ||
        ((status === 400 || status === 403) &&
            /no longer available|not found|not supported|deprecated|permission denied|does not have access|response_schema|json mode|unknown model/i.test(
                text
            ));

    if (isUnavailable) {
        return {
            fatalAuth: false,
            healthStatus: MODEL_HEALTH_STATUS.UNAVAILABLE,
            cooldownMs: MODEL_COOLDOWN_UNAVAILABLE_MS,
            retryableSameModel: false,
            errorMessage: text || `Modelo no disponible (HTTP ${status}).`
        };
    }

    const retryAfterMs = parseRetryAfterMs(text, headers, nowMs);

    if (status === 429) {
        const isDailyQuota =
            /per day|daily|free_tier_requests|limit:\s*0/i.test(text) ||
            (retryAfterMs !== null && retryAfterMs >= 300_000);

        if (isDailyQuota) {
            return {
                fatalAuth: false,
                healthStatus: MODEL_HEALTH_STATUS.QUOTA_EXCEEDED,
                cooldownMs: Math.min(
                    MODEL_COOLDOWN_UNAVAILABLE_MS,
                    retryAfterMs ?? MODEL_COOLDOWN_QUOTA_DEFAULT_MS
                ),
                retryableSameModel: false,
                errorMessage: text || 'Cuota diaria de Gemini agotada para este modelo.'
            };
        }

        return {
            fatalAuth: false,
            healthStatus: MODEL_HEALTH_STATUS.COOLDOWN,
            cooldownMs: Math.min(MODEL_COOLDOWN_UNAVAILABLE_MS, retryAfterMs ?? MODEL_COOLDOWN_RPM_MS),
            retryableSameModel: true,
            errorMessage: text || 'Límite de solicitudes por minuto alcanzado (HTTP 429).'
        };
    }

    if (status === 503) {
        return {
            fatalAuth: false,
            healthStatus: MODEL_HEALTH_STATUS.COOLDOWN,
            cooldownMs: retryAfterMs ?? MODEL_COOLDOWN_503_MS,
            retryableSameModel: true,
            errorMessage: text || 'Modelo con alta demanda temporal (HTTP 503).'
        };
    }

    return {
        fatalAuth: false,
        healthStatus: MODEL_HEALTH_STATUS.COOLDOWN,
        cooldownMs: MODEL_COOLDOWN_RPM_MS,
        retryableSameModel: false,
        errorMessage: text || `Error devuelto por Gemini (HTTP ${status}).`
    };
}

/**
 * Google Gemini multimodal structured extractor adapter with automatic model discovery
 * and failover rotation across available Gemini models.
 * Keeps the API key strictly server-side using the `x-goog-api-key` header.
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   fallbackModels?: string[],
 *   autoDiscover?: boolean,
 *   fetchImpl?: typeof fetch,
 *   retryDelayMs?: number,
 *   discoveryTtlMs?: number,
 *   requestTimeoutMs?: number,
 *   nowFn?: () => number
 * }} [options]
 */
export function createGeminiExtractor({
    apiKey = '',
    model = DEFAULT_GEMINI_MODEL,
    fallbackModels = DEFAULT_FALLBACK_MODELS,
    autoDiscover = true,
    fetchImpl = globalThis.fetch,
    retryDelayMs = 800,
    discoveryTtlMs = 10 * 60 * 1000,
    requestTimeoutMs = 45000,
    nowFn = () => Date.now()
} = {}) {
    const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    const cleanModel = normalizeModelId(model) || DEFAULT_GEMINI_MODEL;
    const explicitFallbacks = normalizeFallbackList(fallbackModels, cleanModel, autoDiscover);
    const preferredOrder = [];
    for (const candidate of [cleanModel, ...explicitFallbacks]) {
        if (candidate && !preferredOrder.includes(candidate)) {
            preferredOrder.push(candidate);
        }
    }

    const healthMap = new Map();
    let discoveredModels = null;
    let lastDiscoveryAt = null;
    let lastDiscoveryMs = null;
    let activeModel = cleanModel;

    function getCandidateModels() {
        if (!Array.isArray(discoveredModels) || discoveredModels.length === 0) {
            return [...preferredOrder];
        }
        return rankGeminiModels([...preferredOrder, ...discoveredModels], preferredOrder);
    }

    function getHealthSnapshot(modelId, now) {
        const entry = healthMap.get(modelId);
        if (!entry) {
            return {
                model: modelId,
                status: MODEL_HEALTH_STATUS.AVAILABLE,
                available: true,
                cooldownUntil: null,
                lastError: '',
                lastUsedAt: null,
                successCount: 0,
                failureCount: 0
            };
        }

        const expired =
            entry.status !== MODEL_HEALTH_STATUS.AVAILABLE &&
            entry.cooldownUntilMs > 0 &&
            now >= entry.cooldownUntilMs;

        if (expired) {
            entry.status = MODEL_HEALTH_STATUS.AVAILABLE;
            entry.cooldownUntilMs = 0;
            entry.lastError = '';
        }

        const available = entry.status === MODEL_HEALTH_STATUS.AVAILABLE;
        return {
            model: modelId,
            status: entry.status,
            available,
            cooldownUntil:
                !available && entry.cooldownUntilMs > 0
                    ? new Date(entry.cooldownUntilMs).toISOString()
                    : null,
            lastError: entry.lastError,
            lastUsedAt: entry.lastUsedAt,
            successCount: entry.successCount,
            failureCount: entry.failureCount
        };
    }

    function recordModelFailure(modelId, healthStatus, cooldownMs, errorMessage, now) {
        const prev = healthMap.get(modelId) ?? {
            status: MODEL_HEALTH_STATUS.AVAILABLE,
            cooldownUntilMs: 0,
            lastError: '',
            lastUsedAt: null,
            successCount: 0,
            failureCount: 0
        };
        healthMap.set(modelId, {
            ...prev,
            status: healthStatus,
            cooldownUntilMs: cooldownMs > 0 ? now + cooldownMs : 0,
            lastError: errorMessage,
            failureCount: prev.failureCount + 1
        });
    }

    function recordModelSuccess(modelId, now) {
        const prev = healthMap.get(modelId) ?? {
            status: MODEL_HEALTH_STATUS.AVAILABLE,
            cooldownUntilMs: 0,
            lastError: '',
            lastUsedAt: null,
            successCount: 0,
            failureCount: 0
        };
        healthMap.set(modelId, {
            ...prev,
            status: MODEL_HEALTH_STATUS.AVAILABLE,
            cooldownUntilMs: 0,
            lastError: '',
            lastUsedAt: new Date(now).toISOString(),
            successCount: prev.successCount + 1
        });
        activeModel = modelId;
    }

    function resolveActiveModel(snapshots) {
        const sticky = snapshots.find((s) => s.model === activeModel && s.available);
        if (sticky) return sticky.model;
        const firstAvailable = snapshots.find((s) => s.available);
        if (firstAvailable) return firstAvailable.model;
        return snapshots[0]?.model ?? cleanModel;
    }

    function getStatus() {
        const now = nowFn();
        const candidates = getCandidateModels();
        const models = candidates.map((id) => getHealthSnapshot(id, now));
        const resolvedActive = resolveActiveModel(models);
        activeModel = resolvedActive;
        const availableCount = models.filter((m) => m.available).length;

        return {
            configured: Boolean(cleanKey),
            provider: 'gemini',
            model: resolvedActive,
            preferredModel: cleanModel,
            autoRotate: candidates.length > 1 || Boolean(autoDiscover),
            availableCount,
            totalModels: models.length,
            lastDiscoveryAt,
            models
        };
    }

    async function fetchWithTimeout(url, init) {
        if (!requestTimeoutMs || requestTimeoutMs <= 0) {
            return fetchImpl(url, init);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            return await fetchImpl(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async function refreshAvailableModels({ force = false, resetCooldowns = false } = {}) {
        if (resetCooldowns) {
            for (const entry of healthMap.values()) {
                entry.status = MODEL_HEALTH_STATUS.AVAILABLE;
                entry.cooldownUntilMs = 0;
                entry.lastError = '';
            }
            activeModel = cleanModel;
        }

        if (!cleanKey || !autoDiscover) {
            return getStatus();
        }

        const now = nowFn();
        if (!force && lastDiscoveryMs !== null && now - lastDiscoveryMs < discoveryTtlMs) {
            return getStatus();
        }

        try {
            const response = await fetchWithTimeout(`${GEMINI_API_BASE}?pageSize=100`, {
                method: 'GET',
                headers: {
                    'x-goog-api-key': cleanKey
                }
            });

            const payload = await response.json().catch(() => null);
            if (response.ok && Array.isArray(payload?.models)) {
                const eligible = payload.models
                    .filter((entry) => isSupportedExtractionModel(entry))
                    .map((entry) => normalizeModelId(entry.name))
                    .filter(Boolean);

                discoveredModels = eligible;
                const finishNow = nowFn();
                lastDiscoveryMs = finishNow;
                lastDiscoveryAt = new Date(finishNow).toISOString();
            }
        } catch {
            // Keep configured/fallback models intact when discovery cannot reach the API.
        }

        return getStatus();
    }

    async function extractInvoice({
        fileName,
        mimeType,
        buffer,
        textContent = '',
        documentTypeHint = 'PURCHASE',
        catalog
    }) {
        if (!cleanKey) {
            throw new DomainError(
                'Falta configurar GEMINI_API_KEY en el servidor (.env) para procesar comprobantes con IA.',
                {
                    status: 503,
                    code: 'AI_NOT_CONFIGURED'
                }
            );
        }

        if (autoDiscover && lastDiscoveryAt === null) {
            await refreshAvailableModels();
        }

        const now = nowFn();
        const allCandidates = getCandidateModels();
        const snapshots = allCandidates.map((id) => getHealthSnapshot(id, now));
        const healthyIds = snapshots.filter((s) => s.available).map((s) => s.model);

        if (healthyIds.length === 0) {
            const latestErr =
                snapshots.find((s) => s.lastError)?.lastError ?? 'cuota agotada o modelos en pausa temporal';
            throw new DomainError(
                `No hay modelos de Gemini disponibles en este momento (0/${allCandidates.length} activos). Último motivo: ${latestErr}`,
                { status: 503, code: 'AI_ALL_MODELS_UNAVAILABLE' }
            );
        }

        const orderedCandidates = healthyIds.includes(activeModel)
            ? [activeModel, ...healthyIds.filter((id) => id !== activeModel)]
            : healthyIds;

        const promptText = buildExtractionPrompt({ fileName, documentTypeHint, catalog });
        const parts = [{ text: promptText }];

        if (mimeType === 'text/plain') {
            const text = textContent || buffer.toString('utf8');
            parts.push({ text: `\n--- CONTENIDO DEL COMPROBANTE ---\n${text}` });
        } else {
            parts.push({
                inlineData: {
                    mimeType,
                    data: buffer.toString('base64')
                }
            });
        }

        const requestBody = JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: EXTRACTION_RESPONSE_SCHEMA
            }
        });

        const attemptedModels = [];
        const attemptErrors = [];
        let incompleteFallback = null;
        const maxAttemptsPerModel = allCandidates.length === 1 ? MAX_SINGLE_MODEL_RETRIES + 1 : 1;

        for (let idx = 0; idx < orderedCandidates.length; idx += 1) {
            const candidateModel = orderedCandidates[idx];
            const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(candidateModel)}:generateContent`;
            attemptedModels.push(candidateModel);

            for (let attempt = 0; attempt < maxAttemptsPerModel; attempt += 1) {
                if (attempt > 0) {
                    await sleep(retryDelayMs * attempt);
                }

                let response;
                try {
                    response = await fetchWithTimeout(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': cleanKey
                        },
                        body: requestBody
                    });
                } catch (networkError) {
                    const isTimeout = networkError?.name === 'AbortError';
                    const message = isTimeout
                        ? `Tiempo de espera agotado al consultar ${candidateModel}.`
                        : `Error de red al consultar ${candidateModel}: ${networkError instanceof Error ? networkError.message : 'sin conexión'}`;

                    if (attempt + 1 < maxAttemptsPerModel) {
                        continue;
                    }
                    recordModelFailure(
                        candidateModel,
                        MODEL_HEALTH_STATUS.COOLDOWN,
                        MODEL_COOLDOWN_TRANSIENT_MS,
                        message,
                        nowFn()
                    );
                    attemptErrors.push(`${candidateModel}: ${message}`);
                    break;
                }

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    const classification = classifyFailure({
                        status: response.status,
                        message: payload?.error?.message,
                        headers: response.headers,
                        nowMs: nowFn()
                    });

                    if (classification.fatalAuth) {
                        throw new DomainError(classification.errorMessage, {
                            status: 502,
                            code: 'AI_AUTH_ERROR'
                        });
                    }

                    if (
                        RETRYABLE_STATUSES.has(response.status) &&
                        classification.retryableSameModel &&
                        attempt + 1 < maxAttemptsPerModel
                    ) {
                        continue;
                    }

                    recordModelFailure(
                        candidateModel,
                        classification.healthStatus,
                        classification.cooldownMs,
                        classification.errorMessage,
                        nowFn()
                    );
                    attemptErrors.push(`${candidateModel}: ${classification.errorMessage}`);
                    break;
                }

                const rawJsonText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!rawJsonText || typeof rawJsonText !== 'string') {
                    const msg = `${candidateModel} devolvió una respuesta vacía o sin contenido estructurado.`;
                    recordModelFailure(
                        candidateModel,
                        MODEL_HEALTH_STATUS.COOLDOWN,
                        MODEL_COOLDOWN_TRANSIENT_MS,
                        msg,
                        nowFn()
                    );
                    attemptErrors.push(msg);
                    break;
                }

                let rawExtraction;
                try {
                    rawExtraction = JSON.parse(rawJsonText);
                } catch {
                    const msg = `La respuesta de ${candidateModel} no es un JSON válido.`;
                    recordModelFailure(
                        candidateModel,
                        MODEL_HEALTH_STATUS.COOLDOWN,
                        MODEL_COOLDOWN_TRANSIENT_MS,
                        msg,
                        nowFn()
                    );
                    attemptErrors.push(msg);
                    break;
                }

                const isSuspiciousEmpty =
                    Array.isArray(rawExtraction?.items) &&
                    rawExtraction.items.length === 0 &&
                    !rawExtraction?.documentNumber &&
                    !rawExtraction?.declaredTotal &&
                    mimeType !== 'text/plain';

                if (isSuspiciousEmpty && !incompleteFallback && idx < orderedCandidates.length - 1) {
                    incompleteFallback = {
                        rawExtraction,
                        provider: 'gemini',
                        model: candidateModel,
                        attemptedModels: [...attemptedModels]
                    };
                    break;
                }

                recordModelSuccess(candidateModel, nowFn());
                return {
                    rawExtraction,
                    provider: 'gemini',
                    model: candidateModel,
                    attemptedModels: [...attemptedModels]
                };
            }
        }

        if (incompleteFallback) {
            recordModelSuccess(incompleteFallback.model, nowFn());
            return {
                ...incompleteFallback,
                attemptedModels: [...attemptedModels]
            };
        }

        const latestReason = attemptErrors[attemptErrors.length - 1] || 'Sin modelos disponibles.';
        throw new DomainError(
            `Ningún modelo de Gemini pudo procesar el comprobante (${attemptedModels.length} modelo/s probado/s). Último motivo: ${latestReason}`,
            {
                status: 503,
                code: 'AI_ALL_MODELS_UNAVAILABLE'
            }
        );
    }

    return {
        getStatus,
        refreshAvailableModels,
        extractInvoice
    };
}
