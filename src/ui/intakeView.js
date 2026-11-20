import {
    calculateIntakeQueueStats,
    INTAKE_DOC_TYPES,
    INTAKE_STATUS
} from '../domain/intake.js';
import { formatCurrencyFromCents, formatInteger, parsePriceToCents } from '../domain/money.js';

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short'
});

const STATUS_BADGES = {
    [INTAKE_STATUS.PENDING]: { label: 'En cola', className: 'badge badge-adjust' },
    [INTAKE_STATUS.PROCESSING]: { label: 'Analizando IA...', className: 'badge badge-adjust' },
    [INTAKE_STATUS.READY_FOR_REVIEW]: { label: 'Lista p/ revisar', className: 'badge badge-low' },
    [INTAKE_STATUS.APPROVED]: { label: 'Aprobada', className: 'badge badge-ok' },
    [INTAKE_STATUS.REJECTED]: { label: 'Rechazada', className: 'badge badge-out' },
    [INTAKE_STATUS.ERROR]: { label: 'Error', className: 'badge badge-out' }
};

const DOC_TYPE_LABELS = {
    [INTAKE_DOC_TYPES.PURCHASE]: 'Compra',
    [INTAKE_DOC_TYPES.SALE]: 'Venta'
};

function createTextCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) {
        cell.className = className;
    }
    cell.textContent = text;
    return cell;
}

function formatDateTime(isoString) {
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) {
        return isoString ?? '';
    }
    return DATE_TIME_FORMATTER.format(parsed);
}

/**
 * Pure XSS-safe DOM view layer for the Gemini Batch Document Intake & Human-in-the-Loop Review UI.
 * @param {Document} [doc=document]
 */
export function createIntakeView(doc = document) {
    let cachedCatalog = { products: [], suppliers: [], customers: [] };
    let permissions = { canWrite: false, canApprove: false };
    let activeIntakeId = null;

    const elements = {
        aiStatusPill: doc.getElementById('ai-status-pill'),
        refreshAiModelsBtn: doc.getElementById('refresh-ai-models-btn'),
        aiModelsBar: doc.getElementById('ai-models-bar'),
        intakeUploadCard: doc.getElementById('intake-upload-card'),
        intakeErrorMsg: doc.getElementById('intake-error-msg'),
        intakeStatusMsg: doc.getElementById('intake-status-msg'),
        intakeUploadForm: doc.getElementById('intake-upload-form'),
        intakeDocType: doc.getElementById('intake-doc-type'),
        intakeDropzone: doc.getElementById('intake-dropzone'),
        intakeFileInput: doc.getElementById('intake-file-input'),
        intakeFilesSummary: doc.getElementById('intake-files-summary'),
        intakePasteText: doc.getElementById('intake-paste-text'),
        intakeUploadBtn: doc.getElementById('intake-upload-btn'),

        statProcessing: doc.getElementById('intake-stat-processing'),
        statReady: doc.getElementById('intake-stat-ready'),
        statApproved: doc.getElementById('intake-stat-approved'),
        statError: doc.getElementById('intake-stat-error'),
        statDuplicates: doc.getElementById('intake-stat-duplicates'),
        intakeStatusFilter: doc.getElementById('intake-status-filter'),
        rejectErrorsBtn: doc.getElementById('reject-errors-btn'),
        approveAllReadyBtn: doc.getElementById('approve-all-ready-btn'),
        intakeTableBody: doc.getElementById('intake-table-body'),

        reviewCard: doc.getElementById('intake-review-card'),
        reviewTitle: doc.getElementById('intake-review-title'),
        reviewConfidence: doc.getElementById('intake-review-confidence'),
        reviewWarnings: doc.getElementById('intake-review-warnings'),
        reviewErrorMsg: doc.getElementById('intake-review-error-msg'),
        reviewForm: doc.getElementById('intake-review-form'),
        reviewDocType: doc.getElementById('review-doc-type'),
        reviewDocNumber: doc.getElementById('review-doc-number'),
        reviewIssueDate: doc.getElementById('review-issue-date'),
        reviewNotes: doc.getElementById('review-notes'),
        reviewReceiveWrap: doc.getElementById('review-receive-wrap'),
        reviewReceiveNow: doc.getElementById('review-receive-now'),
        reviewPartyLabel: doc.getElementById('review-party-label'),
        reviewPartySelect: doc.getElementById('review-party-select'),
        reviewNewPartyFields: doc.getElementById('review-new-party-fields'),
        reviewPartyName: doc.getElementById('review-party-name'),
        reviewPartyTaxId: doc.getElementById('review-party-tax-id'),
        reviewPartyEmail: doc.getElementById('review-party-email'),
        reviewPartyPhone: doc.getElementById('review-party-phone'),
        reviewItemsList: doc.getElementById('review-items-list'),
        reviewAddItemBtn: doc.getElementById('review-add-item-btn'),
        reviewLiveTotal: doc.getElementById('review-live-total'),
        reviewSaveBtn: doc.getElementById('review-save-btn'),
        reviewApproveBtn: doc.getElementById('review-approve-btn'),
        reviewRejectBtn: doc.getElementById('review-reject-btn'),
        reviewCloseBtn: doc.getElementById('review-close-btn')
    };

    function computePayloadTotalCents(payload) {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const docType = payload?.documentType === INTAKE_DOC_TYPES.SALE
            ? INTAKE_DOC_TYPES.SALE
            : INTAKE_DOC_TYPES.PURCHASE;

        return items.reduce((sum, item) => {
            const qty = Number(item.quantity);
            if (!Number.isInteger(qty) || qty <= 0) return sum;
            const unitCents =
                docType === INTAKE_DOC_TYPES.PURCHASE
                    ? (parsePriceToCents(item.unitCost) ?? 0)
                    : (parsePriceToCents(item.salePrice) ?? 0);
            return sum + unitCents * qty;
        }, 0);
    }

    function populatePartySelect(docType, selectedPartyId, createParty) {
        const isPurchase = docType === INTAKE_DOC_TYPES.PURCHASE;
        const parties = isPurchase ? cachedCatalog.suppliers : cachedCatalog.customers;
        elements.reviewPartyLabel.textContent = isPurchase ? 'Proveedor:' : 'Cliente:';
        elements.reviewReceiveWrap.hidden = !isPurchase;

        const fragment = doc.createDocumentFragment();
        if (!isPurchase) {
            const finalConsumer = doc.createElement('option');
            finalConsumer.value = '';
            finalConsumer.textContent = 'Consumidor Final (sin cliente)';
            fragment.appendChild(finalConsumer);
        } else {
            const selectPrompt = doc.createElement('option');
            selectPrompt.value = '';
            selectPrompt.textContent = 'Seleccioná un proveedor...';
            fragment.appendChild(selectPrompt);
        }

        for (const party of parties) {
            const option = doc.createElement('option');
            option.value = party.id;
            option.textContent = party.taxId ? `${party.name} (${party.taxId})` : party.name;
            fragment.appendChild(option);
        }

        const newOpt = doc.createElement('option');
        newOpt.value = '__NEW__';
        newOpt.textContent = isPurchase ? '+ Crear nuevo proveedor' : '+ Crear nuevo cliente';
        fragment.appendChild(newOpt);

        elements.reviewPartySelect.replaceChildren(fragment);

        if (selectedPartyId && parties.some((p) => p.id === selectedPartyId)) {
            elements.reviewPartySelect.value = selectedPartyId;
            elements.reviewNewPartyFields.hidden = true;
        } else if (createParty) {
            elements.reviewPartySelect.value = '__NEW__';
            elements.reviewNewPartyFields.hidden = false;
        } else {
            elements.reviewPartySelect.value = '';
            elements.reviewNewPartyFields.hidden = true;
        }
    }

    function populateReviewProductSelect(selectEl, docType, selectedId, createProduct) {
        const sorted = [...cachedCatalog.products].sort((a, b) =>
            a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
        );
        const fragment = doc.createDocumentFragment();

        const placeholder = doc.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Seleccioná producto del catálogo...';
        fragment.appendChild(placeholder);

        for (const product of sorted) {
            const option = doc.createElement('option');
            option.value = product.id;
            option.textContent = `${product.sku} — ${product.name} (Stock: ${formatInteger(product.stock)})`;
            fragment.appendChild(option);
        }

        if (docType === INTAKE_DOC_TYPES.PURCHASE) {
            const newOpt = doc.createElement('option');
            newOpt.value = '__NEW__';
            newOpt.textContent = '+ Crear producto nuevo en catálogo';
            fragment.appendChild(newOpt);
        }

        selectEl.replaceChildren(fragment);

        if (selectedId && sorted.some((p) => p.id === selectedId)) {
            selectEl.value = selectedId;
        } else if (createProduct && docType === INTAKE_DOC_TYPES.PURCHASE) {
            selectEl.value = '__NEW__';
        } else {
            selectEl.value = '';
        }
    }

    function updateReviewLineCardUI(lineCard) {
        const docType = elements.reviewDocType.value;
        const isPurchase = docType === INTAKE_DOC_TYPES.PURCHASE;
        const select = lineCard.querySelector('.review-line-product');
        const qtyInput = lineCard.querySelector('.review-line-qty');
        const costInput = lineCard.querySelector('.review-line-cost');
        const salePriceDisplay = lineCard.querySelector('.review-line-sale-display');
        const newProductFields = lineCard.querySelector('.intake-new-product-fields');
        const subtotalEl = lineCard.querySelector('.line-subtotal');

        const isNew = isPurchase && select.value === '__NEW__';
        newProductFields.hidden = !isNew;
        costInput.hidden = !isPurchase;
        salePriceDisplay.hidden = isPurchase;

        const qty = Number(qtyInput.value);
        let unitCents = 0;

        if (isPurchase) {
            unitCents = parsePriceToCents(costInput.value) ?? 0;
        } else {
            const prod = cachedCatalog.products.find((p) => p.id === select.value);
            unitCents = prod ? prod.priceCents : 0;
            salePriceDisplay.textContent = prod ? formatCurrencyFromCents(unitCents) : '—';
        }

        const subtotalCents = Number.isInteger(qty) && qty > 0 ? qty * unitCents : 0;
        subtotalEl.textContent = formatCurrencyFromCents(subtotalCents);
        subtotalEl.dataset.subtotalCents = String(subtotalCents);
    }

    function updateReviewTotal() {
        let totalCents = 0;
        for (const card of elements.reviewItemsList.querySelectorAll('.intake-line-card')) {
            updateReviewLineCardUI(card);
            totalCents += Number(card.querySelector('.line-subtotal')?.dataset.subtotalCents ?? 0);
        }
        elements.reviewLiveTotal.textContent = formatCurrencyFromCents(totalCents);
    }

    function appendReviewLineCard(item = {}) {
        const docType = elements.reviewDocType.value;
        const card = doc.createElement('div');
        card.className = 'intake-line-card';
        card.dataset.rawDescription = item.rawDescription ?? '';

        const mainRow = doc.createElement('div');
        mainRow.className = 'intake-line-main';

        const productSelect = doc.createElement('select');
        productSelect.className = 'review-line-product';
        productSelect.setAttribute('aria-label', 'Producto de línea');
        populateReviewProductSelect(
            productSelect,
            docType,
            item.productId ?? '',
            Boolean(item.createProduct)
        );

        const qtyInput = doc.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'review-line-qty';
        qtyInput.min = '1';
        qtyInput.step = '1';
        qtyInput.value = String(item.quantity ?? 1);
        qtyInput.setAttribute('aria-label', 'Cantidad');

        const costInput = doc.createElement('input');
        costInput.type = 'number';
        costInput.className = 'review-line-cost';
        costInput.min = '0';
        costInput.step = '0.01';
        costInput.placeholder = 'Costo unit.';
        costInput.value = item.unitCost ?? '0.00';
        costInput.setAttribute('aria-label', 'Costo unitario');

        const saleDisplay = doc.createElement('span');
        saleDisplay.className = 'review-line-sale-display line-unit-price';

        const subtotalSpan = doc.createElement('span');
        subtotalSpan.className = 'line-subtotal';

        const removeBtn = doc.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'action-btn action-delete';
        removeBtn.dataset.action = 'remove-review-line';
        removeBtn.textContent = 'Quitar';

        mainRow.append(productSelect, qtyInput, costInput, saleDisplay, subtotalSpan, removeBtn);
        card.appendChild(mainRow);

        const newFields = doc.createElement('div');
        newFields.className = 'intake-new-product-fields';

        const skuInput = doc.createElement('input');
        skuInput.type = 'text';
        skuInput.className = 'review-new-sku';
        skuInput.placeholder = 'SKU nuevo (ej. TEC-002)';
        skuInput.maxLength = 32;
        skuInput.value = item.sku ?? '';

        const nameInput = doc.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'review-new-name';
        nameInput.placeholder = 'Nombre del producto';
        nameInput.maxLength = 120;
        nameInput.value = item.name ?? '';

        const catInput = doc.createElement('input');
        catInput.type = 'text';
        catInput.className = 'review-new-category';
        catInput.placeholder = 'Categoría (General)';
        catInput.maxLength = 60;
        catInput.value = item.category ?? 'General';

        const salePriceInput = doc.createElement('input');
        salePriceInput.type = 'number';
        salePriceInput.className = 'review-new-sale-price';
        salePriceInput.min = '0';
        salePriceInput.step = '0.01';
        salePriceInput.placeholder = 'Precio venta';
        salePriceInput.value = item.salePrice ?? item.unitCost ?? '0.00';

        newFields.append(skuInput, nameInput, catInput, salePriceInput);
        card.appendChild(newFields);

        if (item.rawDescription) {
            const rawHint = doc.createElement('p');
            rawHint.className = 'intake-raw-hint';
            rawHint.textContent = `Texto extraído: "${item.rawDescription}"`;
            card.appendChild(rawHint);
        }

        elements.reviewItemsList.appendChild(card);
        updateReviewTotal();
    }

    return {
        elements,

        getActiveIntakeId() {
            return activeIntakeId;
        },

        applyPermissions(nextPerms) {
            permissions = { ...nextPerms };
            if (elements.intakeUploadCard) {
                elements.intakeUploadCard.hidden = !permissions.canWrite;
            }
            if (elements.rejectErrorsBtn) {
                elements.rejectErrorsBtn.hidden = !permissions.canWrite;
            }
            if (elements.approveAllReadyBtn) {
                elements.approveAllReadyBtn.hidden = !permissions.canApprove;
            }
        },

        renderAiStatus(aiStatus) {
            if (!elements.aiStatusPill) return;
            const configured = Boolean(aiStatus?.configured);

            if (elements.refreshAiModelsBtn) {
                elements.refreshAiModelsBtn.hidden = !configured;
                elements.refreshAiModelsBtn.disabled = !configured;
            }

            if (!configured) {
                elements.aiStatusPill.className = 'summary-pill summary-pill-out';
                elements.aiStatusPill.textContent = 'Gemini no configurado (definí GEMINI_API_KEY en .env)';
                if (elements.aiModelsBar) {
                    elements.aiModelsBar.hidden = true;
                    elements.aiModelsBar.replaceChildren();
                }
                return;
            }

            const models = Array.isArray(aiStatus.models) ? aiStatus.models : [];
            const totalModels = Number.isInteger(aiStatus.totalModels) ? aiStatus.totalModels : models.length;
            const availableCount = Number.isInteger(aiStatus.availableCount)
                ? aiStatus.availableCount
                : models.filter((m) => m.available).length;

            if (totalModels > 0 && availableCount === 0) {
                elements.aiStatusPill.className = 'summary-pill summary-pill-out';
                elements.aiStatusPill.textContent = `Sin modelos Gemini disponibles (0/${totalModels})`;
            } else {
                elements.aiStatusPill.className = 'summary-pill summary-pill-in';
                const autoSuffix =
                    aiStatus.autoRotate && totalModels > 1
                        ? ` (auto · ${availableCount}/${totalModels} disp.)`
                        : '';
                elements.aiStatusPill.textContent = `Gemini activo · ${aiStatus.model}${autoSuffix}`;
            }

            if (!elements.aiModelsBar) return;
            if (models.length === 0) {
                elements.aiModelsBar.hidden = true;
                elements.aiModelsBar.replaceChildren();
                return;
            }

            const fragment = doc.createDocumentFragment();
            const maxVisible = 10;
            const visibleModels = models.slice(0, maxVisible);

            for (const entry of visibleModels) {
                const chip = doc.createElement('span');
                const isActive = entry.model === aiStatus.model && entry.available;
                let statusClass = 'model-chip-ok';
                let suffix = isActive ? ' ★' : '';

                if (entry.status === 'COOLDOWN') {
                    statusClass = 'model-chip-warn';
                    suffix = ' (pausa)';
                } else if (entry.status === 'QUOTA_EXCEEDED') {
                    statusClass = 'model-chip-out';
                    suffix = ' (cuota)';
                } else if (entry.status === 'UNAVAILABLE') {
                    statusClass = 'model-chip-out';
                    suffix = ' (no disp.)';
                }

                chip.className = `model-chip ${statusClass}${isActive ? ' model-chip-active' : ''}`;
                chip.textContent = `${entry.model}${suffix}`;

                const tipParts = [`Modelo: ${entry.model}`, `Estado: ${entry.status}`];
                if (entry.cooldownUntil) {
                    tipParts.push(`Reintento desde: ${formatDateTime(entry.cooldownUntil)}`);
                }
                if (entry.lastError) {
                    tipParts.push(`Detalle: ${entry.lastError}`);
                }
                chip.title = tipParts.join(' | ');
                fragment.appendChild(chip);
            }

            if (models.length > maxVisible) {
                const moreChip = doc.createElement('span');
                moreChip.className = 'model-chip';
                moreChip.textContent = `+${models.length - maxVisible} más`;
                moreChip.title = models
                    .slice(maxVisible)
                    .map((m) => `${m.model} (${m.status})`)
                    .join(', ');
                fragment.appendChild(moreChip);
            }

            elements.aiModelsBar.replaceChildren(fragment);
            elements.aiModelsBar.hidden = false;
        },

        setRefreshingModelsState(isRefreshing) {
            if (!elements.refreshAiModelsBtn) return;
            elements.refreshAiModelsBtn.disabled = isRefreshing;
            elements.refreshAiModelsBtn.textContent = isRefreshing
                ? 'Detectando...'
                : 'Detectar modelos';
        },

        setCatalog(catalog) {
            cachedCatalog = catalog;
        },

        renderSelectedFiles(fileList) {
            const files = Array.from(fileList ?? []);
            if (files.length === 0) {
                elements.intakeFilesSummary.textContent =
                    'Podés arrastrar o seleccionar múltiples archivos (PDF, JPG, PNG, WebP o TXT · máx. 25 por lote).';
                return;
            }
            const names = files.slice(0, 4).map((f) => f.name).join(', ');
            const suffix = files.length > 4 ? ` y ${files.length - 4} más` : '';
            elements.intakeFilesSummary.textContent = `${files.length} archivo(s) listo(s): ${names}${suffix}`;
        },

        setUploadingState(isUploading) {
            elements.intakeUploadBtn.disabled = isUploading;
            elements.intakeUploadBtn.textContent = isUploading
                ? 'Enviando lote...'
                : 'Analizar comprobantes con Gemini';
        },

        renderQueue(allIntakes, filterStatus = 'all') {
            const stats = calculateIntakeQueueStats(allIntakes);
            elements.statProcessing.textContent = `En proceso: ${formatInteger(stats.processing)}`;
            elements.statReady.textContent = `Listas p/ revisar: ${formatInteger(stats.readyForReview)}`;
            elements.statApproved.textContent = `Aprobadas: ${formatInteger(stats.approved)}`;
            elements.statError.textContent = `Con error: ${formatInteger(stats.error)}`;
            elements.statDuplicates.textContent = `Duplicadas: ${formatInteger(stats.duplicates)}`;

            if (elements.rejectErrorsBtn) {
                elements.rejectErrorsBtn.disabled = stats.error === 0;
                elements.rejectErrorsBtn.textContent =
                    stats.error > 0
                        ? `Descartar con error (${formatInteger(stats.error)})`
                        : 'Descartar con error';
            }

            if (elements.approveAllReadyBtn) {
                elements.approveAllReadyBtn.disabled = stats.readyForReview === 0;
            }

            const visible =
                filterStatus === 'all'
                    ? allIntakes
                    : allIntakes.filter((item) => item.status === filterStatus);

            const fragment = doc.createDocumentFragment();

            if (visible.length === 0) {
                const row = doc.createElement('tr');
                const cell = doc.createElement('td');
                cell.colSpan = 8;
                cell.className = 'empty-state';
                cell.textContent =
                    allIntakes.length === 0
                        ? 'Todavía no cargaste comprobantes en la bandeja de ingesta.'
                        : 'No hay comprobantes en ese estado.';
                row.appendChild(cell);
                fragment.appendChild(row);
            } else {
                for (const intake of visible) {
                    const row = doc.createElement('tr');
                    if (intake.id === activeIntakeId) {
                        row.classList.add('is-editing');
                    }

                    const fileCell = doc.createElement('td');
                    const fileTitle = doc.createElement('div');
                    fileTitle.className = 'cell-name';
                    fileTitle.textContent = intake.fileName;
                    fileCell.appendChild(fileTitle);

                    const metaLine = doc.createElement('div');
                    metaLine.className = 'intake-meta-line';
                    metaLine.textContent = `${formatDateTime(intake.createdAt)} · ${intake.createdByUsername}${intake.aiModel ? ` · ${intake.aiModel}` : ''}`;
                    fileCell.appendChild(metaLine);

                    if (intake.duplicateOfId) {
                        const dupTag = doc.createElement('span');
                        dupTag.className = 'badge badge-low';
                        dupTag.textContent = 'Posible duplicado';
                        fileCell.appendChild(dupTag);
                    }

                    const typeCell = createTextCell(
                        DOC_TYPE_LABELS[intake.documentType] ?? intake.documentType
                    );

                    const refNumber = intake.reviewPayload?.documentNumber || intake.approvedOrderNumber || '—';
                    const refCell = createTextCell(refNumber, 'cell-numeric');

                    const partyName = intake.reviewPayload?.partyDraft?.name || '—';
                    const partyCell = createTextCell(partyName);

                    const itemsCount = Array.isArray(intake.reviewPayload?.items)
                        ? intake.reviewPayload.items.length
                        : 0;
                    const itemsCell = createTextCell(
                        itemsCount > 0 ? `${formatInteger(itemsCount)} ítem(s)` : '—',
                        'cell-numeric'
                    );

                    const totalCents = computePayloadTotalCents(intake.reviewPayload);
                    const totalCell = createTextCell(
                        itemsCount > 0 ? formatCurrencyFromCents(totalCents) : '—',
                        'cell-numeric cell-subtotal'
                    );

                    const statusCell = doc.createElement('td');
                    const badgeInfo = STATUS_BADGES[intake.status] ?? {
                        label: intake.status,
                        className: 'badge'
                    };
                    const statusBadge = doc.createElement('span');
                    statusBadge.className = badgeInfo.className;
                    statusBadge.textContent = badgeInfo.label;
                    statusCell.appendChild(statusBadge);

                    if (intake.status === INTAKE_STATUS.ERROR && intake.errorMessage) {
                        const errNote = doc.createElement('div');
                        errNote.className = 'intake-error-note';
                        errNote.textContent = intake.errorMessage;
                        statusCell.appendChild(errNote);
                    } else if (intake.approvedOrderNumber) {
                        const orderNote = doc.createElement('div');
                        orderNote.className = 'intake-meta-line';
                        orderNote.textContent = `Generado: ${intake.approvedOrderNumber}`;
                        statusCell.appendChild(orderNote);
                    } else if (Array.isArray(intake.warnings) && intake.warnings.length > 0) {
                        const warnNote = doc.createElement('div');
                        warnNote.className = 'intake-warn-note';
                        warnNote.textContent = `${intake.warnings.length} advertencia(s)`;
                        statusCell.appendChild(warnNote);
                    }

                    const actionsCell = doc.createElement('td');
                    const actionsGroup = doc.createElement('div');
                    actionsGroup.className = 'row-actions';

                    const canReview =
                        intake.status === INTAKE_STATUS.READY_FOR_REVIEW ||
                        intake.status === INTAKE_STATUS.ERROR;

                    if (canReview && permissions.canWrite) {
                        const reviewBtn = doc.createElement('button');
                        reviewBtn.type = 'button';
                        reviewBtn.className = 'action-btn action-edit';
                        reviewBtn.dataset.action = 'review-intake';
                        reviewBtn.dataset.id = intake.id;
                        reviewBtn.textContent = 'Revisar';
                        actionsGroup.appendChild(reviewBtn);
                    }

                    if (intake.status === INTAKE_STATUS.READY_FOR_REVIEW && permissions.canApprove) {
                        const approveBtn = doc.createElement('button');
                        approveBtn.type = 'button';
                        approveBtn.className = 'action-btn action-edit';
                        approveBtn.dataset.action = 'approve-intake';
                        approveBtn.dataset.id = intake.id;
                        approveBtn.textContent = 'Aprobar';
                        actionsGroup.appendChild(approveBtn);
                    }

                    if (
                        (intake.status === INTAKE_STATUS.READY_FOR_REVIEW ||
                            intake.status === INTAKE_STATUS.ERROR ||
                            intake.status === INTAKE_STATUS.PENDING) &&
                        permissions.canWrite
                    ) {
                        const rejectBtn = doc.createElement('button');
                        rejectBtn.type = 'button';
                        rejectBtn.className = 'action-btn action-delete';
                        rejectBtn.dataset.action = 'reject-intake';
                        rejectBtn.dataset.id = intake.id;
                        rejectBtn.textContent = 'Rechazar';
                        actionsGroup.appendChild(rejectBtn);
                    }

                    if (actionsGroup.childElementCount === 0) {
                        const dash = doc.createElement('span');
                        dash.className = 'cell-muted';
                        dash.textContent = '—';
                        actionsCell.appendChild(dash);
                    } else {
                        actionsCell.appendChild(actionsGroup);
                    }

                    row.append(
                        fileCell,
                        typeCell,
                        refCell,
                        partyCell,
                        itemsCell,
                        totalCell,
                        statusCell,
                        actionsCell
                    );
                    fragment.appendChild(row);
                }
            }

            elements.intakeTableBody.replaceChildren(fragment);
        },

        openReviewPanel(intake) {
            activeIntakeId = intake.id;
            elements.reviewCard.hidden = false;
            elements.reviewErrorMsg.textContent = '';
            elements.reviewTitle.textContent = `Revisión previa · ${intake.fileName}`;

            const confidencePct = Math.round((Number(intake.confidence) || 0) * 100);
            elements.reviewConfidence.textContent =
                intake.status === INTAKE_STATUS.ERROR
                    ? 'Carga manual (falló extracción)'
                    : `Confianza IA: ${confidencePct}%`;

            const warnFragment = doc.createDocumentFragment();
            const warnings = Array.isArray(intake.warnings) ? [...intake.warnings] : [];
            if (intake.errorMessage) {
                warnings.unshift(`Error de extracción: ${intake.errorMessage}`);
            }
            for (const warnText of warnings) {
                const li = doc.createElement('li');
                li.textContent = warnText;
                warnFragment.appendChild(li);
            }
            elements.reviewWarnings.replaceChildren(warnFragment);
            elements.reviewWarnings.hidden = warnings.length === 0;

            const payload = intake.reviewPayload ?? {};
            const docType =
                payload.documentType === INTAKE_DOC_TYPES.SALE
                    ? INTAKE_DOC_TYPES.SALE
                    : intake.documentType || INTAKE_DOC_TYPES.PURCHASE;

            elements.reviewDocType.value = docType;
            elements.reviewDocNumber.value = payload.documentNumber ?? '';
            elements.reviewIssueDate.value = payload.issueDate ?? '';
            elements.reviewNotes.value = payload.notes ?? '';
            elements.reviewReceiveNow.checked = payload.receiveNow !== false;

            const partyDraft = payload.partyDraft ?? {};
            elements.reviewPartyName.value = partyDraft.name ?? '';
            elements.reviewPartyTaxId.value = partyDraft.taxId ?? '';
            elements.reviewPartyEmail.value = partyDraft.email ?? '';
            elements.reviewPartyPhone.value = partyDraft.phone ?? '';
            populatePartySelect(docType, payload.partyId ?? '', Boolean(payload.createParty));

            elements.reviewItemsList.replaceChildren();
            const items = Array.isArray(payload.items) && payload.items.length > 0
                ? payload.items
                : [{ productId: '', createProduct: docType === INTAKE_DOC_TYPES.PURCHASE, quantity: 1, unitCost: '0.00', salePrice: '0.00' }];

            for (const item of items) {
                appendReviewLineCard(item);
            }

            elements.reviewApproveBtn.hidden = !permissions.canApprove;
            updateReviewTotal();
            elements.reviewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },

        closeReviewPanel() {
            activeIntakeId = null;
            elements.reviewCard.hidden = true;
            elements.reviewErrorMsg.textContent = '';
            elements.reviewItemsList.replaceChildren();
        },

        handleReviewDocTypeChange() {
            const docType = elements.reviewDocType.value;
            populatePartySelect(docType, '', docType === INTAKE_DOC_TYPES.PURCHASE);
            for (const card of elements.reviewItemsList.querySelectorAll('.intake-line-card')) {
                const select = card.querySelector('.review-line-product');
                const current = select.value === '__NEW__' ? '' : select.value;
                populateReviewProductSelect(
                    select,
                    docType,
                    current,
                    docType === INTAKE_DOC_TYPES.PURCHASE && !current
                );
            }
            updateReviewTotal();
        },

        handleReviewPartySelectChange() {
            elements.reviewNewPartyFields.hidden = elements.reviewPartySelect.value !== '__NEW__';
        },

        addReviewLine() {
            appendReviewLineCard({
                productId: '',
                createProduct: elements.reviewDocType.value === INTAKE_DOC_TYPES.PURCHASE,
                quantity: 1,
                unitCost: '0.00',
                salePrice: '0.00'
            });
        },

        refreshReviewTotals() {
            updateReviewTotal();
        },

        readReviewForm() {
            const docType = elements.reviewDocType.value;
            const partyVal = elements.reviewPartySelect.value;
            const isNewParty = partyVal === '__NEW__';

            const items = Array.from(elements.reviewItemsList.querySelectorAll('.intake-line-card')).map(
                (card) => {
                    const productVal = card.querySelector('.review-line-product')?.value ?? '';
                    const isNewProd = docType === INTAKE_DOC_TYPES.PURCHASE && productVal === '__NEW__';
                    return {
                        productId: isNewProd ? '' : productVal,
                        createProduct: isNewProd,
                        sku: card.querySelector('.review-new-sku')?.value ?? '',
                        name: card.querySelector('.review-new-name')?.value ?? '',
                        category: card.querySelector('.review-new-category')?.value ?? 'General',
                        quantity: card.querySelector('.review-line-qty')?.value ?? '1',
                        unitCost: card.querySelector('.review-line-cost')?.value ?? '0.00',
                        salePrice: card.querySelector('.review-new-sale-price')?.value ?? '0.00',
                        minStock: 5,
                        rawDescription: card.dataset.rawDescription ?? ''
                    };
                }
            );

            return {
                documentType: docType,
                documentNumber: elements.reviewDocNumber.value,
                issueDate: elements.reviewIssueDate.value,
                receiveNow: elements.reviewReceiveNow.checked,
                notes: elements.reviewNotes.value,
                partyId: isNewParty ? '' : partyVal,
                createParty: isNewParty,
                partyDraft: {
                    name: elements.reviewPartyName.value,
                    taxId: elements.reviewPartyTaxId.value,
                    email: elements.reviewPartyEmail.value,
                    phone: elements.reviewPartyPhone.value
                },
                items
            };
        },

        showUploadError(message) {
            elements.intakeErrorMsg.textContent = message;
        },
        showUploadStatus(message) {
            elements.intakeStatusMsg.textContent = message;
        },
        clearUploadFeedback() {
            elements.intakeErrorMsg.textContent = '';
            elements.intakeStatusMsg.textContent = '';
        },
        showReviewError(message) {
            elements.reviewErrorMsg.textContent = message;
        },
        clearReviewError() {
            elements.reviewErrorMsg.textContent = '';
        }
    };
}

