# PDF Wasm Analyzer — Proof of Concept

A browser-based PDF file analyzer powered by **C++ compiled to WebAssembly** via [Emscripten](https://emscripten.org). All processing happens 100% client-side — no server uploads required.

## Features

- ✅ Validates PDF magic number (`%PDF`)
- ✅ Extracts PDF version
- ✅ Estimates page count
- ✅ Detects linearization and encryption
- ✅ Reports file size (bytes + human-readable)
- ✅ Returns structured JSON from C++
- ✅ Drag-and-drop file upload
- ✅ Modern dark UI with animations

---

## Prerequisites

- **Git** (optional, for cloning)
- **Python 3** (for the local HTTP server)
- **CMake** ≥ 3.13
- **Emscripten SDK** (emsdk)

---

## Quick Start

### 1. Install & Activate the Emscripten SDK

```bash
# Clone the emsdk repo (skip if you already have it)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Install and activate the latest SDK
./emsdk install latest
./emsdk activate latest

# Set up environment variables for the current terminal session
source ./emsdk_env.sh
```

> **Note:** You need to run `source ./emsdk_env.sh` in every new terminal, or add it to your shell profile.

### 2. Build the Wasm Module

```bash
# Navigate to the project root
cd /path/to/pdf_wasm

# Create a build directory and run CMake with Emscripten
mkdir -p build && cd build
emcmake cmake ..
emmake make -j$(nproc)
```

Or use the convenience **Makefile** from the project root:

```bash
make          # Build
make clean    # Remove build artifacts
make rebuild  # Clean + build
```

After a successful build, you'll see two new files in the project root:
- `pdf_processor.js` — Emscripten JS glue code (ES6 module)
- `pdf_processor.wasm` — Compiled WebAssembly binary

### 3. Start a Local HTTP Server

WebAssembly modules **must** be served over HTTP (not `file://`). Start a simple server:

```bash
# From the project root
python3 -m http.server 8080
```

Or use the Makefile:

```bash
make serve
```

### 4. Open in Browser

Navigate to: **[http://localhost:8080](http://localhost:8080)**

Upload a PDF file and see the analysis results!

---

## Project Structure

```
pdf_wasm/
├── pdf_processor.cpp    # C++ source — PDF analysis + Embind bindings
├── CMakeLists.txt       # CMake build configuration for Emscripten
├── Makefile             # Convenience wrapper for build commands
├── index.html           # Frontend UI (HTML + CSS)
├── app.js               # Frontend logic (JS — Wasm init, file handling, UI)
├── .gitignore           # Ignores build artifacts, OS files, and prompt.md
└── README.md            # This file
```

---

## How It Works

1. **Browser** loads `index.html` → `app.js` initializes the Wasm module via `createPdfModule()`
2. User uploads a PDF via the file input or drag-and-drop
3. `app.js` reads the file as a `Uint8Array`, converts it to a binary string, and calls `wasmModule.processPdfFile(data)`
4. **C++** analyzes the binary buffer:
   - Checks the first 4 bytes against `%PDF` (magic number)
   - Extracts the version string from the header
   - Searches for `/Type /Page` entries to estimate page count
   - Checks for `/Linearized` and `/Encrypt` markers
5. C++ returns a **JSON string** to JavaScript
6. `app.js` parses the JSON and renders the results in the UI

---

## License

MIT — Use freely for learning, prototyping, and production.
