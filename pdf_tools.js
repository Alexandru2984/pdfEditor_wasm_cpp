/**
 * pdf_tools.js — Tool execution + download helpers.
 * Imported by app.js. Keeps tool logic separate from UI rendering.
 */

import { mergePdfs, splitPdf, deletePages, rotatePages, cropPages, renderPage, extractText } from './pdfium_worker.js';
// OCR is loaded lazily to avoid blocking app init

const BACKEND_URL = 'http://localhost:8000/api/save-pdf-job/';
const AUTH_TOKEN = 'dev-token-change-me-in-production';

// ─── Download Helper ───────────────────────────────────

export function downloadBlob(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Backend Logger ────────────────────────────────────

export async function logToBackend(entry, opType) {
    try {
        await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({
                filename: entry.fileName,
                file_size: entry.result?.fileSize || 0,
                pdf_version: entry.result?.pdfVersion || '',
                page_count: entry.result?.estimatedPages || 0,
                operation_type: opType,
                text_preview: '',
                status: 'completed',
            }),
        });
    } catch (e) { console.warn('[backend]', e.message); }
}

// ─── Tool Executors ────────────────────────────────────

export async function execMerge(fileDataCache, selectedIds, entries) {
    const pdfs = selectedIds.map(id => fileDataCache.get(id)).filter(Boolean);
    if (pdfs.length < 2) throw new Error('Select at least 2 documents to merge.');
    const result = await mergePdfs(pdfs);
    downloadBlob(result, 'merged.pdf');
    if (entries[0]) logToBackend(entries[0], 'merge');
    return result;
}

export async function execSplit(data, rangesStr, fileName) {
    const ranges = rangesStr.split(',').map(s => s.trim()).filter(Boolean);
    if (!ranges.length) throw new Error('Enter page ranges like "1-3, 5, 7-10".');
    const results = await splitPdf(data, ranges);
    for (const r of results) {
        downloadBlob(r.data, `${fileName.replace('.pdf','')}_pages_${r.range}.pdf`);
    }
    return results;
}

export async function execDeletePages(data, indices, fileName) {
    if (!indices.length) throw new Error('Select pages to delete.');
    const result = await deletePages(data, indices);
    downloadBlob(result, `${fileName.replace('.pdf','')}_trimmed.pdf`);
    return result;
}

export async function execRotate(data, indices, rotation, fileName) {
    const result = await rotatePages(data, indices, rotation);
    const rotDeg = [0, 90, 180, 270][rotation] || 0;
    downloadBlob(result, `${fileName.replace('.pdf','')}_rotated_${rotDeg}.pdf`);
    return result;
}

export async function execCrop(data, indices, box, fileName) {
    const result = await cropPages(data, indices, box);
    downloadBlob(result, `${fileName.replace('.pdf','')}_cropped.pdf`);
    return result;
}

export async function execOcr(data, pageIndex, lang = 'eng') {
    const { ocrPdfPage } = await import('./ocr_worker.js');
    return await ocrPdfPage(renderPage, data, pageIndex, lang);
}

export async function execRenderAllPages(data, pageCount, scale = 1.5) {
    const thumbs = [];
    for (let i = 0; i < Math.min(pageCount, 20); i++) {
        const result = await renderPage(data, i, scale);
        thumbs.push({ page: i + 1, ...result });
    }
    return thumbs;
}
