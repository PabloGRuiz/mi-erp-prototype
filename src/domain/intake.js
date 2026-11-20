import { centsToInputValue, parsePriceToCents } from './money.js';
import { validatePartyInput } from './operations.js';
import { normalizeSku, parseNonNegativeInteger } from './product.js';

export const INTAKE_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    READY_FOR_REVIEW: 'READY_FOR_REVIEW',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    ERROR: 'ERROR'
});

export const INTAKE_DOC_TYPES = Object.freeze({
    PURCHASE: 'PURCHASE',
    SALE: 'SALE'
});

export const ALLOWED_INTAKE_MIME_TYPES = Object.freeze([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain'
]);

export const MAX_INTAKE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_INTAKE_BATCH_FILES = 25;

const SKU_PATTERN = /^[A-Z0-9_-]{2,32}$/;
const MAX_DOC_NUMBER_LENGTH = 60;
const MAX_NOTES_LENGTH = 300;
const MAX_ITEMS = 100;

function normalizeTaxId(raw) {
    return typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
}

function normalizeName(raw) {
    return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function matchParty(rawParty, parties) {
    const targetTaxId = normalizeTaxId(rawParty?.taxId);
    if (targetTaxId) {
        const byTax = parties.find((party) => normalizeTaxId(party.taxId) === targetTaxId);
        if (byTax) return byTax;
    }

    const targetName = normalizeName(rawParty?.name);
    if (!targetName) {
        return null;
    }

    const exact = parties.find((party) => normalizeName(party.name) === targetName);
    if (exact) return exact;

    if (targetName.length >= 4) {
        return (
            parties.find((party) => {
                const candidate = normalizeName(party.name);
                return candidate.includes(targetName) || targetName.includes(candidate);
            }) ?? null
        );
    }

    return null;
}

function matchProduct(rawLine, products, productsBySku) {
    const skuCandidate = normalizeSku(rawLine?.sku);
    if (skuCandidate && productsBySku.has(skuCandidate)) {
        return productsBySku.get(skuCandidate);
    }

    const nameCandidate = normalizeName(rawLine?.name);
    if (!nameCandidate) {
        return null;
    }

    const exact = products.find((product) => normalizeName(product.name) === nameCandidate);
    if (exact) return exact;

    if (nameCandidate.length >= 4) {
        return (
            products.find((product) => {
                const candidate = normalizeName(product.name);
                return candidate.includes(nameCandidate) || nameCandidate.includes(candidate);
            }) ?? null
        );
    }

    return null;
}

function toSafeCents(rawNumber) {
    const parsed = Number(rawNumber);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }
    return parsePriceToCents(parsed.toFixed(2)) ?? 0;
}

/**
 * Reconciles AI-extracted invoice JSON deterministically against live ERP catalog data.
 * Never mutates the database; produces an editable review payload and human warnings.
 * @param {Record<string, any>} rawExtraction
 * @param {{ products: any[], suppliers: any[], customers: any[] }} catalog
 * @param {'PURCHASE' | 'SALE'} [defaultDocType='PURCHASE']
 */
export function reconcileExtractedDocument(
    rawExtraction,
    { products = [], suppliers = [], customers = [] },
    defaultDocType = INTAKE_DOC_TYPES.PURCHASE
) {
    const warnings = [];
    const extractedType = rawExtraction?.documentType;
    const documentType =
        extractedType === INTAKE_DOC_TYPES.PURCHASE || extractedType === INTAKE_DOC_TYPES.SALE
            ? extractedType
            : defaultDocType;

    const documentNumber =
        typeof rawExtraction?.documentNumber === 'string'
            ? rawExtraction.documentNumber.trim().slice(0, MAX_DOC_NUMBER_LENGTH)
            : '';
    const issueDate =
        typeof rawExtraction?.issueDate === 'string' ? rawExtraction.issueDate.trim().slice(0, 30) : '';
    const notes =
        typeof rawExtraction?.notes === 'string' ? rawExtraction.notes.trim().slice(0, MAX_NOTES_LENGTH) : '';

    const rawParty = rawExtraction?.party ?? {};
    const partyList = documentType === INTAKE_DOC_TYPES.PURCHASE ? suppliers : customers;
    const matchedParty = matchParty(rawParty, partyList);

    const partyDraft = {
        name: String(matchedParty?.name ?? rawParty?.name ?? '').trim().slice(0, 120),
        taxId: String(matchedParty?.taxId ?? rawParty?.taxId ?? '').trim().toUpperCase().slice(0, 30),
        email: String(matchedParty?.email ?? rawParty?.email ?? '').trim().slice(0, 120),
        phone: String(matchedParty?.phone ?? rawParty?.phone ?? '').trim().slice(0, 40)
    };

    const partyId = matchedParty ? matchedParty.id : '';
    const createParty = !matchedParty && Boolean(partyDraft.name);

    if (!matchedParty) {
        if (documentType === INTAKE_DOC_TYPES.PURCHASE) {
            warnings.push(
                partyDraft.name
                    ? `Proveedor "${partyDraft.name}" no existe en el catálogo: se creará al aprobar salvo que elijas otro.`
                    : 'No se detectó proveedor en el comprobante. Seleccionalo o completalo antes de aprobar.'
            );
        } else if (partyDraft.name) {
            warnings.push(
                `Cliente "${partyDraft.name}" no existe en el catálogo: podés crearlo al aprobar o operar como Consumidor Final.`
            );
        }
    }

    const productsBySku = new Map(products.map((p) => [normalizeSku(p.sku), p]));
    const rawItems = Array.isArray(rawExtraction?.items) ? rawExtraction.items : [];

    const items = rawItems.slice(0, MAX_ITEMS).map((rawLine) => {
        const matchedProduct = matchProduct(rawLine, products, productsBySku);
        const parsedIntQty = parseNonNegativeInteger(rawLine?.quantity);
        const rawQtyNum = Number(rawLine?.quantity);
        const quantity =
            parsedIntQty !== null && parsedIntQty >= 1
                ? parsedIntQty
                : (Number.isFinite(rawQtyNum) && rawQtyNum >= 1 ? Math.round(rawQtyNum) : 1);

        const extractedUnitCents = toSafeCents(rawLine?.unitPrice);
        const rawDescription =
            typeof rawLine?.name === 'string' ? rawLine.name.trim().slice(0, 120) : '';

        if (matchedProduct) {
            return {
                productId: matchedProduct.id,
                createProduct: false,
                sku: matchedProduct.sku,
                name: matchedProduct.name,
                category: matchedProduct.category,
                quantity,
                unitCost: centsToInputValue(extractedUnitCents),
                salePrice: centsToInputValue(matchedProduct.priceCents),
                minStock: matchedProduct.minStock,
                rawDescription
            };
        }

        const rawSku = normalizeSku(rawLine?.sku);
        const validSku = SKU_PATTERN.test(rawSku) ? rawSku : '';
        const category =
            typeof rawLine?.category === 'string' && rawLine.category.trim()
                ? rawLine.category.trim().slice(0, 60)
                : 'General';

        warnings.push(
            documentType === INTAKE_DOC_TYPES.PURCHASE
                ? `Ítem "${rawDescription || 'sin descripción'}" no coincide con un producto existente: revisá el SKU o seleccionalo del catálogo.`
                : `Ítem "${rawDescription || 'sin descripción'}" no coincide con un producto del catálogo (requiere selección manual para vender).`
        );

        return {
            productId: '',
            createProduct: documentType === INTAKE_DOC_TYPES.PURCHASE,
            sku: validSku,
            name: rawDescription,
            category,
            quantity,
            unitCost: centsToInputValue(extractedUnitCents),
            salePrice: centsToInputValue(extractedUnitCents),
            minStock: 5,
            rawDescription
        };
    });

    if (items.length === 0) {
        warnings.push('La IA no detectó líneas de productos en el documento. Agregá al menos un ítem.');
    }

    const linesSumCents = items.reduce((sum, item) => {
        const unitCents =
            documentType === INTAKE_DOC_TYPES.PURCHASE
                ? (parsePriceToCents(item.unitCost) ?? 0)
                : (parsePriceToCents(item.salePrice) ?? 0);
        return sum + unitCents * item.quantity;
    }, 0);

    const hasDeclaredTotal =
        rawExtraction?.declaredTotal !== null &&
        rawExtraction?.declaredTotal !== undefined &&
        Number.isFinite(Number(rawExtraction.declaredTotal)) &&
        Number(rawExtraction.declaredTotal) >= 0;

    const declaredTotalCents = hasDeclaredTotal
        ? toSafeCents(rawExtraction.declaredTotal)
        : linesSumCents;
    const taxAmountCents = toSafeCents(rawExtraction?.taxAmount);

    if (hasDeclaredTotal && items.length > 0) {
        const diffNet = Math.abs(declaredTotalCents - linesSumCents);
        const diffWithTax = Math.abs(declaredTotalCents - (linesSumCents + taxAmountCents));

        if (taxAmountCents > 0 && diffWithTax <= 100) {
            // Reconciled cleanly with discriminated tax (e.g. Factura A).
        } else if (diffNet > 100) {
            const estimatedWithIva21 = Math.round(linesSumCents * 1.21);
            if (taxAmountCents === 0 && Math.abs(declaredTotalCents - estimatedWithIva21) <= 100) {
                warnings.push(
                    `El total declarado ($ ${centsToInputValue(declaredTotalCents)}) coincide con la suma neta de ítems ($ ${centsToInputValue(linesSumCents)}) + IVA 21%.`
                );
            } else {
                warnings.push(
                    `El total declarado del comprobante ($ ${centsToInputValue(declaredTotalCents)}) difiere de la suma de ítems ($ ${centsToInputValue(linesSumCents)}).`
                );
            }
        }
    }

    const rawConfidence = Number(rawExtraction?.confidence);
    const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0.5;

    if (confidence < 0.7) {
        warnings.push('Confianza de extracción baja: revisá montos, cantidades y contraparte antes de aprobar.');
    }

    if (Array.isArray(rawExtraction?.warnings)) {
        for (const extraWarning of rawExtraction.warnings) {
            if (typeof extraWarning === 'string' && extraWarning.trim()) {
                warnings.push(extraWarning.trim().slice(0, 200));
            }
        }
    }

    const reviewPayload = {
        documentType,
        documentNumber,
        issueDate,
        receiveNow: true,
        notes: notes || (documentNumber ? `Comprobante ${documentNumber}` : ''),
        partyId,
        createParty,
        partyDraft,
        taxAmountCents,
        declaredTotalCents,
        items
    };

    return {
        documentType,
        confidence,
        reviewPayload,
        warnings: [...new Set(warnings)]
    };
}

/**
 * Strictly validates an edited intake payload before saving review state or approving into SQLite.
 * @param {Record<string, any>} payload
 * @param {{ products: any[], suppliers: any[], customers: any[] }} catalog
 */
export function validateIntakeReviewPayload(
    payload,
    { products = [], suppliers = [], customers = [] }
) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Datos de revisión inválidos.', field: 'documentType', code: 'VALIDATION_ERROR' };
    }

    const documentType = payload.documentType;
    if (documentType !== INTAKE_DOC_TYPES.PURCHASE && documentType !== INTAKE_DOC_TYPES.SALE) {
        return {
            ok: false,
            error: 'El tipo de comprobante debe ser Compra o Venta.',
            field: 'documentType',
            code: 'VALIDATION_ERROR'
        };
    }

    const documentNumber = typeof payload.documentNumber === 'string' ? payload.documentNumber.trim() : '';
    if (documentNumber.length > MAX_DOC_NUMBER_LENGTH) {
        return {
            ok: false,
            error: `El número de comprobante no puede superar los ${MAX_DOC_NUMBER_LENGTH} caracteres.`,
            field: 'documentNumber',
            code: 'VALIDATION_ERROR'
        };
    }

    const issueDate = typeof payload.issueDate === 'string' ? payload.issueDate.trim().slice(0, 30) : '';
    const receiveNow = payload.receiveNow === undefined ? true : Boolean(payload.receiveNow);
    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) {
        return {
            ok: false,
            error: `Las observaciones no pueden superar los ${MAX_NOTES_LENGTH} caracteres.`,
            field: 'notes',
            code: 'VALIDATION_ERROR'
        };
    }

    const partyId = typeof payload.partyId === 'string' ? payload.partyId.trim() : '';
    const createParty = Boolean(payload.createParty) && !partyId;
    const partyList = documentType === INTAKE_DOC_TYPES.PURCHASE ? suppliers : customers;
    const partyLabel = documentType === INTAKE_DOC_TYPES.PURCHASE ? 'Proveedor' : 'Cliente';
    let partyDraft = {
        name: typeof payload.partyDraft?.name === 'string' ? payload.partyDraft.name.trim() : '',
        taxId: typeof payload.partyDraft?.taxId === 'string' ? payload.partyDraft.taxId.trim().toUpperCase() : '',
        email: typeof payload.partyDraft?.email === 'string' ? payload.partyDraft.email.trim() : '',
        phone: typeof payload.partyDraft?.phone === 'string' ? payload.partyDraft.phone.trim() : ''
    };

    if (partyId) {
        const foundParty = partyList.find((p) => p.id === partyId);
        if (!foundParty) {
            return {
                ok: false,
                error: `El ${partyLabel.toLowerCase()} seleccionado no existe en el catálogo.`,
                field: 'partyId',
                code: 'PARTY_NOT_FOUND'
            };
        }
        partyDraft = {
            name: foundParty.name,
            taxId: foundParty.taxId,
            email: foundParty.email,
            phone: foundParty.phone
        };
    } else if (createParty) {
        const partyValidation = validatePartyInput(partyDraft, partyLabel);
        if (!partyValidation.ok) {
            return {
                ok: false,
                error: partyValidation.error,
                field: partyValidation.field,
                code: 'VALIDATION_ERROR'
            };
        }
        partyDraft = {
            name: partyValidation.data.name,
            taxId: partyValidation.data.taxId,
            email: partyValidation.data.email,
            phone: partyValidation.data.phone
        };
    } else if (documentType === INTAKE_DOC_TYPES.PURCHASE) {
        return {
            ok: false,
            error: 'Seleccioná un proveedor existente o creá uno nuevo para aprobar la compra.',
            field: 'partyId',
            code: 'VALIDATION_ERROR'
        };
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return {
            ok: false,
            error: 'El comprobante debe incluir al menos un ítem válido.',
            field: 'items',
            code: 'VALIDATION_ERROR'
        };
    }

    if (payload.items.length > MAX_ITEMS) {
        return {
            ok: false,
            error: `El comprobante no puede superar los ${MAX_ITEMS} ítems.`,
            field: 'items',
            code: 'VALIDATION_ERROR'
        };
    }

    const productsById = new Map(products.map((p) => [p.id, p]));
    const existingSkus = new Set(products.map((p) => normalizeSku(p.sku)));
    const newSkusInBatch = new Set();
    const requestedSaleStock = new Map();
    const normalizedItems = [];
    let totalCents = 0;

    for (let i = 0; i < payload.items.length; i += 1) {
        const line = payload.items[i];
        const lineNum = i + 1;
        const productId = typeof line?.productId === 'string' ? line.productId.trim() : '';
        const createProduct = Boolean(line?.createProduct) && !productId;

        const quantity = parseNonNegativeInteger(line?.quantity);
        if (quantity === null || quantity < 1) {
            return {
                ok: false,
                error: `La cantidad de la línea ${lineNum} debe ser un entero mayor o igual a 1.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        if (productId) {
            const product = productsById.get(productId);
            if (!product) {
                return {
                    ok: false,
                    error: `El producto seleccionado en la línea ${lineNum} no existe.`,
                    field: 'items',
                    code: 'PRODUCT_NOT_FOUND'
                };
            }

            if (documentType === INTAKE_DOC_TYPES.PURCHASE) {
                const unitCostCents = parsePriceToCents(line?.unitCost);
                if (unitCostCents === null) {
                    return {
                        ok: false,
                        error: `El costo unitario de "${product.name}" en la línea ${lineNum} es inválido.`,
                        field: 'items',
                        code: 'VALIDATION_ERROR'
                    };
                }
                const subtotalCents = unitCostCents * quantity;
                if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents + subtotalCents)) {
                    return {
                        ok: false,
                        error: 'El total calculado supera el límite numérico seguro.',
                        field: 'items',
                        code: 'VALIDATION_ERROR'
                    };
                }
                totalCents += subtotalCents;

                normalizedItems.push({
                    productId: product.id,
                    createProduct: false,
                    sku: product.sku,
                    name: product.name,
                    category: product.category,
                    quantity,
                    unitCost: centsToInputValue(unitCostCents),
                    unitCostCents,
                    salePrice: centsToInputValue(product.priceCents),
                    salePriceCents: product.priceCents,
                    minStock: product.minStock,
                    subtotalCents,
                    rawDescription: typeof line?.rawDescription === 'string' ? line.rawDescription : ''
                });
            } else {
                const accumulated = (requestedSaleStock.get(product.id) ?? 0) + quantity;
                if (accumulated > product.stock) {
                    return {
                        ok: false,
                        error: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}, solicitado: ${accumulated}.`,
                        field: 'items',
                        code: 'INSUFFICIENT_STOCK'
                    };
                }
                requestedSaleStock.set(product.id, accumulated);

                const subtotalCents = product.priceCents * quantity;
                if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents + subtotalCents)) {
                    return {
                        ok: false,
                        error: 'El total calculado supera el límite numérico seguro.',
                        field: 'items',
                        code: 'VALIDATION_ERROR'
                    };
                }
                totalCents += subtotalCents;

                normalizedItems.push({
                    productId: product.id,
                    createProduct: false,
                    sku: product.sku,
                    name: product.name,
                    category: product.category,
                    quantity,
                    unitCost: centsToInputValue(product.priceCents),
                    unitCostCents: product.priceCents,
                    salePrice: centsToInputValue(product.priceCents),
                    salePriceCents: product.priceCents,
                    minStock: product.minStock,
                    subtotalCents,
                    rawDescription: typeof line?.rawDescription === 'string' ? line.rawDescription : ''
                });
            }
            continue;
        }

        if (documentType === INTAKE_DOC_TYPES.SALE) {
            return {
                ok: false,
                error: `En la línea ${lineNum} de una venta debés seleccionar un producto existente del catálogo.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        if (!createProduct) {
            return {
                ok: false,
                error: `Seleccioná un producto existente o marcá la línea ${lineNum} como producto nuevo.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        const sku = normalizeSku(line?.sku);
        if (!SKU_PATTERN.test(sku)) {
            return {
                ok: false,
                error: `El SKU de la línea ${lineNum} debe tener entre 2 y 32 caracteres (A-Z, 0-9, "-" o "_").`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        if (existingSkus.has(sku) || newSkusInBatch.has(sku)) {
            return {
                ok: false,
                error: `El SKU "${sku}" de la línea ${lineNum} ya existe o está duplicado en el comprobante.`,
                field: 'items',
                code: 'DUPLICATE_SKU'
            };
        }
        newSkusInBatch.add(sku);

        const name = typeof line?.name === 'string' ? line.name.trim() : '';
        if (!name || name.length > 120) {
            return {
                ok: false,
                error: `El nombre del nuevo producto en la línea ${lineNum} es obligatorio (máx. 120 caracteres).`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        const category =
            typeof line?.category === 'string' && line.category.trim()
                ? line.category.trim().slice(0, 60)
                : 'General';

        const unitCostCents = parsePriceToCents(line?.unitCost);
        if (unitCostCents === null) {
            return {
                ok: false,
                error: `El costo unitario de la línea ${lineNum} es inválido.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        const rawSalePrice =
            line?.salePrice !== undefined && String(line.salePrice).trim() !== ''
                ? line.salePrice
                : line?.unitCost;
        const salePriceCents = parsePriceToCents(rawSalePrice);
        if (salePriceCents === null) {
            return {
                ok: false,
                error: `El precio de venta del nuevo producto en la línea ${lineNum} es inválido.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        const minStock =
            line?.minStock === undefined || line?.minStock === ''
                ? 5
                : parseNonNegativeInteger(line.minStock);
        if (minStock === null) {
            return {
                ok: false,
                error: `El stock mínimo de la línea ${lineNum} debe ser un entero >= 0.`,
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }

        const subtotalCents = unitCostCents * quantity;
        if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents + subtotalCents)) {
            return {
                ok: false,
                error: 'El total calculado supera el límite numérico seguro.',
                field: 'items',
                code: 'VALIDATION_ERROR'
            };
        }
        totalCents += subtotalCents;

        normalizedItems.push({
            productId: '',
            createProduct: true,
            sku,
            name,
            category,
            quantity,
            unitCost: centsToInputValue(unitCostCents),
            unitCostCents,
            salePrice: centsToInputValue(salePriceCents),
            salePriceCents,
            minStock,
            subtotalCents,
            rawDescription: typeof line?.rawDescription === 'string' ? line.rawDescription : ''
        });
    }

    const declaredTotalCents = Number.isSafeInteger(payload.declaredTotalCents)
        ? payload.declaredTotalCents
        : totalCents;

    return {
        ok: true,
        data: {
            documentType,
            documentNumber,
            issueDate,
            receiveNow,
            notes,
            partyId,
            createParty,
            partyDraft,
            declaredTotalCents,
            totalCents,
            items: normalizedItems
        }
    };
}

/**
 * Computes summary counts for the intake queue panel.
 * @param {Array<{ status: string, duplicateOfId?: string | null }>} intakes
 */
export function calculateIntakeQueueStats(intakes) {
    return intakes.reduce(
        (stats, item) => {
            stats.total += 1;
            if (item.status === INTAKE_STATUS.PENDING || item.status === INTAKE_STATUS.PROCESSING) {
                stats.processing += 1;
            } else if (item.status === INTAKE_STATUS.READY_FOR_REVIEW) {
                stats.readyForReview += 1;
            } else if (item.status === INTAKE_STATUS.APPROVED) {
                stats.approved += 1;
            } else if (item.status === INTAKE_STATUS.REJECTED) {
                stats.rejected += 1;
            } else if (item.status === INTAKE_STATUS.ERROR) {
                stats.error += 1;
            }
            if (item.duplicateOfId) {
                stats.duplicates += 1;
            }
            return stats;
        },
        {
            total: 0,
            processing: 0,
            readyForReview: 0,
            approved: 0,
            rejected: 0,
            error: 0,
            duplicates: 0
        }
    );
}

