/**
 * app.js — Frontend logic for the PDF Wasm Analyzer.
 *
 * Features:
 *   - Multi-file upload support (sequential processing)
 *   - Analysis history persisted in localStorage
 *   - Drag-and-drop + file input
 *   - Proper binary data transfer to Wasm (Uint8Array, no UTF-8 corruption)
 */

// ─── State ─────────────────────────────────────────────

const STORAGE_KEY = 'pdf_wasm_history';
const MAX_HISTORY = 50;

let wasmModule = null;
let analysisHistory = [];

// ─── Module Initialization ─────────────────────────────

async function initWasm() {
    const statusEl = document.getElementById('wasm-status');
    try {
        const { default: createPdfModule } = await import('./pdf_processor.js');
        wasmModule = await createPdfModule();
        statusEl.textContent = '✓ Wasm module loaded';
        statusEl.classList.add('ready');
        document.getElementById('file-input').disabled = false;
        document.getElementById('drop-zone').classList.add('active');
        console.log('[pdf_wasm] Module initialized successfully.');
    } catch (err) {
        statusEl.textContent = '✗ Failed to load Wasm module';
        statusEl.classList.add('error');
        console.error('[pdf_wasm] Module initialization failed:', err);
        showError(`Wasm module failed to load: ${err.message}`);
    }
}

// ─── LocalStorage Persistence ──────────────────────────

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            analysisHistory = JSON.parse(raw);
        }
    } catch (e) {
        console.warn('[pdf_wasm] Failed to load history from localStorage:', e);
        analysisHistory = [];
    }
}

function saveHistory() {
    try {
        // Cap history to MAX_HISTORY entries
        if (analysisHistory.length > MAX_HISTORY) {
            analysisHistory = analysisHistory.slice(-MAX_HISTORY);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(analysisHistory));
    } catch (e) {
        console.warn('[pdf_wasm] Failed to save history to localStorage:', e);
    }
}

function clearHistory() {
    analysisHistory = [];
    localStorage.removeItem(STORAGE_KEY);
    renderAllResults();
    updateHistoryControls();
}

function addToHistory(entry) {
    analysisHistory.push(entry);
    saveHistory();
}

// ─── File Processing ───────────────────────────────────

/**
 * Process multiple File objects sequentially.
 * @param {FileList|File[]} files
 */
async function processFiles(files) {
    if (!wasmModule) {
        showError('Wasm module is not loaded yet. Please wait.');
        return;
    }

    const resultsEl = document.getElementById('results');
    resultsEl.classList.add('visible');

    for (const file of files) {
        await processSingleFile(file);
    }
}

/**
 * Process a single File: read as ArrayBuffer, pass Uint8Array to C++, store result.
 * @param {File} file
 */
async function processSingleFile(file) {
    // Show inline loading for this file
    const loadingId = `loading-${Date.now()}`;
    const outputEl = document.getElementById('output');
    const loadingHtml = `
        <div class="loading" id="${loadingId}">
            <div class="spinner"></div>
            <p>Analyzing <strong>${escapeHtml(file.name)}</strong>…</p>
        </div>
    `;
    outputEl.insertAdjacentHTML('afterbegin', loadingHtml);

    try {
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Pass Uint8Array directly to C++ via emscripten::val
        // No string conversion — binary safe!
        const jsonResult = wasmModule.processPdfFile(uint8Array);
        const result = JSON.parse(jsonResult);

        // Build history entry
        const entry = {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            analyzedAt: new Date().toISOString(),
            result: result
        };

        addToHistory(entry);

        // Remove loading indicator and re-render
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();

        renderAllResults();
        updateHistoryControls();

    } catch (err) {
        console.error('[pdf_wasm] Processing error:', err);
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();
        showError(`Error processing ${file.name}: ${err.message}`);
    }
}

// ─── UI Rendering ──────────────────────────────────────

/**
 * Render all results from history (newest first).
 */
function renderAllResults() {
    const outputEl = document.getElementById('output');
    const resultsEl = document.getElementById('results');

    if (analysisHistory.length === 0) {
        outputEl.innerHTML = '';
        resultsEl.classList.remove('visible');
        return;
    }

    resultsEl.classList.add('visible');

    // Render newest first
    const cards = [...analysisHistory].reverse().map(entry => {
        return buildResultCard(entry);
    }).join('');

    outputEl.innerHTML = cards;
}

/**
 * Build HTML for a single result card.
 * @param {object} entry — history entry
 * @returns {string} HTML
 */
function buildResultCard(entry) {
    const result = entry.result;
    const statusClass = result.success ? 'status-valid' : 'status-invalid';
    const statusIcon  = result.success ? '✓' : '✗';

    const analyzedDate = new Date(entry.analyzedAt);
    const timeStr = analyzedDate.toLocaleString();

    return `
        <div class="result-card" data-id="${entry.id}">
            <button class="delete-btn" onclick="deleteEntry('${entry.id}')" title="Remove from history" aria-label="Remove ${escapeHtml(entry.fileName)} from history">×</button>
            <div class="result-header">
                <span class="result-icon ${statusClass}">${statusIcon}</span>
                <div>
                    <h3 class="result-filename">${escapeHtml(entry.fileName)}</h3>
                    <p class="result-message ${statusClass}">${escapeHtml(result.message)}</p>
                    <p class="result-time">${escapeHtml(timeStr)}</p>
                </div>
            </div>

            <div class="result-grid">
                <div class="result-item">
                    <span class="label">File Size</span>
                    <span class="value">${escapeHtml(result.fileSizeHuman)} <small>(${result.fileSize.toLocaleString()} bytes)</small></span>
                </div>
                <div class="result-item">
                    <span class="label">Magic Bytes</span>
                    <span class="value mono">${escapeHtml(result.magicBytes)}</span>
                </div>
                <div class="result-item">
                    <span class="label">PDF Version</span>
                    <span class="value">${escapeHtml(result.pdfVersion)}</span>
                </div>
                <div class="result-item">
                    <span class="label">Estimated Pages</span>
                    <span class="value">${result.estimatedPages}</span>
                </div>
                <div class="result-item">
                    <span class="label">Linearized</span>
                    <span class="value">${result.linearized ? 'Yes' : 'No'}</span>
                </div>
                <div class="result-item">
                    <span class="label">Encrypted</span>
                    <span class="value">${result.encrypted ? 'Yes ⚠' : 'No'}</span>
                </div>
            </div>

            <details class="raw-json">
                <summary>Raw JSON Response</summary>
                <pre><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre>
            </details>
        </div>
    `;
}

/**
 * Update the visibility and text of history controls (count + clear button).
 */
function updateHistoryControls() {
    const controlsEl = document.getElementById('history-controls');
    const countEl = document.getElementById('history-count');

    if (analysisHistory.length > 0) {
        controlsEl.classList.add('visible');
        const n = analysisHistory.length;
        countEl.textContent = `${n} file${n !== 1 ? 's' : ''} analyzed`;
    } else {
        controlsEl.classList.remove('visible');
    }
}

/**
 * Delete a single history entry by ID.
 * @param {string} id
 */
function deleteEntry(id) {
    analysisHistory = analysisHistory.filter(e => e.id !== id);
    saveHistory();

    // Animate removal
    const card = document.querySelector(`.result-card[data-id="${id}"]`);
    if (card) {
        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease, max-height 0.3s ease';
        card.style.opacity = '0';
        card.style.transform = 'translateX(20px)';
        card.style.maxHeight = card.offsetHeight + 'px';
        setTimeout(() => {
            card.style.maxHeight = '0';
            card.style.padding = '0';
            card.style.margin = '0';
            card.style.border = 'none';
        }, 200);
        setTimeout(() => {
            renderAllResults();
            updateHistoryControls();
        }, 400);
    } else {
        renderAllResults();
        updateHistoryControls();
    }
}

// Expose to onclick handlers
window.deleteEntry = deleteEntry;

/**
 * Show an error message in the output area (prepends, doesn't replace).
 * @param {string} msg
 */
function showError(msg) {
    const outputEl = document.getElementById('output');
    const resultsEl = document.getElementById('results');
    resultsEl.classList.add('visible');
    const errorHtml = `
        <div class="error-card">
            <span class="error-icon">⚠</span>
            <p>${escapeHtml(msg)}</p>
        </div>
    `;
    outputEl.insertAdjacentHTML('afterbegin', errorHtml);
}

/**
 * Escape HTML to prevent XSS when injecting user-controlled strings.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Event Handlers ────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const dropZone  = document.getElementById('drop-zone');
    const clearBtn  = document.getElementById('clear-history');

    // File input change — allow multiple files
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            processFiles(e.target.files);
            // Reset input so the same file can be re-uploaded
            e.target.value = '';
        }
    });

    // Drag & drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const files = [...e.dataTransfer.files].filter(f =>
            f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
        );
        if (files.length > 0) {
            processFiles(files);
        } else {
            showError('No PDF files detected. Please drop .pdf files.');
        }
    });

    // Click on drop zone triggers file input
    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    // Clear history
    clearBtn.addEventListener('click', () => {
        clearHistory();
    });

    // Load saved history and render
    loadHistory();
    renderAllResults();
    updateHistoryControls();

    // Initialize Wasm
    initWasm();
});
