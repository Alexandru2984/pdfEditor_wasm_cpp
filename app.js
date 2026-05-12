import { extractText, getPageCount, renderPage, getPageInfo } from './pdfium_worker.js';
import { execMerge, execSplit, execDeletePages, execRotate, execCrop, execOcr, execRenderAllPages, logToBackend, downloadBlob } from './pdf_tools.js';

const STORAGE_KEY = 'pdf_wasm_history';
let wasmModule = null;
let analysisHistory = [];
let selectedId = null;
const fileDataCache = new Map();

function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function showToast(msg, type = 'error') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span>${type === 'error' ? '⚠' : '✓'}</span><p>${esc(msg)}</p>`;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
}

// ─── Init ──────────────────────────────────────────────

async function initWasm() {
    try {
        const { default: create } = await import('./pdf_processor.js');
        wasmModule = await create();
        const el = document.getElementById('wasm-status');
        el.textContent = '✓ Analyzer ready'; el.classList.add('ready');
        document.getElementById('file-input').disabled = false;
        document.getElementById('upload-btn').classList.add('active');
    } catch (e) {
        const el = document.getElementById('wasm-status');
        el.textContent = '✗ Failed'; el.classList.add('error');
    }
}

function initPdfium() {
    const el = document.getElementById('pdfium-status');
    el.textContent = '✓ PDFium ready'; el.classList.add('ready');
}

// ─── Storage ───────────────────────────────────────────

function loadHistory() {
    try { const r = localStorage.getItem(STORAGE_KEY); if (r) analysisHistory = JSON.parse(r); } catch(_) {}
}
function saveHistory() {
    try { if (analysisHistory.length > 100) analysisHistory = analysisHistory.slice(-100); localStorage.setItem(STORAGE_KEY, JSON.stringify(analysisHistory)); } catch(_) {}
}

// ─── File Processing ───────────────────────────────────

async function processFiles(files) {
    if (!wasmModule) { showToast('Wasm not loaded yet.'); return; }
    const listEl = document.getElementById('doc-list');
    listEl.innerHTML = `<div class="doc-item-loading" id="batch-loading"><div class="mini-spinner"></div><span>Processing ${files.length} file(s)…</span></div>` + listEl.innerHTML;
    let lastId = null;
    for (const file of files) {
        try {
            const buf = await file.arrayBuffer();
            const u8 = new Uint8Array(buf);
            const meta = JSON.parse(wasmModule.processPdfFile(u8));
            let pc = meta.estimatedPages;
            try { pc = await getPageCount(u8); } catch(_) {}
            const entry = {
                id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2),
                fileName: file.name, analyzedAt: new Date().toISOString(),
                result: { ...meta, estimatedPages: pc },
            };
            fileDataCache.set(entry.id, u8);
            analysisHistory.push(entry);
            lastId = entry.id;
        } catch (e) { showToast(`Error: ${file.name}: ${e.message}`); }
    }
    saveHistory();
    const ld = document.getElementById('batch-loading'); if (ld) ld.remove();
    renderSidebar();
    if (lastId) selectDocument(lastId);
}

// ─── Sidebar ───────────────────────────────────────────

function renderSidebar() {
    const listEl = document.getElementById('doc-list');
    const countEl = document.getElementById('doc-count');
    const clearBtn = document.getElementById('clear-all');
    if (!analysisHistory.length) {
        listEl.innerHTML = `<div class="doc-list-empty"><span class="empty-icon">📂</span>No documents yet.</div>`;
        countEl.textContent = 'Documents'; clearBtn.classList.remove('visible'); return;
    }
    clearBtn.classList.add('visible');
    countEl.textContent = `${analysisHistory.length} doc${analysisHistory.length !== 1 ? 's' : ''}`;
    listEl.innerHTML = [...analysisHistory].reverse().map(e => {
        const r = e.result, sel = e.id === selectedId;
        const d = new Date(e.analyzedAt);
        return `<div class="doc-item ${sel?'selected':''}" data-id="${e.id}" onclick="window._sel('${e.id}')">
            <div class="doc-item-icon ${r.success?'valid':'invalid'}">${r.success?'✓':'✗'}</div>
            <div class="doc-item-info">
                <div class="doc-item-name" title="${esc(e.fileName)}">${esc(e.fileName)}</div>
                <div class="doc-item-meta"><span>${r.fileSizeHuman}</span><span>${r.estimatedPages} pg</span><span>${d.toLocaleDateString([],{month:'short',day:'numeric'})}</span></div>
            </div>
            <button class="doc-item-delete" onclick="window._del('${e.id}',event)" title="Remove">×</button>
        </div>`;
    }).join('');
}

function selectDocument(id) {
    selectedId = id;
    document.querySelectorAll('.doc-item').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
    const entry = analysisHistory.find(e => e.id === id);
    if (entry) renderDetail(entry);
}

function deleteEntry(id, ev) {
    if (ev) ev.stopPropagation();
    analysisHistory = analysisHistory.filter(e => e.id !== id);
    fileDataCache.delete(id); saveHistory();
    if (selectedId === id) { selectedId = null; document.getElementById('main-content').innerHTML = emptyHTML(); }
    renderSidebar();
}

function clearAll() {
    analysisHistory = []; selectedId = null; fileDataCache.clear(); localStorage.removeItem(STORAGE_KEY);
    renderSidebar(); document.getElementById('main-content').innerHTML = emptyHTML();
}

function emptyHTML() {
    return `<div class="empty-state"><span class="empty-icon">📊</span><h2>Select a document</h2><p>Upload PDF files, then click one to analyze.</p></div>`;
}

// ─── Detail View (Tabbed) ──────────────────────────────

function renderDetail(entry) {
    const r = entry.result, hasData = fileDataCache.has(entry.id);
    const d = new Date(entry.analyzedAt);
    document.getElementById('main-content').innerHTML = `
    <div class="detail-view">
        <div class="detail-header">
            <div class="detail-icon ${r.success?'valid':'invalid'}">${r.success?'✓':'✗'}</div>
            <div>
                <h1 class="detail-title">${esc(entry.fileName)}</h1>
                <p class="detail-message ${r.success?'valid':'invalid'}">${esc(r.message)}</p>
                <p class="detail-time">Analyzed ${d.toLocaleString()}</p>
            </div>
        </div>
        <div class="detail-tabs">
            <button class="detail-tab active" data-tab="metadata">📋 Metadata</button>
            <button class="detail-tab" data-tab="tools">🛠 Tools</button>
            <button class="detail-tab" data-tab="text">📝 Text</button>
            <button class="detail-tab" data-tab="preview">🖼 Preview</button>
        </div>
        <div id="tab-metadata" class="tab-content active">${renderMetaTab(entry)}</div>
        <div id="tab-tools" class="tab-content">${hasData ? renderToolsTab(entry) : '<p class="text-muted-note">⚠ Re-upload file to enable tools.</p>'}</div>
        <div id="tab-text" class="tab-content"><div id="text-tab-content"><button class="tool-submit" onclick="window._extractText('${entry.id}')">📝 Extract Text</button></div></div>
        <div id="tab-preview" class="tab-content"><div id="preview-tab-content"><button class="tool-submit" onclick="window._renderAll('${entry.id}')">🖼 Render All Pages</button></div></div>
    </div>`;
    document.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        });
    });
}

function renderMetaTab(entry) {
    const r = entry.result;
    return `
    <div class="stats-grid">
        <div class="stat-card"><span class="stat-label">File Size</span><span class="stat-value">${esc(r.fileSizeHuman)}<br><small>${r.fileSize.toLocaleString()} bytes</small></span></div>
        <div class="stat-card"><span class="stat-label">PDF Version</span><span class="stat-value">${esc(r.pdfVersion)}</span></div>
        <div class="stat-card"><span class="stat-label">Pages</span><span class="stat-value">${r.estimatedPages}</span></div>
        <div class="stat-card"><span class="stat-label">Magic Bytes</span><span class="stat-value mono">${esc(r.magicBytes)}</span></div>
        <div class="stat-card"><span class="stat-label">Linearized</span><span class="stat-value">${r.linearized?'Yes':'No'}</span></div>
        <div class="stat-card"><span class="stat-label">Encrypted</span><span class="stat-value">${r.encrypted?'Yes ⚠':'No'}</span></div>
    </div>
    <div class="badges-row">
        <span class="badge ${r.success?'yes':'no'}">${r.success?'✓ Valid':'✗ Invalid'}</span>
        <span class="badge ${r.linearized?'yes':'no'}">${r.linearized?'⚡ Linearized':'— Not linearized'}</span>
        <span class="badge ${r.encrypted?'warn':'no'}">${r.encrypted?'🔒 Encrypted':'🔓 Not encrypted'}</span>
    </div>
    <details class="raw-json"><summary>Raw JSON</summary><pre><code>${esc(JSON.stringify(r,null,2))}</code></pre></details>`;
}

function renderToolsTab(entry) {
    const id = entry.id, pc = entry.result.estimatedPages;
    return `
    <div class="tools-grid">
        <div class="tool-card" onclick="window._openTool('merge','${id}')">
            <div class="tool-card-icon">🔀</div>
            <div class="tool-card-title">Merge PDFs</div>
            <div class="tool-card-desc">Combine multiple PDFs into one document</div>
        </div>
        <div class="tool-card" onclick="window._openTool('split','${id}')">
            <div class="tool-card-icon">✂️</div>
            <div class="tool-card-title">Split PDF</div>
            <div class="tool-card-desc">Extract page ranges into separate files</div>
        </div>
        <div class="tool-card" onclick="window._openTool('delete','${id}')">
            <div class="tool-card-icon">🗑️</div>
            <div class="tool-card-title">Delete Pages</div>
            <div class="tool-card-desc">Remove specific pages from the PDF</div>
        </div>
        <div class="tool-card" onclick="window._openTool('rotate','${id}')">
            <div class="tool-card-icon">🔄</div>
            <div class="tool-card-title">Rotate Pages</div>
            <div class="tool-card-desc">Rotate pages by 90°, 180° or 270°</div>
        </div>
        <div class="tool-card" onclick="window._openTool('crop','${id}')">
            <div class="tool-card-icon">🔲</div>
            <div class="tool-card-title">Crop Pages</div>
            <div class="tool-card-desc">Set crop box dimensions on pages</div>
        </div>
        <div class="tool-card" onclick="window._openTool('ocr','${id}')">
            <div class="tool-card-icon">🔍</div>
            <div class="tool-card-title">OCR</div>
            <div class="tool-card-desc">Recognize text from scanned/image pages</div>
        </div>
    </div>
    <div id="tool-panel-area"></div>`;
}

// ─── Tool Panels ───────────────────────────────────────

function pageGrid(count, prefix) {
    let h = '<div class="page-grid">';
    for (let i = 0; i < count; i++) h += `<div class="page-checkbox" data-idx="${i}" onclick="this.classList.toggle('selected')">${i+1}</div>`;
    return h + '</div>';
}

function getSelectedPages(container) {
    return [...container.querySelectorAll('.page-checkbox.selected')].map(el => parseInt(el.dataset.idx));
}

window._openTool = function(tool, id) {
    const entry = analysisHistory.find(e => e.id === id);
    if (!entry) return;
    const area = document.getElementById('tool-panel-area');
    const pc = entry.result.estimatedPages;
    const panels = {
        merge: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">🔀 Merge PDFs</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <p class="tool-card-desc" style="margin-bottom:0.75rem">Select other documents from the sidebar to merge with this one. Order: current document first, then selected documents in sidebar order.</p>
            <div id="merge-doc-list">${analysisHistory.filter(e=>e.id!==id && fileDataCache.has(e.id)).map(e=>
                `<label style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;cursor:pointer;font-size:0.82rem;color:var(--text-secondary)"><input type="checkbox" value="${e.id}" class="merge-cb">${esc(e.fileName)}</label>`
            ).join('') || '<p class="text-muted-note">Upload more PDFs first.</p>'}</div>
            <button class="tool-submit" style="margin-top:0.75rem" onclick="window._runMerge('${id}')">Merge & Download</button>
            <div id="merge-result"></div></div>`,

        split: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">✂️ Split PDF (${pc} pages)</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <div class="tool-row"><label class="tool-label">Page Ranges (comma separated)</label><input class="tool-input" id="split-ranges" placeholder="e.g. 1-3, 5, 7-${pc}"></div>
            <button class="tool-submit" onclick="window._runSplit('${id}')">Split & Download</button>
            <div id="split-result"></div></div>`,

        delete: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">🗑️ Delete Pages (${pc} pages)</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <p class="tool-card-desc" style="margin-bottom:0.5rem">Click pages to select for deletion:</p>
            ${pageGrid(pc)}
            <button class="tool-submit" style="margin-top:0.5rem" onclick="window._runDelete('${id}')">Delete Selected & Download</button>
            <div id="delete-result"></div></div>`,

        rotate: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">🔄 Rotate Pages (${pc} pages)</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <p class="tool-card-desc" style="margin-bottom:0.5rem">Select pages (none = all):</p>
            ${pageGrid(pc)}
            <div class="tool-row" style="margin-top:0.75rem"><label class="tool-label">Rotation</label>
            <select class="tool-select" id="rotate-angle"><option value="1">90° clockwise</option><option value="2">180°</option><option value="3">270° clockwise</option></select></div>
            <button class="tool-submit" onclick="window._runRotate('${id}')">Rotate & Download</button>
            <div id="rotate-result"></div></div>`,

        crop: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">🔲 Crop Pages (${pc} pages)</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <p class="tool-card-desc" style="margin-bottom:0.5rem">Select pages (none = all):</p>
            ${pageGrid(pc)}
            <div class="tool-row-inline" style="margin-top:0.75rem">
                <div><label class="tool-label">Left (pt)</label><input class="tool-input" id="crop-l" value="36" type="number"></div>
                <div><label class="tool-label">Bottom (pt)</label><input class="tool-input" id="crop-b" value="36" type="number"></div>
                <div><label class="tool-label">Right (pt)</label><input class="tool-input" id="crop-r" value="576" type="number"></div>
                <div><label class="tool-label">Top (pt)</label><input class="tool-input" id="crop-t" value="756" type="number"></div>
            </div>
            <button class="tool-submit" style="margin-top:0.75rem" onclick="window._runCrop('${id}')">Crop & Download</button>
            <div id="crop-result"></div></div>`,

        ocr: `<div class="tool-panel"><div class="tool-panel-header"><span class="tool-panel-title">🔍 OCR</span><button class="tool-panel-close" onclick="this.closest('.tool-panel').remove()">×</button></div>
            <div class="tool-row-inline">
                <div><label class="tool-label">Page (1-${pc})</label><input class="tool-input" id="ocr-page" value="1" type="number" min="1" max="${pc}"></div>
                <div><label class="tool-label">Language</label><select class="tool-select" id="ocr-lang"><option value="eng">English</option><option value="ron">Romanian</option><option value="deu">German</option><option value="fra">French</option></select></div>
            </div>
            <button class="tool-submit" style="margin-top:0.75rem" onclick="window._runOcr('${id}')">Run OCR</button>
            <div id="ocr-progress-area"></div>
            <div id="ocr-result"></div></div>`,
    };
    area.innerHTML = panels[tool] || '';
};

// ─── Tool Runners ──────────────────────────────────────

window._runMerge = async function(id) {
    const cbs = [...document.querySelectorAll('.merge-cb:checked')].map(cb => cb.value);
    const ids = [id, ...cbs];
    try {
        await execMerge(fileDataCache, ids, analysisHistory.filter(e => ids.includes(e.id)));
        document.getElementById('merge-result').innerHTML = '<p style="color:var(--success);margin-top:0.5rem">✓ Merged PDF downloaded.</p>';
    } catch(e) { showToast(e.message); }
};

window._runSplit = async function(id) {
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    const ranges = document.getElementById('split-ranges').value;
    try {
        const results = await execSplit(data, ranges, entry.fileName);
        document.getElementById('split-result').innerHTML = `<p style="color:var(--success);margin-top:0.5rem">✓ ${results.length} file(s) downloaded.</p>`;
        logToBackend(entry, 'split');
    } catch(e) { showToast(e.message); }
};

window._runDelete = async function(id) {
    const panel = document.querySelector('.tool-panel');
    const indices = getSelectedPages(panel);
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    try {
        await execDeletePages(data, indices, entry.fileName);
        document.getElementById('delete-result').innerHTML = `<p style="color:var(--success);margin-top:0.5rem">✓ Deleted ${indices.length} page(s). Downloaded.</p>`;
        logToBackend(entry, 'delete_pages');
    } catch(e) { showToast(e.message); }
};

window._runRotate = async function(id) {
    const panel = document.querySelector('.tool-panel');
    const indices = getSelectedPages(panel);
    const rotation = parseInt(document.getElementById('rotate-angle').value);
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    try {
        await execRotate(data, indices, rotation, entry.fileName);
        document.getElementById('rotate-result').innerHTML = '<p style="color:var(--success);margin-top:0.5rem">✓ Rotated. Downloaded.</p>';
        logToBackend(entry, 'rotate_pages');
    } catch(e) { showToast(e.message); }
};

window._runCrop = async function(id) {
    const panel = document.querySelector('.tool-panel');
    const indices = getSelectedPages(panel);
    const box = {
        left: parseFloat(document.getElementById('crop-l').value),
        bottom: parseFloat(document.getElementById('crop-b').value),
        right: parseFloat(document.getElementById('crop-r').value),
        top: parseFloat(document.getElementById('crop-t').value),
    };
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    try {
        await execCrop(data, indices, box, entry.fileName);
        document.getElementById('crop-result').innerHTML = '<p style="color:var(--success);margin-top:0.5rem">✓ Cropped. Downloaded.</p>';
        logToBackend(entry, 'crop_pages');
    } catch(e) { showToast(e.message); }
};

window._runOcr = async function(id) {
    const pageIdx = parseInt(document.getElementById('ocr-page').value) - 1;
    const lang = document.getElementById('ocr-lang').value;
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    const progArea = document.getElementById('ocr-progress-area');
    const resArea = document.getElementById('ocr-result');
    progArea.innerHTML = '<div class="progress-bar"><div class="progress-bar-fill" id="ocr-bar" style="width:0%"></div></div><p class="progress-label" id="ocr-label">Initializing OCR…</p>';
    
    const handler = (ev) => {
        const bar = document.getElementById('ocr-bar');
        const lbl = document.getElementById('ocr-label');
        if (bar) bar.style.width = ev.detail + '%';
        if (lbl) lbl.textContent = `Recognizing… ${ev.detail}%`;
    };
    document.addEventListener('ocr-progress', handler);
    
    try {
        const result = await execOcr(data, pageIdx, lang);
        const confClass = result.confidence >= 80 ? 'high' : result.confidence >= 50 ? 'medium' : 'low';
        resArea.innerHTML = `
            <div style="margin-top:0.75rem">
                <span class="ocr-confidence ${confClass}">Confidence: ${result.confidence}%</span>
                <pre class="extracted-text-content">${esc(result.text || '(No text recognized)')}</pre>
            </div>`;
        progArea.innerHTML = '';
        logToBackend(entry, 'ocr');
    } catch(e) {
        progArea.innerHTML = '';
        showToast(`OCR failed: ${e.message}`);
    } finally {
        document.removeEventListener('ocr-progress', handler);
    }
};

// ─── Text Tab ──────────────────────────────────────────

window._extractText = async function(id) {
    const data = fileDataCache.get(id);
    const container = document.getElementById('text-tab-content');
    if (!data) { showToast('Re-upload file first.'); return; }
    container.innerHTML = '<p class="progress-label">Extracting text…</p>';
    try {
        const result = await extractText(data);
        container.innerHTML = `
            <div class="text-result">
                <div class="text-stats"><span>${result.pageCount} pages</span><span>${result.fullText.length.toLocaleString()} chars</span></div>
                <pre class="extracted-text-content">${esc(result.fullText || '(No text — PDF may be scanned)')}</pre>
            </div>`;
        const entry = analysisHistory.find(e => e.id === id);
        if (entry) { entry.result.estimatedPages = result.pageCount; saveHistory(); renderSidebar(); }
    } catch(e) { container.innerHTML = `<p class="text-error">Failed: ${esc(e.message)}</p>`; }
};

// ─── Preview Tab ───────────────────────────────────────

window._renderAll = async function(id) {
    const data = fileDataCache.get(id);
    const entry = analysisHistory.find(e => e.id === id);
    const container = document.getElementById('preview-tab-content');
    if (!data) { showToast('Re-upload file first.'); return; }
    const pc = entry?.result?.estimatedPages || 1;
    container.innerHTML = '<p class="progress-label">Rendering pages…</p>';
    try {
        const thumbs = await execRenderAllPages(data, pc, 1.2);
        container.innerHTML = '<div class="thumb-grid">' + thumbs.map(t =>
            `<div class="thumb-card"><img src="${t.dataUrl}" alt="Page ${t.page}"><div class="thumb-card-footer">Page ${t.page} · ${t.width}×${t.height}</div></div>`
        ).join('') + '</div>';
    } catch(e) { container.innerHTML = `<p class="text-error">Render failed: ${esc(e.message)}</p>`; }
};

// ─── Global Handlers ───────────────────────────────────

window._sel = selectDocument;
window._del = deleteEntry;

// ─── DOMContentLoaded ──────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const clearBtn = document.getElementById('clear-all');

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files.length) { processFiles(e.target.files); e.target.value = ''; } });

    [uploadBtn, document.getElementById('doc-list')].forEach(el => {
        el.addEventListener('dragover', e => { e.preventDefault(); uploadBtn.classList.add('dragover'); });
        el.addEventListener('dragleave', e => { e.preventDefault(); uploadBtn.classList.remove('dragover'); });
        el.addEventListener('drop', e => {
            e.preventDefault(); uploadBtn.classList.remove('dragover');
            const pdfs = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
            if (pdfs.length) processFiles(pdfs); else showToast('No PDF files detected.');
        });
    });

    clearBtn.addEventListener('click', clearAll);
    loadHistory(); renderSidebar();
    if (analysisHistory.length) selectDocument(analysisHistory[analysisHistory.length - 1].id);
    initWasm(); initPdfium();
});
