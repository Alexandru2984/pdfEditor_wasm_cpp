/**
 * pdfium_worker.js — PDFium Wasm wrapper for browser-side PDF operations.
 *
 * Uses @embedpdf/pdfium (pre-compiled PDFium Wasm) to provide:
 *   - extractText(uint8Array)       → full text extraction from all pages
 *   - renderFirstPage(uint8Array)   → renders first page as PNG data URL
 *   - getPageCount(uint8Array)      → accurate page count from PDFium
 *
 * Singleton pattern: PDFium is initialized once on first use.
 */

let pdfiumModule = null;
let initPromise = null;

/**
 * Initialize PDFium Wasm module (singleton — only loads once).
 * @returns {Promise<WrappedPdfiumModule>}
 */
async function ensureInit() {
    if (pdfiumModule) return pdfiumModule;

    if (!initPromise) {
        initPromise = (async () => {
            // Load the browser-targeted build
            const { init } = await import('./node_modules/@embedpdf/pdfium/dist/index.browser.js');

            // Fetch the local .wasm binary
            const wasmResponse = await fetch('./pdfium.wasm');
            const wasmBinary = await wasmResponse.arrayBuffer();

            pdfiumModule = await init({ wasmBinary });

            // Initialize the PDFium extension library (required before any ops)
            pdfiumModule.PDFiumExt_Init();

            console.log('[pdfium_worker] PDFium Wasm initialized.');
            return pdfiumModule;
        })();
    }

    return initPromise;
}

/**
 * Load a PDF document from a Uint8Array into PDFium Wasm memory.
 * Returns { docPtr, filePtr } — caller MUST call cleanup when done.
 *
 * @param {WrappedPdfiumModule} pdfium
 * @param {Uint8Array} data
 * @returns {{ docPtr: number, filePtr: number }}
 */
function loadDocument(pdfium, data) {
    const filePtr = pdfium.pdfium.wasmExports.malloc(data.length);
    if (!filePtr) throw new Error('Failed to allocate Wasm memory for PDF.');

    pdfium.pdfium.HEAPU8.set(data, filePtr);

    const docPtr = pdfium.FPDF_LoadMemDocument(filePtr, data.length, null);
    if (!docPtr) {
        pdfium.pdfium.wasmExports.free(filePtr);
        const err = pdfium.FPDF_GetLastError();
        throw new Error(`PDFium failed to load document (error code: ${err}).`);
    }

    return { docPtr, filePtr };
}

/**
 * Extract text from all pages of a PDF.
 *
 * @param {Uint8Array} data — raw PDF bytes
 * @returns {Promise<{ pageCount: number, pages: Array<{ page: number, text: string }>, fullText: string }>}
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
            if (!pagePtr) {
                pages.push({ page: i + 1, text: '[Failed to load page]' });
                continue;
            }

            try {
                const textPagePtr = pdfium.FPDFText_LoadPage(pagePtr);
                if (!textPagePtr) {
                    pages.push({ page: i + 1, text: '[Failed to load text layer]' });
                    continue;
                }

                try {
                    const charCount = pdfium.FPDFText_CountChars(textPagePtr);
                    let pageText = '';

                    if (charCount > 0) {
                        // FPDFText_GetText writes UTF-16LE into the buffer
                        // Buffer size: (charCount + 1) * 2 bytes for UTF-16 + null terminator
                        const bufSize = (charCount + 1) * 2;
                        const bufPtr = pdfium.pdfium.wasmExports.malloc(bufSize);

                        if (bufPtr) {
                            try {
                                pdfium.FPDFText_GetText(textPagePtr, 0, charCount, bufPtr);
                                pageText = pdfium.pdfium.UTF16ToString(bufPtr);
                            } finally {
                                pdfium.pdfium.wasmExports.free(bufPtr);
                            }
                        }
                    }

                    pages.push({ page: i + 1, text: pageText });
                    fullTextParts.push(pageText);
                } finally {
                    pdfium.FPDFText_ClosePage(textPagePtr);
                }
            } finally {
                pdfium.FPDF_ClosePage(pagePtr);
            }
        }

        return {
            pageCount,
            pages,
            fullText: fullTextParts.join('\n\n--- Page Break ---\n\n')
        };
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Render the first page of a PDF as a PNG data URL.
 *
 * @param {Uint8Array} data — raw PDF bytes
 * @param {number} [scale=2] — render scale factor
 * @returns {Promise<{ dataUrl: string, width: number, height: number }>}
 */
export async function renderFirstPage(data, scale = 2) {
    const pdfium = await ensureInit();
    const { docPtr, filePtr } = loadDocument(pdfium, data);

    try {
        const pagePtr = pdfium.FPDF_LoadPage(docPtr, 0);
        if (!pagePtr) throw new Error('Failed to load first page.');

        try {
            const rawWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
            const rawHeight = pdfium.FPDF_GetPageHeightF(pagePtr);

            const width = Math.floor(rawWidth * scale);
            const height = Math.floor(rawHeight * scale);

            // FPDFBitmap format 4 = BGRA
            const bitmapPtr = pdfium.FPDFBitmap_CreateEx(width, height, 4, 0, 0);
            if (!bitmapPtr) throw new Error('Failed to create bitmap.');

            try {
                // Fill with white background (0xFFFFFFFF = white ARGB)
                pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, width, height, 0xFFFFFFFF);

                // Render the page onto the bitmap
                // Flags: 0x01 (FPDF_ANNOT) | 0x10 (FPDF_PRINTING)
                pdfium.FPDF_RenderPageBitmap(bitmapPtr, pagePtr, 0, 0, width, height, 0, 0x11);

                // Get the raw pixel buffer pointer
                const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
                const stride = pdfium.FPDFBitmap_GetStride(bitmapPtr);

                // Read BGRA pixel data from Wasm memory
                const totalBytes = stride * height;
                const bgraData = new Uint8Array(
                    pdfium.pdfium.HEAPU8.buffer,
                    bufferPtr,
                    totalBytes
                );

                // Convert BGRA → RGBA for Canvas
                const rgbaData = new Uint8ClampedArray(width * height * 4);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const srcIdx = y * stride + x * 4;
                        const dstIdx = (y * width + x) * 4;
                        rgbaData[dstIdx + 0] = bgraData[srcIdx + 2]; // R ← B
                        rgbaData[dstIdx + 1] = bgraData[srcIdx + 1]; // G ← G
                        rgbaData[dstIdx + 2] = bgraData[srcIdx + 0]; // B ← R
                        rgbaData[dstIdx + 3] = bgraData[srcIdx + 3]; // A ← A
                    }
                }

                // Draw to an offscreen canvas and export as PNG data URL
                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext('2d');
                const imageData = new ImageData(rgbaData, width, height);
                ctx.putImageData(imageData, 0, 0);

                const blob = await canvas.convertToBlob({ type: 'image/png' });
                const dataUrl = await blobToDataUrl(blob);

                return { dataUrl, width, height };
            } finally {
                pdfium.FPDFBitmap_Destroy(bitmapPtr);
            }
        } finally {
            pdfium.FPDF_ClosePage(pagePtr);
        }
    } finally {
        pdfium.FPDF_CloseDocument(docPtr);
        pdfium.pdfium.wasmExports.free(filePtr);
    }
}

/**
 * Get accurate page count from PDFium.
 *
 * @param {Uint8Array} data — raw PDF bytes
 * @returns {Promise<number>}
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
 * Convert a Blob to a data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
