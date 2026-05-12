/**
 * ocr_worker.js — Tesseract.js OCR wrapper for browser-side text recognition.
 * Uses CDN-loaded Tesseract.js v5 for ESM browser compatibility.
 */

let worker = null;
let initPromise = null;
let Tesseract = null;

async function loadTesseract() {
    if (Tesseract) return Tesseract;
    // Load from CDN as ESM — the npm package is CommonJS-only
    const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
    Tesseract = mod;
    return Tesseract;
}

async function ensureWorker(lang = 'eng') {
    if (worker) return worker;
    if (!initPromise) {
        initPromise = (async () => {
            const T = await loadTesseract();
            worker = await T.createWorker(lang, 1, {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        document.dispatchEvent(new CustomEvent('ocr-progress', { detail: Math.round((m.progress || 0) * 100) }));
                    }
                }
            });
            console.log(`[ocr] Tesseract worker ready (${lang}).`);
            return worker;
        })();
    }
    return initPromise;
}

export async function ocrFromImage(imageDataUrl, lang = 'eng') {
    const w = await ensureWorker(lang);
    const { data } = await w.recognize(imageDataUrl);
    return { text: data.text, confidence: Math.round(data.confidence) };
}

export async function ocrPdfPage(renderPageFn, pdfData, pageIndex, lang = 'eng') {
    const { dataUrl } = await renderPageFn(pdfData, pageIndex, 3);
    const result = await ocrFromImage(dataUrl, lang);
    return { ...result, pageIndex };
}

export async function terminateOcr() {
    if (worker) { await worker.terminate(); worker = null; initPromise = null; }
}
