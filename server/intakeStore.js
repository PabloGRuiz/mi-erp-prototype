import crypto from 'node:crypto';
import {
    ALLOWED_INTAKE_MIME_TYPES,
    calculateIntakeQueueStats,
    INTAKE_DOC_TYPES,
    INTAKE_STATUS,
    MAX_INTAKE_BATCH_FILES,
    MAX_INTAKE_FILE_BYTES,
    reconcileExtractedDocument,
    validateIntakeReviewPayload
} from '../src/domain/intake.js';
import { centsToInputValue } from '../src/domain/money.js';
import { runInTransaction } from './db.js';
import { DomainError } from './inventoryStore.js';

const SYSTEM_ACTOR = Object.freeze({ id: null, username: 'sistema' });
const ALLOWED_MIME_SET = new Set(ALLOWED_INTAKE_MIME_TYPES);

function normalizeActor(actor) {
    if (!actor || typeof actor !== 'object') {
        return SYSTEM_ACTOR;
    }
    return {
        id: typeof actor.id === 'string' && actor.id ? actor.id : null,
        username: typeof actor.username === 'string' && actor.username ? actor.username : 'sistema'
    };
}

function safeParseJson(raw, fallback) {
    if (!raw || typeof raw !== 'string') {
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function mapIntakeRow(row) {
    return {
        id: row.id,
        batchId: row.batch_id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        contentHash: row.content_hash,
        documentType: row.document_type,
        status: row.status,
        aiProvider: row.ai_provider,
        aiModel: row.ai_model,
        confidence: row.confidence,
        duplicateOfId: row.duplicate_of_id ?? null,
        rawExtraction: safeParseJson(row.raw_extraction_json, {}),
        reviewPayload: safeParseJson(row.review_payload_json, {}),
        warnings: safeParseJson(row.warnings_json, []),
        errorMessage: row.error_message ?? '',
        approvedOrderType: row.approved_order_type ?? null,
        approvedOrderId: row.approved_order_id ?? null,
        approvedOrderNumber: row.approved_order_number ?? null,
        createdByUserId: row.created_by_user_id ?? null,
        createdByUsername: row.created_by_username ?? 'sistema',
        reviewedByUserId: row.reviewed_by_user_id ?? null,
        reviewedByUsername: row.reviewed_by_username ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        approvedAt: row.approved_at ?? null
    };
}

/**
 * SQLite store for staged AI document intakes, review edits, duplicate checks, and atomic approval.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   inventoryStore: ReturnType<import('./inventoryStore.js').createInventoryStore>,
 *   operationsStore: ReturnType<import('./operationsStore.js').createOperationsStore>
 * }} deps
 */
export function createIntakeStore(db, { inventoryStore, operationsStore }) {
    const selectIntakeByIdStmt = db.prepare('SELECT * FROM document_intakes WHERE id = ?');
    const selectExistingHashStmt = db.prepare(
        "SELECT id FROM document_intakes WHERE content_hash = ? AND status NOT IN ('REJECTED', 'ERROR') ORDER BY created_at ASC, rowid ASC LIMIT 1"
    );
    const selectExistingRefMatchStmt = db.prepare(
        `SELECT id, approved_order_number
         FROM document_intakes
         WHERE status = 'APPROVED' AND id != ?
           AND json_extract(review_payload_json, '$.documentNumber') = ?
         LIMIT 1`
    );
    const insertIntakeStmt = db.prepare(
        `INSERT INTO document_intakes (
            id, batch_id, file_name, mime_type, content_hash, document_type, status,
            ai_provider, ai_model, confidence, duplicate_of_id,
            raw_extraction_json, review_payload_json, warnings_json, error_message,
            created_by_user_id, created_by_username, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markProcessingStmt = db.prepare(
        "UPDATE document_intakes SET status = 'PROCESSING', updated_at = ? WHERE id = ?"
    );
    const markReadyStmt = db.prepare(
        `UPDATE document_intakes
         SET document_type = ?, status = 'READY_FOR_REVIEW', ai_provider = ?, ai_model = ?,
             confidence = ?, raw_extraction_json = ?, review_payload_json = ?, warnings_json = ?,
             error_message = '', updated_at = ?
         WHERE id = ?`
    );
    const markErrorStmt = db.prepare(
        `UPDATE document_intakes
         SET status = 'ERROR', error_message = ?, updated_at = ?
         WHERE id = ?`
    );
    const updateReviewStmt = db.prepare(
        `UPDATE document_intakes
         SET document_type = ?, status = 'READY_FOR_REVIEW', review_payload_json = ?,
             error_message = '', reviewed_by_user_id = ?, reviewed_by_username = ?, updated_at = ?
         WHERE id = ?`
    );
    const markRejectedStmt = db.prepare(
        `UPDATE document_intakes
         SET status = 'REJECTED', reviewed_by_user_id = ?, reviewed_by_username = ?, updated_at = ?
         WHERE id = ?`
    );
    const markErrorsRejectedStmt = db.prepare(
        `UPDATE document_intakes
         SET status = 'REJECTED', reviewed_by_user_id = ?, reviewed_by_username = ?, updated_at = ?
         WHERE status = 'ERROR'`
    );
    const markApprovedStmt = db.prepare(
        `UPDATE document_intakes
         SET status = 'APPROVED', document_type = ?, review_payload_json = ?,
             approved_order_type = ?, approved_order_id = ?, approved_order_number = ?,
             reviewed_by_user_id = ?, reviewed_by_username = ?, updated_at = ?, approved_at = ?
         WHERE id = ?`
    );

    function listIntakes({ status = '', batchId = '', limit = 100 } = {}) {
        const conditions = [];
        const params = [];

        if (status && status !== 'all') {
            conditions.push('status = ?');
            params.push(String(status).trim().toUpperCase());
        }

        if (batchId) {
            conditions.push('batch_id = ?');
            params.push(String(batchId).trim());
        }

        const parsedLimit = Number(limit);
        const safeLimit =
            Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100;
        params.push(safeLimit);

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT * FROM document_intakes ${whereClause} ORDER BY created_at DESC, rowid DESC LIMIT ?`;

        return db.prepare(sql).all(...params).map(mapIntakeRow);
    }

    function getIntakeById(id) {
        const row = selectIntakeByIdStmt.get(id);
        return row ? mapIntakeRow(row) : null;
    }

    function getCatalogSnapshot() {
        return {
            products: inventoryStore.listProducts(),
            suppliers: operationsStore.listSuppliers(),
            customers: operationsStore.listCustomers()
        };
    }

    function prepareDocumentPayloads(documents) {
        if (!Array.isArray(documents) || documents.length === 0) {
            throw new DomainError('Seleccioná al menos un archivo o comprobante para procesar.', {
                status: 400,
                field: 'documents',
                code: 'VALIDATION_ERROR'
            });
        }

        if (documents.length > MAX_INTAKE_BATCH_FILES) {
            throw new DomainError(`Podés subir hasta ${MAX_INTAKE_BATCH_FILES} comprobantes por lote.`, {
                status: 400,
                field: 'documents',
                code: 'BATCH_TOO_LARGE'
            });
        }

        return documents.map((doc, index) => {
            const fileName =
                typeof doc?.fileName === 'string' && doc.fileName.trim()
                    ? doc.fileName.trim().slice(0, 180)
                    : `comprobante-${index + 1}.txt`;
            const mimeType = typeof doc?.mimeType === 'string' ? doc.mimeType.trim().toLowerCase() : '';

            if (!ALLOWED_MIME_SET.has(mimeType)) {
                throw new DomainError(
                    `El archivo "${fileName}" tiene un formato no soportado (${mimeType || 'desconocido'}).`,
                    { status: 400, field: 'documents', code: 'UNSUPPORTED_MEDIA_TYPE' }
                );
            }

            const documentTypeHint =
                doc?.documentTypeHint === INTAKE_DOC_TYPES.SALE
                    ? INTAKE_DOC_TYPES.SALE
                    : INTAKE_DOC_TYPES.PURCHASE;

            let buffer;
            let textContent = '';
            if (mimeType === 'text/plain') {
                if (typeof doc?.textContent === 'string') {
                    textContent = doc.textContent;
                    buffer = Buffer.from(textContent, 'utf8');
                } else if (typeof doc?.contentBase64 === 'string') {
                    buffer = Buffer.from(doc.contentBase64, 'base64');
                    textContent = buffer.toString('utf8');
                } else {
                    buffer = Buffer.alloc(0);
                }
            } else {
                const rawB64 = typeof doc?.contentBase64 === 'string' ? doc.contentBase64.trim() : '';
                buffer = rawB64 ? Buffer.from(rawB64, 'base64') : Buffer.alloc(0);
            }

            if (buffer.length === 0) {
                throw new DomainError(`El comprobante "${fileName}" está vacío.`, {
                    status: 400,
                    field: 'documents',
                    code: 'EMPTY_DOCUMENT'
                });
            }

            if (buffer.length > MAX_INTAKE_FILE_BYTES) {
                throw new DomainError(
                    `El comprobante "${fileName}" supera el máximo de ${Math.round(MAX_INTAKE_FILE_BYTES / (1024 * 1024))} MB.`,
                    { status: 413, field: 'documents', code: 'FILE_TOO_LARGE' }
                );
            }

            const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

            return {
                fileName,
                mimeType,
                documentTypeHint,
                buffer,
                textContent,
                contentHash
            };
        });
    }

    function enqueueBatch(documents, actor = SYSTEM_ACTOR) {
        const prepared = prepareDocumentPayloads(documents);
        const safeActor = normalizeActor(actor);

        return runInTransaction(db, () => {
            const batchId = crypto.randomUUID();
            const now = new Date().toISOString();
            const seenInBatch = new Map();
            const intakes = [];
            const payloadsForProcessing = [];

            for (const item of prepared) {
                const existingDup = selectExistingHashStmt.get(item.contentHash);
                const duplicateOfId = existingDup?.id ?? seenInBatch.get(item.contentHash) ?? null;
                const initialWarnings = duplicateOfId
                    ? ['Archivo idéntico ya fue cargado anteriormente en la bandeja de ingesta.']
                    : [];

                const id = crypto.randomUUID();
                if (!seenInBatch.has(item.contentHash)) {
                    seenInBatch.set(item.contentHash, id);
                }

                insertIntakeStmt.run(
                    id,
                    batchId,
                    item.fileName,
                    item.mimeType,
                    item.contentHash,
                    item.documentTypeHint,
                    INTAKE_STATUS.PENDING,
                    'gemini',
                    '',
                    0,
                    duplicateOfId,
                    '{}',
                    '{}',
                    JSON.stringify(initialWarnings),
                    '',
                    safeActor.id,
                    safeActor.username,
                    now,
                    now
                );

                intakes.push(getIntakeById(id));
                payloadsForProcessing.push({
                    id,
                    ...item,
                    initialWarnings
                });
            }

            return { batchId, intakes, payloadsForProcessing };
        });
    }

    async function processSingleItem(item, extractor) {
        const startNow = new Date().toISOString();
        markProcessingStmt.run(startNow, item.id);

        try {
            const catalog = getCatalogSnapshot();
            const extractionResult = await extractor.extractInvoice({
                fileName: item.fileName,
                mimeType: item.mimeType,
                buffer: item.buffer,
                textContent: item.textContent,
                documentTypeHint: item.documentTypeHint,
                catalog
            });

            const reconciled = reconcileExtractedDocument(
                extractionResult.rawExtraction,
                catalog,
                item.documentTypeHint
            );

            const warnings = [...item.initialWarnings, ...reconciled.warnings];
            if (reconciled.reviewPayload.documentNumber) {
                const existingRef = selectExistingRefMatchStmt.get(
                    item.id,
                    reconciled.reviewPayload.documentNumber
                );
                if (existingRef) {
                    warnings.push(
                        `El número de comprobante "${reconciled.reviewPayload.documentNumber}" ya fue aprobado anteriormente (${existingRef.approved_order_number ?? existingRef.id}).`
                    );
                }
            }

            const endNow = new Date().toISOString();
            markReadyStmt.run(
                reconciled.documentType,
                extractionResult.provider,
                extractionResult.model,
                reconciled.confidence,
                JSON.stringify(extractionResult.rawExtraction),
                JSON.stringify(reconciled.reviewPayload),
                JSON.stringify([...new Set(warnings)]),
                endNow,
                item.id
            );
            return { ok: true };
        } catch (error) {
            const failNow = new Date().toISOString();
            const message =
                error instanceof Error ? error.message : 'Error inesperado al extraer el comprobante.';
            markErrorStmt.run(message, failNow, item.id);
            return { ok: false, error };
        }
    }

    async function processBatch(payloadsForProcessing, extractor, { concurrency = 1 } = {}) {
        const queue = [...payloadsForProcessing];
        const workerCount = Math.max(1, Math.min(concurrency, queue.length));
        let abortError = null;

        async function worker() {
            while (queue.length > 0) {
                const nextItem = queue.shift();
                if (!nextItem) continue;

                if (abortError) {
                    const failNow = new Date().toISOString();
                    const message =
                        abortError instanceof Error
                            ? abortError.message
                            : 'No hay modelos de Gemini disponibles en este momento.';
                    markErrorStmt.run(message, failNow, nextItem.id);
                    continue;
                }

                const outcome = await processSingleItem(nextItem, extractor);
                if (
                    outcome &&
                    !outcome.ok &&
                    (outcome.error?.code === 'AI_AUTH_ERROR' ||
                        outcome.error?.code === 'AI_ALL_MODELS_UNAVAILABLE')
                ) {
                    abortError = outcome.error;
                }
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return payloadsForProcessing.map((item) => getIntakeById(item.id));
    }

    function updateIntakeReview(id, reviewPayload, actor = SYSTEM_ACTOR) {
        return runInTransaction(db, () => {
            const existing = getIntakeById(id);
            if (!existing) {
                throw new DomainError('Registro de ingesta no encontrado.', {
                    status: 404,
                    code: 'INTAKE_NOT_FOUND'
                });
            }

            if (
                existing.status !== INTAKE_STATUS.READY_FOR_REVIEW &&
                existing.status !== INTAKE_STATUS.ERROR
            ) {
                throw new DomainError(
                    'Solo podés editar comprobantes pendientes de revisión.',
                    { status: 409, code: 'INVALID_STATUS' }
                );
            }

            const catalog = getCatalogSnapshot();
            const validation = validateIntakeReviewPayload(reviewPayload, catalog);
            if (!validation.ok) {
                throw new DomainError(validation.error, {
                    status:
                        validation.code === 'INSUFFICIENT_STOCK' ||
                        validation.code === 'DUPLICATE_SKU'
                            ? 409
                            : 400,
                    field: validation.field,
                    code: validation.code
                });
            }

            const safeActor = normalizeActor(actor);
            const now = new Date().toISOString();
            const cleanPayload = {
                ...validation.data,
                items: validation.data.items.map((item) => ({
                    productId: item.productId,
                    createProduct: item.createProduct,
                    sku: item.sku,
                    name: item.name,
                    category: item.category,
                    quantity: item.quantity,
                    unitCost: item.unitCost,
                    salePrice: item.salePrice,
                    minStock: item.minStock,
                    rawDescription: item.rawDescription
                }))
            };

            updateReviewStmt.run(
                validation.data.documentType,
                JSON.stringify(cleanPayload),
                safeActor.id,
                safeActor.username,
                now,
                id
            );

            return getIntakeById(id);
        });
    }

    function rejectIntake(id, actor = SYSTEM_ACTOR) {
        return runInTransaction(db, () => {
            const existing = getIntakeById(id);
            if (!existing) {
                throw new DomainError('Registro de ingesta no encontrado.', {
                    status: 404,
                    code: 'INTAKE_NOT_FOUND'
                });
            }

            if (existing.status === INTAKE_STATUS.APPROVED) {
                throw new DomainError('No podés rechazar un comprobante que ya fue aprobado.', {
                    status: 409,
                    code: 'INVALID_STATUS'
                });
            }

            const safeActor = normalizeActor(actor);
            const now = new Date().toISOString();
            markRejectedStmt.run(safeActor.id, safeActor.username, now, id);
            return getIntakeById(id);
        });
    }

    function rejectAllErrors(actor = SYSTEM_ACTOR) {
        return runInTransaction(db, () => {
            const safeActor = normalizeActor(actor);
            const now = new Date().toISOString();
            const result = markErrorsRejectedStmt.run(safeActor.id, safeActor.username, now);
            return { rejectedCount: Number(result.changes ?? 0) };
        });
    }

    function approveIntake(id, actor = SYSTEM_ACTOR) {
        return runInTransaction(db, () => {
            const existing = getIntakeById(id);
            if (!existing) {
                throw new DomainError('Registro de ingesta no encontrado.', {
                    status: 404,
                    code: 'INTAKE_NOT_FOUND'
                });
            }

            if (existing.status !== INTAKE_STATUS.READY_FOR_REVIEW) {
                throw new DomainError(
                    'El comprobante debe estar en estado "Lista para revisar" antes de aprobarlo.',
                    { status: 409, code: 'INVALID_STATUS' }
                );
            }

            const catalog = getCatalogSnapshot();
            const validation = validateIntakeReviewPayload(existing.reviewPayload, catalog);
            if (!validation.ok) {
                throw new DomainError(validation.error, {
                    status:
                        validation.code === 'INSUFFICIENT_STOCK' ||
                        validation.code === 'DUPLICATE_SKU'
                            ? 409
                            : 400,
                    field: validation.field,
                    code: validation.code
                });
            }

            const safeActor = normalizeActor(actor);
            const data = validation.data;
            let resolvedPartyId = data.partyId;
            let createdParty = null;

            if (!resolvedPartyId && data.createParty) {
                if (data.documentType === INTAKE_DOC_TYPES.PURCHASE) {
                    createdParty = operationsStore.createSupplier(data.partyDraft);
                    resolvedPartyId = createdParty.id;
                } else {
                    createdParty = operationsStore.createCustomer(data.partyDraft);
                    resolvedPartyId = createdParty.id;
                }
            }

            const createdProducts = [];
            const resolvedOrderItems = [];

            for (const item of data.items) {
                let targetProductId = item.productId;
                if (!targetProductId && item.createProduct) {
                    const created = inventoryStore.createProduct(
                        {
                            sku: item.sku,
                            name: item.name,
                            category: item.category,
                            price: item.salePrice,
                            stock: '0',
                            minStock: String(item.minStock)
                        },
                        safeActor
                    );
                    createdProducts.push(created.product);
                    targetProductId = created.product.id;
                }

                resolvedOrderItems.push({
                    productId: targetProductId,
                    quantity: item.quantity,
                    unitCost: centsToInputValue(item.unitCostCents)
                });
            }

            let order;
            let approvedOrderNumber;
            if (data.documentType === INTAKE_DOC_TYPES.PURCHASE) {
                order = operationsStore.createPurchase(
                    {
                        supplierId: resolvedPartyId,
                        receiveNow: data.receiveNow,
                        notes: data.notes || (data.documentNumber ? `Comprobante ${data.documentNumber}` : ''),
                        items: resolvedOrderItems
                    },
                    safeActor
                );
                approvedOrderNumber = order.orderNumber;
            } else {
                order = operationsStore.createSale(
                    {
                        customerId: resolvedPartyId || '',
                        notes: data.notes || (data.documentNumber ? `Comprobante ${data.documentNumber}` : ''),
                        items: resolvedOrderItems.map(({ productId, quantity }) => ({ productId, quantity }))
                    },
                    safeActor
                );
                approvedOrderNumber = order.saleNumber;
            }

            const now = new Date().toISOString();
            markApprovedStmt.run(
                data.documentType,
                JSON.stringify({
                    ...existing.reviewPayload,
                    partyId: resolvedPartyId,
                    createParty: false
                }),
                data.documentType,
                order.id,
                approvedOrderNumber,
                safeActor.id,
                safeActor.username,
                now,
                now,
                id
            );

            return {
                intake: getIntakeById(id),
                order,
                createdParty,
                createdProducts
            };
        });
    }

    function approveBatch(ids, actor = SYSTEM_ACTOR) {
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new DomainError('Seleccioná al menos un comprobante para aprobar.', {
                status: 400,
                field: 'ids',
                code: 'VALIDATION_ERROR'
            });
        }

        const approved = [];
        const failed = [];

        for (const id of ids) {
            try {
                const result = approveIntake(id, actor);
                approved.push(result);
            } catch (error) {
                const existing = getIntakeById(id);
                failed.push({
                    id,
                    fileName: existing?.fileName ?? id,
                    error: error instanceof Error ? error.message : 'No se pudo aprobar el comprobante.',
                    code: error?.code ?? 'APPROVAL_FAILED'
                });
            }
        }

        return { approved, failed };
    }

    return {
        listIntakes,
        getIntakeById,
        getStats: (intakes = listIntakes()) => calculateIntakeQueueStats(intakes),
        enqueueBatch,
        processBatch,
        updateIntakeReview,
        rejectIntake,
        rejectAllErrors,
        approveIntake,
        approveBatch
    };
}

