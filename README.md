# PDF Wasm Analyzer — Hybrid Architecture

A browser-based PDF analyzer powered by **C++ WebAssembly** (custom metadata scanner) + **Google PDFium** (text extraction & page rendering), with a **Django REST** backend for logging processing jobs.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  BROWSER (Client-Side)                              │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ pdf_processor │  │ @embedpdf/pdfium (Wasm)      │ │
│  │ .cpp → .wasm  │  │ Text extraction, rendering   │ │
│  │ (Custom C++)  │  │ (Pre-built PDFium binary)    │ │
│  └──────┬───────┘  └──────────┬───────────────────┘ │
│         │                     │                     │
│  ┌──────▼─────────────────────▼───────────────────┐ │
│  │  app.js — JavaScript Bridge                     │ │
│  │  • Calls both Wasm modules                      │ │
│  │  • Renders split-pane UI                        │ │
│  │  • POST results to Django via fetch()           │ │
│  └───────────────────┬─────────────────────────────┘ │
└──────────────────────┼──────────────────────────────┘
                       │  HTTP POST /api/save-pdf-job/
                       │  Authorization: Bearer <token>
┌──────────────────────▼──────────────────────────────┐
│  DJANGO SERVER (Backend)                            │
│                                                     │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │ .env        │  │ views.py    │  │ models.py    │ │
│  │ (SECRETS)   │  │ (DRF API)   │  │ (SQLite/PG)  │ │
│  │ SECRET_KEY  │  │ Auth + Save  │  │ ProcessedPDF │ │
│  │ DB creds    │  │             │  │ Job          │ │
│  └────────────┘  └─────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites
- **Emscripten SDK** (for building the custom C++ analyzer)
- **Node.js** ≥ 16 (for npm/PDFium package)
- **Python** ≥ 3.10 (for Django backend)

### 1. Build the C++ Analyzer (one-time)
```bash
source /path/to/emsdk/emsdk_env.sh
mkdir -p build && cd build
emcmake cmake ..
emmake make
cp pdf_processor.js pdf_processor.wasm ..
cd ..
```

### 2. Install Frontend Dependencies
```bash
npm install                          # Installs @embedpdf/pdfium
cp node_modules/@embedpdf/pdfium/dist/pdfium.wasm .  # Copy Wasm binary
```

### 3. Setup Django Backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                 # Edit with your secrets
python manage.py migrate
python manage.py createsuperuser     # Optional — for admin panel
```

### 4. Run Both Servers
```bash
# Terminal 1: Frontend (from project root)
python3 -m http.server 8080

# Terminal 2: Backend (from backend/)
source venv/bin/activate
python manage.py runserver 8000
```

Open **http://localhost:8080** in your browser.

## Features

### Frontend (Browser)
- **Multi-file upload** with drag & drop
- **C++ Metadata Analysis** — PDF version, magic bytes, page count (heuristic), linearization, encryption
- **PDF Toolkit (via PDFium)**:
  - 🔀 **Merge PDFs** — Combine multiple PDFs into one
  - ✂️ **Split PDF** — Extract specific page ranges into new files
  - 🗑️ **Delete Pages** — Remove specific pages from a PDF
  - 🔄 **Rotate Pages** — Rotate pages by 90°, 180°, 270°
  - 🔲 **Crop Pages** — Set custom crop box dimensions
  - 📝 **Extract Text** — Extract native text from PDF layers
  - 🖼 **Render Pages** — Generate high-quality PNG thumbnails for all pages
- **OCR (Optical Character Recognition)** — Powered by `tesseract.js` (extracts text from scanned images/pages via WebAssembly)
- **Sidebar** — document list with selection, deletion, clear all
- **localStorage** — analysis history persists across sessions

### Backend (Django)
- **REST API** at `/api/save-pdf-job/` — logs processing transactions
- **Bearer token auth** — simple for PoC, swap to JWT/OAuth2 for production
- **Admin panel** at `/admin/` — view all logged jobs
- **`.env` security** — all secrets isolated on the server

## Security: Why `.env` NEVER Reaches the Frontend

1. **Browser sandbox** — WebAssembly runs in a browser sandbox. It has *zero* access to server-side files. It cannot call `fopen()`, `getenv()`, or any OS syscall.
2. **`SECRET_KEY`** — if leaked, an attacker can forge Django session cookies and hijack any user session.
3. **`DATABASE_URL`** — if leaked, direct database access is possible (read/write/delete all data).
4. **Architecture is intentional** — secrets live ONLY on the Django server. The frontend sends processed PDF metadata TO the server over HTTP. The server decides what to accept and store.
5. **The `.env` file is not served** — `python3 -m http.server` serves from the project root, but `.env` lives in `backend/`, which is a separate directory. Even if it were accessible, `.gitignore` prevents it from being committed.

## API Reference

### POST `/api/save-pdf-job/`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <token>
```

**Body:**
```json
{
  "filename": "report.pdf",
  "file_size": 245760,
  "pdf_version": "1.7",
  "page_count": 12,
  "operation_type": "full_analysis",
  "text_preview": "First 500 chars of extracted text...",
  "status": "completed"
}
```

**Response (201 Created):**
```json
{
  "message": "Job saved successfully.",
  "job": {
    "id": 1,
    "user_identifier": "token-user:dev-toke...",
    "filename": "report.pdf",
    "file_size": 245760,
    "pdf_version": "1.7",
    "page_count": 12,
    "operation_type": "full_analysis",
    "text_preview": "...",
    "status": "completed",
    "created_at": "2026-05-12T21:00:00Z",
    "updated_at": "2026-05-12T21:00:00Z"
  }
}
```

## PDFium Integration Approach

Instead of compiling PDFium from source with Emscripten (notoriously difficult and slow), this project uses **`@embedpdf/pdfium`** (v2.14.2) — an npm package that ships PDFium pre-compiled to WebAssembly with JavaScript bindings.

The `pdfium_worker.js` module:
1. Fetches `pdfium.wasm` (4.5MB) and initializes the module once (singleton)
2. Allocates memory via `malloc`, copies PDF bytes into Wasm heap
3. Calls PDFium C API functions (`FPDF_LoadMemDocument`, `FPDFText_LoadPage`, etc.)
4. Cleans up with `FPDF_CloseDocument` / `free` in `finally` blocks

Our custom `pdf_processor.cpp` coexists alongside PDFium — it handles fast metadata scanning, while PDFium handles the heavy operations (text extraction, page rendering).
