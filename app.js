/**
 * app.js — PDF Wasm Analyzer frontend.
 *
 * Split-pane UI:
 *   - Sidebar: document list with upload, select, delete
 *   - Main: detailed analysis of selected document
 *   - All data persisted in localStorage
 */

// ─── State ─────────────────────────────────────────────

const STORAGE_KEY = 'pdf_wasm_history';
const MAX_HISTORY = 100;

let wasmModule = null;
let analysisHistory = [];  // Array of { id, fileName, analyzedAt, result }
let selectedId = null;     // Currently viewed document ID

// ─── Module Init ───────────────────────────────────────

async function initWasm() {
    const statusEl = document.getElementById('wasm-status');
    try {
        const { default: createPdfModule } = await import('./pdf_processor.js');
        wasmModule = await createPdfModule();
        statusEl.textContent = '✓ Ready';
        statusEl.classList.add('ready');
        document.getElementById('file-input').disabled = false;
        document.getElementById('upload-btn').classList.add('active');
    } catch (err) {
        statusEl.textContent = '✗ Failed';
        statusEl.classList.add('error');
        showError(`Wasm module failed to load: ${err.message}`);
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
        if (analysisHistory.length > MAX_HISTORY) {
            analysisHistory = analysisHistory.slice(-MAX_HISTORY);
        }
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

    // Show a single loading state in sidebar
    listEl.innerHTML = `
        <div class="doc-item-loading" id="batch-loading">
            <div class="mini-spinner"></div>
            <span>Processing ${files.length} file${files.length !== 1 ? 's' : ''}…</span>
        </div>
    ` + listEl.innerHTML;

    // Process all files sequentially
    for (const file of files) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            const jsonResult = wasmModule.processPdfFile(uint8Array);
            const result = JSON.parse(jsonResult);

            const entry = {
                id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                fileName: file.name,
                analyzedAt: new Date().toISOString(),
                result: result
            };

            analysisHistory.push(entry);
            lastEntryId = entry.id;
        } catch (err) {
            showError(`Error processing ${file.name}: ${err.message}`);
        }
    }

    // Save once after all files
    saveHistory();

    // Remove loading indicator
    const loadingEl = document.getElementById('batch-loading');
    if (loadingEl) loadingEl.remove();

    // Re-render sidebar and auto-select the last processed entry
    renderSidebar();
    if (lastEntryId) {
        selectDocument(lastEntryId);
    }
}

// ─── Selection ─────────────────────────────────────────

function selectDocument(id) {
    selectedId = id;

    // Update sidebar selection
    document.querySelectorAll('.doc-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.id === id);
    });

    // Render detail view
    const entry = analysisHistory.find(e => e.id === id);
    if (entry) {
        renderDetail(entry);
    }
}

// ─── Delete ────────────────────────────────────────────

function deleteEntry(id, event) {
    if (event) event.stopPropagation();

    analysisHistory = analysisHistory.filter(e => e.id !== id);
    saveHistory();

    if (selectedId === id) {
        selectedId = null;
        renderEmptyState();
    }

    renderSidebar();
}

function clearAll() {
    analysisHistory = [];
    selectedId = null;
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

    // Newest first
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
                    <span class="stat-label">Estimated Pages</span>
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
                <span class="badge ${r.success ? 'yes' : 'no'}">
                    ${r.success ? '✓ Valid PDF' : '✗ Invalid'}
                </span>
                <span class="badge ${r.linearized ? 'yes' : 'no'}">
                    ${r.linearized ? '⚡ Linearized' : '— Not linearized'}
                </span>
                <span class="badge ${r.encrypted ? 'warn' : 'no'}">
                    ${r.encrypted ? '🔒 Encrypted' : '🔓 Not encrypted'}
                </span>
            </div>

            <details class="raw-json">
                <summary>Raw JSON Response</summary>
                <pre><code>${escapeHtml(JSON.stringify(r, null, 2))}</code></pre>
            </details>
        </div>
    `;
}

function renderEmptyState() {
    const mainEl = document.getElementById('main-content');
    mainEl.innerHTML = `
        <div class="empty-state" id="empty-state">
            <span class="empty-icon">📊</span>
            <h2>Select a document</h2>
            <p>Upload PDF files using the sidebar, then click one to see its full analysis.</p>
        </div>
    `;
}

// ─── Error Toast ───────────────────────────────────────

function showError(msg) {
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.innerHTML = `<span>⚠</span><p>${escapeHtml(msg)}</p>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s ease';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ─── Util ──────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Global handlers (for inline onclick) ──────────────

window._selectDoc = selectDocument;
window._deleteDoc = deleteEntry;

// ─── Init ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const clearBtn  = document.getElementById('clear-all');

    // Upload button click
    uploadBtn.addEventListener('click', () => fileInput.click());

    // File input
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            processFiles(e.target.files);
            e.target.value = '';
        }
    });

    // Drag & drop on upload button
    uploadBtn.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadBtn.classList.add('dragover');
    });
    uploadBtn.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadBtn.classList.remove('dragover');
    });
    uploadBtn.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadBtn.classList.remove('dragover');
        const files = [...e.dataTransfer.files].filter(f =>
            f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
        );
        if (files.length > 0) processFiles(files);
        else showError('No PDF files detected.');
    });

    // Also support drag & drop on the entire sidebar doc-list area
    const docList = document.getElementById('doc-list');
    docList.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadBtn.classList.add('dragover');
    });
    docList.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadBtn.classList.remove('dragover');
    });
    docList.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadBtn.classList.remove('dragover');
        const files = [...e.dataTransfer.files].filter(f =>
            f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
        );
        if (files.length > 0) processFiles(files);
    });

    // Clear all
    clearBtn.addEventListener('click', clearAll);

    // Load history & render
    loadHistory();
    renderSidebar();

    // Auto-select the most recent document if any
    if (analysisHistory.length > 0) {
        selectDocument(analysisHistory[analysisHistory.length - 1].id);
    }

    // Init Wasm
    initWasm();
});
