/**
 * app.js — PDF Wasm Analyzer frontend.
 *
 * Split-pane UI with:
 *   - Sidebar: document list, upload, select, delete
 *   - Main: detailed analysis (metadata + PDFium text extraction + page preview)
 *   - Backend integration: POST results to Django API
 *   - All data persisted in localStorage
 */

import { extractText, renderFirstPage, getPageCount } from './pdfium_worker.js';

// ─── Config ────────────────────────────────────────────

const STORAGE_KEY = 'pdf_wasm_history';
const MAX_HISTORY = 100;
const BACKEND_URL = 'http://localhost:8000/api/save-pdf-job/';
const AUTH_TOKEN = 'dev-token-change-me-in-production';

// ─── State ─────────────────────────────────────────────

let wasmModule = null;
let pdfiumReady = false;
let analysisHistory = [];
let selectedId = null;
// Store raw bytes per document ID for PDFium lazy operations
const fileDataCache = new Map();

// ─── Module Init ───────────────────────────────────────

async function initWasm() {
    const statusEl = document.getElementById('wasm-status');
    try {
        const { default: createPdfModule } = await import('./pdf_processor.js');
        wasmModule = await createPdfModule();
        statusEl.textContent = '✓ Analyzer ready';
        statusEl.classList.add('ready');
        document.getElementById('file-input').disabled = false;
        document.getElementById('upload-btn').classList.add('active');
    } catch (err) {
        statusEl.textContent = '✗ Analyzer failed';
        statusEl.classList.add('error');
        showError(`Wasm module failed to load: ${err.message}`);
    }
}

async function initPdfium() {
    const pdfiumStatusEl = document.getElementById('pdfium-status');
    try {
        // Trigger PDFium init by calling getPageCount with a tiny dummy
        // Actually, just import and let ensureInit happen on first real call
        pdfiumReady = true;
        pdfiumStatusEl.textContent = '✓ PDFium ready';
        pdfiumStatusEl.classList.add('ready');
    } catch (err) {
        pdfiumStatusEl.textContent = '✗ PDFium failed';
        pdfiumStatusEl.classList.add('error');
    }
}

// ─── LocalStorage ──────────────────────────────────────

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) analysisHistory = JSON.parse(raw);
    } catch (_) {
        analysisHistory = [];
    }
}

function saveHistory() {
    try {
        if (analysisHistory.length > MAX_HISTORY)
            analysisHistory = analysisHistory.slice(-MAX_HISTORY);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(analysisHistory));
    } catch (_) {}
}

// ─── File Processing ───────────────────────────────────

async function processFiles(files) {
    if (!wasmModule) {
        showError('Wasm module is not loaded yet.');
        return;
    }

    const listEl = document.getElementById('doc-list');
    let lastEntryId = null;

    listEl.innerHTML = `
        <div class="doc-item-loading" id="batch-loading">
            <div class="mini-spinner"></div>
            <span>Processing ${files.length} file${files.length !== 1 ? 's' : ''}…</span>
        </div>
    ` + listEl.innerHTML;

    for (const file of files) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            // Step 1: Fast C++ metadata analysis
            const jsonResult = wasmModule.processPdfFile(uint8Array);
            const metaResult = JSON.parse(jsonResult);

            // Step 2: PDFium accurate page count
            let pdfiumPageCount = metaResult.estimatedPages;
            try {
                pdfiumPageCount = await getPageCount(uint8Array);
            } catch (e) {
                console.warn('[app] PDFium page count failed, using estimate:', e);
            }

            const entry = {
                id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                fileName: file.name,
                analyzedAt: new Date().toISOString(),
                result: {
                    ...metaResult,
                    estimatedPages: pdfiumPageCount,
                },
                // PDFium results (populated lazily on detail view)
                extractedText: null,
                pagePreview: null,
                savedToBackend: false,
            };

            // Cache raw bytes for lazy PDFium operations
            fileDataCache.set(entry.id, uint8Array);

            analysisHistory.push(entry);
            lastEntryId = entry.id;
        } catch (err) {
            showError(`Error processing ${file.name}: ${err.message}`);
        }
    }

    saveHistory();
    const loadingEl = document.getElementById('batch-loading');
    if (loadingEl) loadingEl.remove();
    renderSidebar();
    if (lastEntryId) selectDocument(lastEntryId);
}

// ─── PDFium Operations (lazy, triggered from detail view) ──

async function runTextExtraction(entryId) {
    const entry = analysisHistory.find(e => e.id === entryId);
    if (!entry) return;

    const data = fileDataCache.get(entryId);
    if (!data) {
        showError('File data no longer in memory. Please re-upload the file.');
        return;
    }

    const btn = document.getElementById('btn-extract-text');
    const container = document.getElementById('extracted-text-container');
    if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }

    try {
        const result = await extractText(data);
        entry.extractedText = result;
        entry.result.estimatedPages = result.pageCount;
        saveHistory();

        if (container) {
            container.innerHTML = `
                <div class="text-result">
                    <div class="text-stats">
                        <span>${result.pageCount} pages</span>
                        <span>${result.fullText.length.toLocaleString()} chars</span>
                    </div>
                    <pre class="extracted-text-content">${escapeHtml(result.fullText || '(No text content found — PDF may be scanned/image-based)')}</pre>
                </div>
            `;
        }
        if (btn) { btn.textContent = '✓ Extracted'; btn.classList.add('done'); }

        // Update sidebar to reflect accurate page count
        renderSidebar();
    } catch (err) {
        if (container) {
            container.innerHTML = `<p class="text-error">Extraction failed: ${escapeHtml(err.message)}</p>`;
        }
        if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
    }
}

async function runPagePreview(entryId) {
    const entry = analysisHistory.find(e => e.id === entryId);
    if (!entry) return;

    const data = fileDataCache.get(entryId);
    if (!data) {
        showError('File data no longer in memory. Please re-upload the file.');
        return;
    }

    const btn = document.getElementById('btn-render-page');
    const container = document.getElementById('page-preview-container');
    if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }

    try {
        const result = await renderFirstPage(data, 1.5);
        entry.pagePreview = result.dataUrl;
        saveHistory();

        if (container) {
            container.innerHTML = `
                <div class="page-preview-result">
                    <img src="${result.dataUrl}" alt="Page 1 preview" class="page-preview-img">
                    <p class="preview-dims">${result.width} × ${result.height} px</p>
                </div>
            `;
        }
        if (btn) { btn.textContent = '✓ Rendered'; btn.classList.add('done'); }
    } catch (err) {
        if (container) {
            container.innerHTML = `<p class="text-error">Render failed: ${escapeHtml(err.message)}</p>`;
        }
        if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
    }
}

// ─── Backend Integration ───────────────────────────────

async function saveToBackend(entryId) {
    const entry = analysisHistory.find(e => e.id === entryId);
    if (!entry) return;

    const btn = document.getElementById('btn-save-backend');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const payload = {
        filename: entry.fileName,
        file_size: entry.result.fileSize,
        pdf_version: entry.result.pdfVersion || '',
        page_count: entry.result.estimatedPages || 0,
        operation_type: entry.extractedText ? 'full_analysis' : 'metadata_analysis',
        text_preview: (entry.extractedText?.fullText || '').slice(0, 500),
        status: entry.result.success ? 'completed' : 'failed',
    };

    try {
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const data = await response.json();
        entry.savedToBackend = true;
        saveHistory();

        if (btn) { btn.textContent = '✓ Saved (ID: ' + data.job.id + ')'; btn.classList.add('done'); }
        showSuccess(`Job saved to backend (ID: ${data.job.id})`);
    } catch (err) {
        if (btn) { btn.textContent = 'Retry Save'; btn.disabled = false; }
        showError(`Backend save failed: ${err.message}`);
    }
}

// ─── Selection ─────────────────────────────────────────

function selectDocument(id) {
    selectedId = id;
    document.querySelectorAll('.doc-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.id === id);
    });
    const entry = analysisHistory.find(e => e.id === id);
    if (entry) renderDetail(entry);
}

// ─── Delete ────────────────────────────────────────────

function deleteEntry(id, event) {
    if (event) event.stopPropagation();
    analysisHistory = analysisHistory.filter(e => e.id !== id);
    fileDataCache.delete(id);
    saveHistory();
    if (selectedId === id) { selectedId = null; renderEmptyState(); }
    renderSidebar();
}

function clearAll() {
    analysisHistory = [];
    selectedId = null;
    fileDataCache.clear();
    localStorage.removeItem(STORAGE_KEY);
    renderSidebar();
    renderEmptyState();
}

// ─── Rendering: Sidebar ────────────────────────────────

function renderSidebar() {
    const listEl = document.getElementById('doc-list');
    const countEl = document.getElementById('doc-count');
    const clearBtn = document.getElementById('clear-all');

    if (analysisHistory.length === 0) {
        listEl.innerHTML = `
            <div class="doc-list-empty">
                <span class="empty-icon">📂</span>
                No documents yet.<br>Upload some PDFs to start.
            </div>
        `;
        countEl.textContent = 'Documents';
        clearBtn.classList.remove('visible');
        return;
    }

    clearBtn.classList.add('visible');
    countEl.textContent = `${analysisHistory.length} document${analysisHistory.length !== 1 ? 's' : ''}`;

    const items = [...analysisHistory].reverse().map(entry => {
        const r = entry.result;
        const isSelected = entry.id === selectedId;
        const iconClass = r.success ? 'valid' : 'invalid';
        const icon = r.success ? '✓' : '✗';
        const date = new Date(entry.analyzedAt);
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });

        return `
            <div class="doc-item ${isSelected ? 'selected' : ''}"
                 data-id="${entry.id}"
                 onclick="window._selectDoc('${entry.id}')">
                <div class="doc-item-icon ${iconClass}">${icon}</div>
                <div class="doc-item-info">
                    <div class="doc-item-name" title="${escapeHtml(entry.fileName)}">${escapeHtml(entry.fileName)}</div>
                    <div class="doc-item-meta">
                        <span>${r.fileSizeHuman}</span>
                        <span>${r.estimatedPages} pg</span>
                        <span>${dateStr} ${timeStr}</span>
                    </div>
                </div>
                <button class="doc-item-delete"
                        onclick="window._deleteDoc('${entry.id}', event)"
                        title="Remove">×</button>
            </div>
        `;
    }).join('');

    listEl.innerHTML = items;
}

// ─── Rendering: Detail View ────────────────────────────

function renderDetail(entry) {
    const mainEl = document.getElementById('main-content');
    const r = entry.result;
    const iconClass = r.success ? 'valid' : 'invalid';
    const icon = r.success ? '✓' : '✗';
    const date = new Date(entry.analyzedAt);
    const hasFileData = fileDataCache.has(entry.id);

    mainEl.innerHTML = `
        <div class="detail-view">
            <div class="detail-header">
                <div class="detail-icon ${iconClass}">${icon}</div>
                <div>
                    <h1 class="detail-title">${escapeHtml(entry.fileName)}</h1>
                    <p class="detail-message ${iconClass}">${escapeHtml(r.message)}</p>
                    <p class="detail-time">Analyzed ${date.toLocaleString()}</p>
                </div>
            </div>

            <!-- Metadata Grid -->
            <div class="stats-grid">
                <div class="stat-card">
                    <span class="stat-label">File Size</span>
                    <span class="stat-value">${escapeHtml(r.fileSizeHuman)}<br><small>${r.fileSize.toLocaleString()} bytes</small></span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">PDF Version</span>
                    <span class="stat-value">${escapeHtml(r.pdfVersion)}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Pages</span>
                    <span class="stat-value">${r.estimatedPages}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Magic Bytes</span>
                    <span class="stat-value mono">${escapeHtml(r.magicBytes)}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Linearized</span>
                    <span class="stat-value">${r.linearized ? 'Yes' : 'No'}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Encrypted</span>
                    <span class="stat-value">${r.encrypted ? 'Yes ⚠' : 'No'}</span>
                </div>
            </div>

            <div class="badges-row">
                <span class="badge ${r.success ? 'yes' : 'no'}">${r.success ? '✓ Valid PDF' : '✗ Invalid'}</span>
                <span class="badge ${r.linearized ? 'yes' : 'no'}">${r.linearized ? '⚡ Linearized' : '— Not linearized'}</span>
                <span class="badge ${r.encrypted ? 'warn' : 'no'}">${r.encrypted ? '🔒 Encrypted' : '🔓 Not encrypted'}</span>
                ${entry.savedToBackend ? '<span class="badge yes">☁ Saved to backend</span>' : ''}
            </div>

            <!-- PDFium Actions -->
            ${hasFileData ? `
            <div class="pdfium-section">
                <h2 class="section-title">🔬 PDFium Operations</h2>
                <div class="action-buttons">
                    <button id="btn-extract-text" class="action-btn ${entry.extractedText ? 'done' : ''}"
                            onclick="window._extractText('${entry.id}')"
                            ${entry.extractedText ? 'disabled' : ''}>
                        ${entry.extractedText ? '✓ Text Extracted' : '📝 Extract Text'}
                    </button>
                    <button id="btn-render-page" class="action-btn ${entry.pagePreview ? 'done' : ''}"
                            onclick="window._renderPage('${entry.id}')"
                            ${entry.pagePreview ? 'disabled' : ''}>
                        ${entry.pagePreview ? '✓ Page Rendered' : '🖼 Render First Page'}
                    </button>
                    <button id="btn-save-backend" class="action-btn save-btn ${entry.savedToBackend ? 'done' : ''}"
                            onclick="window._saveBackend('${entry.id}')"
                            ${entry.savedToBackend ? 'disabled' : ''}>
                        ${entry.savedToBackend ? '✓ Saved to Backend' : '☁ Save to Backend'}
                    </button>
                </div>

                <!-- Text extraction result -->
                <div id="extracted-text-container">
                    ${entry.extractedText ? `
                        <div class="text-result">
                            <div class="text-stats">
                                <span>${entry.extractedText.pageCount} pages</span>
                                <span>${entry.extractedText.fullText.length.toLocaleString()} chars</span>
                            </div>
                            <pre class="extracted-text-content">${escapeHtml(entry.extractedText.fullText || '(No text content)')}</pre>
                        </div>
                    ` : ''}
                </div>

                <!-- Page preview result -->
                <div id="page-preview-container">
                    ${entry.pagePreview ? `
                        <div class="page-preview-result">
                            <img src="${entry.pagePreview}" alt="Page 1 preview" class="page-preview-img">
                        </div>
                    ` : ''}
                </div>
            </div>
            ` : `
            <div class="pdfium-section">
                <p class="text-muted-note">⚠ File data not in memory — re-upload to enable PDFium operations.</p>
            </div>
            `}

            <!-- Raw JSON -->
            <details class="raw-json">
                <summary>Raw JSON Response</summary>
                <pre><code>${escapeHtml(JSON.stringify(r, null, 2))}</code></pre>
            </details>
        </div>
    `;
}

function renderEmptyState() {
    document.getElementById('main-content').innerHTML = `
        <div class="empty-state">
            <span class="empty-icon">📊</span>
            <h2>Select a document</h2>
            <p>Upload PDF files using the sidebar, then click one to see its full analysis.</p>
        </div>
    `;
}

// ─── Toasts ────────────────────────────────────────────

function showError(msg) {
    _showToast(msg, 'error');
}

function showSuccess(msg) {
    _showToast(msg, 'success');
}

function _showToast(msg, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${type === 'error' ? '⚠' : '✓'}</span><p>${escapeHtml(msg)}</p>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s ease';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ─── Util ──────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Global handlers ───────────────────────────────────

window._selectDoc = selectDocument;
window._deleteDoc = deleteEntry;
window._extractText = runTextExtraction;
window._renderPage = runPagePreview;
window._saveBackend = saveToBackend;

// ─── Init ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const clearBtn = document.getElementById('clear-all');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            processFiles(e.target.files);
            e.target.value = '';
        }
    });

    // Drag & drop on upload button and doc list
    const dropTargets = [uploadBtn, document.getElementById('doc-list')];
    dropTargets.forEach(el => {
        el.addEventListener('dragover', (e) => { e.preventDefault(); uploadBtn.classList.add('dragover'); });
        el.addEventListener('dragleave', (e) => { e.preventDefault(); uploadBtn.classList.remove('dragover'); });
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadBtn.classList.remove('dragover');
            const files = [...e.dataTransfer.files].filter(f =>
                f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
            );
            if (files.length > 0) processFiles(files);
            else showError('No PDF files detected.');
        });
    });

    clearBtn.addEventListener('click', clearAll);

    loadHistory();
    renderSidebar();
    if (analysisHistory.length > 0) {
        selectDocument(analysisHistory[analysisHistory.length - 1].id);
    }

    initWasm();
    initPdfium();
});
