/**
 * pdfium_worker.js — PDFium Wasm wrapper for browser-side PDF operations.
 *
 * Uses @embedpdf/pdfium (pre-compiled PDFium Wasm) to provide:
 *   - extractText(data)                         → full text from all pages
 *   - renderPage(data, pageIndex, scale)         → PNG data URL of a page
 *   - getPageCount(data)                         → accurate page count
 *   - getPageInfo(data)                          → dimensions/rotation per page
 *   - mergePdfs(arrayOfUint8Arrays)              → merged PDF bytes
 *   - splitPdf(data, pageRanges)                 → array of PDF bytes
 *   - deletePages(data, pageIndices)             → modified PDF bytes
 *   - rotatePages(data, pageIndices, rotation)   → modified PDF bytes
 *   - cropPages(data, pageIndices, box)          → modified PDF bytes
 *
 * Singleton pattern: PDFium is initialized once on first use.
 */

let pdfiumModule = null;
let initPromise = null;

// ─── Init ──────────────────────────────────────────────

async function ensureInit() {
    if (pdfiumModule) return pdfiumModule;
    if (!initPromise) {
        initPromise = (async () => {
            const { init } = await import('./node_modules/@embedpdf/pdfium/dist/index.browser.js');
            const wasmResponse = await fetch('./pdfium.wasm');
            const wasmBinary = await wasmResponse.arrayBuffer();
            pdfiumModule = await init({ wasmBinary });
            pdfiumModule.PDFiumExt_Init();
            console.log('[pdfium] PDFium Wasm initialized.');
            return pdfiumModule;
        })();
    }
    return initPromise;
}

// ─── Internal Helpers ──────────────────────────────────

function loadDocument(pdfium, data) {
    const filePtr = pdfium.pdfium.wasmExports.malloc(data.length);
    if (!filePtr) throw new Error('Failed to allocate Wasm memory.');
    pdfium.pdfium.HEAPU8.set(data, filePtr);
    const docPtr = pdfium.FPDF_LoadMemDocument(filePtr, data.length, null);
    if (!docPtr) {
        pdfium.pdfium.wasmExports.free(filePtr);
        throw new Error(`PDFium load failed (err ${pdfium.FPDF_GetLastError()}).`);
    }
    return { docPtr, filePtr };
}

/**
 * Save a PDFium document to a new Uint8Array.
 * This is the core pipeline for all write operations.
 */
function saveDocumentToBytes(pdfium, docPtr) {
    const writerPtr = pdfium.PDFiumExt_OpenFileWriter();
    if (!writerPtr) throw new Error('Failed to open file writer.');

    try {
        const saveResult = pdfium.PDFiumExt_SaveAsCopy(docPtr, writerPtr);
        if (!saveResult) throw new Error('PDFiumExt_SaveAsCopy failed.');

        const size = pdfium.PDFiumExt_GetFileWriterSize(writerPtr);
        if (size <= 0) throw new Error('Saved document has zero size.');

        const bufPtr = pdfium.pdfium.wasmExports.malloc(size);
        if (!bufPtr) throw new Error('Failed to allocate output buffer.');

        try {
            pdfium.PDFiumExt_GetFileWriterData(writerPtr, bufPtr, size);
            const output = new Uint8Array(size);
            output.set(new Uint8Array(pdfium.pdfium.HEAPU8.buffer, bufPtr, size));
            return output;
        } finally {
            pdfium.pdfium.wasmExports.free(bufPtr);
        }
    } finally {
        pdfium.PDFiumExt_CloseFileWriter(writerPtr);
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ─── Read Operations ───────────────────────────────────

/**
 * Get accurate page count.
 */
export async function getPageCount(data) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);
    try {
        return pdfium.FPDF_GetPageCount(docPtr);
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Get info for each page: width, height, rotation.
 */
export async function getPageInfo(data) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);
    try {
        const count = pdfium.FPDF_GetPageCount(docPtr);
        const pages = [];
        for (let i = 0; i < count; i++) {
            const pagePtr = pdfium.FPDF_LoadPage(docPtr, i);
            if (!pagePtr) {
                pages.push({ page: i + 1, width: 0, height: 0, rotation: 0 });
                continue;
            }
            try {
                pages.push({
                    page: i + 1,
                    width: Math.round(pdfium.FPDF_GetPageWidthF(pagePtr) * 100) / 100,
                    height: Math.round(pdfium.FPDF_GetPageHeightF(pagePtr) * 100) / 100,
                    rotation: pdfium.FPDFPage_GetRotation(pagePtr),
                });
            } finally {
                pdfium.FPDF_ClosePage(pagePtr);
            }
        }
        return pages;
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Extract text from all pages.
 */
export async function extractText(data) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);
    try {
        const pageCount = pdfium.FPDF_GetPageCount(docPtr);
        const pages = [];
        const fullTextParts = [];

        for (let i = 0; i < pageCount; i++) {
            const pagePtr = pdfium.FPDF_LoadPage(docPtr, i);
            if (!pagePtr) { pages.push({ page: i + 1, text: '[Load failed]' }); continue; }
            try {
                const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
                if (!textPagePtr) { pages.push({ page: i + 1, text: '[No text layer]' }); continue; }
                try {
                    const charCount = pdfium.FPDFText_CountChars(textPagePtr);
                    let pageText = '';
                    if (charCount > 0) {
                        const bufSize = (charCount + 1) * 2;
                        const bufPtr = pdfium.pdfium.wasmExports.malloc(bufSize);
                        if (bufPtr) {
                            try {
                                pdfium.FPDFText_GetText(textPagePtr, 0, charCount, bufPtr);
                                pageText = pdfium.pdfium.UTF16ToString(bufPtr);
                            } finally { pdfium.pdfium.wasmExports.free(bufPtr); }
                        }
                    }
                    pages.push({ page: i + 1, text: pageText });
                    fullTextParts.push(pageText);
                } finally { pdfium.FPDFText_ClosePage(textPagePtr); }
            } finally { pdfium.FPDF_ClosePage(pagePtr); }
        }
        return { pageCount, pages, fullText: fullTextParts.join('\n\n--- Page Break ---\n\n') };
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Render a single page as PNG data URL.
 */
export async function renderPage(data, pageIndex = 0, scale = 2) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);
    try {
        const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
        if (!pagePtr) throw new Error(`Failed to load page ${pageIndex + 1}.`);
        try {
            const rawW = pdfium.FPDF_GetPageWidthF(pagePtr);
            const rawH = pdfium.FPDF_GetPageHeightF(pagePtr);
            const width = Math.floor(rawW * scale);
            const height = Math.floor(rawH * scale);

            const bitmapPtr = pdfium.FPDFBitmap_CreateEx(width, height, 4, 0, 0);
            if (!bitmapPtr) throw new Error('Bitmap creation failed.');
            try {
                pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, width, height, 0xFFFFFFFF);
                pdfium.FPDF_RenderPageBitmap(bitmapPtr, pagePtr, 0, 0, width, height, 0, 0x11);

                const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
                const stride = pdfium.FPDFBitmap_GetStride(bitmapPtr);
                const bgraData = new Uint8Array(pdfium.pdfium.HEAPU8.buffer, bufferPtr, stride * height);

                const rgbaData = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const s = y * stride + x * 4;
                        const d = (y * width + x) * 4;
                        rgbaData[d] = bgraData[s + 2];
                        rgbaData[d + 1] = bgraData[s + 1];
                        rgbaData[d + 2] = bgraData[s];
                        rgbaData[d + 3] = bgraData[s + 3];
                    }
                }

                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext('2d');
                ctx.putImageData(new ImageData(rgbaData, width, height), 0, 0);
                const blob = await canvas.convertToBlob({ type: 'image/png' });
                const dataUrl = await blobToDataUrl(blob);
                return { dataUrl, width, height };
            } finally { pdfium.FPDFBitmap_Destroy(bitmapPtr); }
        } finally { pdfium.FPDF_ClosePage(pagePtr); }
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

// ─── Write Operations ──────────────────────────────────

/**
 * Merge multiple PDFs into one.
 * @param {Uint8Array[]} pdfs — array of PDF byte arrays
 * @returns {Promise<Uint8Array>} — merged PDF bytes
 */
export async function mergePdfs(pdfs) {
    if (pdfs.length < 2) throw new Error('Need at least 2 PDFs to merge.');
    const pdfium = await ensureInit();

    const destDoc = pdfium.FPDF_CreateNewDocument();
    if (!destDoc) throw new Error('Failed to create destination document.');

    const loadedDocs = [];

    try {
        for (const pdfData of pdfs) {
            const { docPtr, filePtr } = loadDocument(pdfium, pdfData);
            loadedDocs.push({ docPtr, filePtr });

            const pageCount = pdfium.FPDF_GetPageCount(docPtr);
            // Import all pages. pageRange null = all pages.
            const currentDestPages = pdfium.FPDF_GetPageCount(destDoc);
            const ok = pdfium.FPDF_ImportPages(destDoc, docPtr, null, currentDestPages);
            if (!ok) console.warn('[pdfium] ImportPages returned false for a document.');
        }

        return saveDocumentToBytes(pdfium, destDoc);
    } finally {
        for (const { docPtr, filePtr } of loadedDocs) {
            pdfium.FPDF_CloseDocument(docPtr);
            pdfium.pdfium.wasmExports.free(filePtr);
        }
        pdfium.FPDF_CloseDocument(destDoc);
    }
}

/**
 * Split a PDF into multiple PDFs by page ranges.
 * @param {Uint8Array} data — source PDF bytes
 * @param {string[]} pageRanges — e.g., ["1-3", "5", "7-10"]
 * @returns {Promise<Array<{range: string, data: Uint8Array}>>}
 */
export async function splitPdf(data, pageRanges) {
    if (!pageRanges.length) throw new Error('No page ranges specified.');
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);

    try {
        const results = [];

        for (const range of pageRanges) {
            const newDoc = pdfium.FPDF_CreateNewDocument();
            if (!newDoc) throw new Error('Failed to create split document.');

            try {
                // FPDF_ImportPages expects 1-based page ranges like "1,2,3" or "1-3"
                const ok = pdfium.FPDF_ImportPages(newDoc, docPtr, range, 0);
                if (!ok) throw new Error(`Failed to import pages "${range}".`);
                results.push({ range, data: saveDocumentToBytes(pdfium, newDoc) });
            } finally {
                pdfium.FPDF_CloseDocument(newDoc);
            }
        }

        return results;
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Delete specific pages from a PDF.
 * @param {Uint8Array} data — source PDF bytes
 * @param {number[]} pageIndices — 0-based indices to delete
 * @returns {Promise<Uint8Array>}
 */
export async function deletePages(data, pageIndices) {
    if (!pageIndices.length) throw new Error('No pages to delete.');
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);

    try {
        // Delete from highest index to lowest to avoid index shifting
        const sorted = [...new Set(pageIndices)].sort((a, b) => b - a);
        for (const idx of sorted) {
            pdfium.FPDFPage_Delete(docPtr, idx);
        }
        return saveDocumentToBytes(pdfium, docPtr);
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Rotate specific pages of a PDF.
 * @param {Uint8Array} data — source PDF bytes
 * @param {number[]} pageIndices — 0-based indices to rotate (empty = all)
 * @param {number} rotation — 0=0°, 1=90°, 2=180°, 3=270°
 * @returns {Promise<Uint8Array>}
 */
export async function rotatePages(data, pageIndices, rotation) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);

    try {
        const count = pdfium.FPDF_GetPageCount(docPtr);
        const indices = pageIndices.length > 0 ? pageIndices : Array.from({ length: count }, (_, i) => i);

        for (const idx of indices) {
            if (idx < 0 || idx >= count) continue;
            const pagePtr = pdfium.FPDF_LoadPage(docPtr, idx);
            if (!pagePtr) continue;
            try {
                pdfium.FPDFPage_SetRotation(pagePtr, rotation);
            } finally {
                pdfium.FPDF_ClosePage(pagePtr);
            }
        }
        return saveDocumentToBytes(pdfium, docPtr);
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Crop specific pages of a PDF.
 * @param {Uint8Array} data — source PDF bytes
 * @param {number[]} pageIndices — 0-based (empty = all)
 * @param {{ left: number, bottom: number, right: number, top: number }} box — crop box in PDF points
 * @returns {Promise<Uint8Array>}
 */
export async function cropPages(data, pageIndices, box) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);

    try {
        const count = pdfium.FPDF_GetPageCount(docPtr);
        const indices = pageIndices.length > 0 ? pageIndices : Array.from({ length: count }, (_, i) => i);

        for (const idx of indices) {
            if (idx < 0 || idx >= count) continue;
            const pagePtr = pdfium.FPDF_LoadPage(docPtr, idx);
            if (!pagePtr) continue;
            try {
                pdfium.FPDFPage_SetCropBox(pagePtr, box.left, box.bottom, box.right, box.top);
            } finally {
                pdfium.FPDF_ClosePage(pagePtr);
            }
        }
        return saveDocumentToBytes(pdfium, docPtr);
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}
