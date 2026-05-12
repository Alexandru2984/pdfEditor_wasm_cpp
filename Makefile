# ─────────────────────────────────────────────────────────
#  Makefile — Convenience wrapper around CMake + Emscripten
# ─────────────────────────────────────────────────────────

BUILD_DIR  := build
SOURCE_DIR := .

.PHONY: all clean rebuild serve help

## Build the Wasm module (default target)
all: $(BUILD_DIR)/Makefile
	@echo "══════════════════════════════════════════════"
	@echo "  Building pdf_processor.wasm …"
	@echo "══════════════════════════════════════════════"
	cd $(BUILD_DIR) && emmake make -j$$(nproc)
	@echo ""
	@echo "✓ Build complete. Output files:"
	@ls -lh pdf_processor.js pdf_processor.wasm 2>/dev/null || true

$(BUILD_DIR)/Makefile:
	@mkdir -p $(BUILD_DIR)
	cd $(BUILD_DIR) && emcmake cmake $(CURDIR)

## Remove all build artifacts
clean:
	@echo "Removing build directory and generated files…"
	rm -rf $(BUILD_DIR)
	rm -f pdf_processor.js pdf_processor.wasm
	@echo "✓ Clean."

## Full rebuild from scratch
rebuild: clean all

## Start a local HTTP server for testing
serve:
	@echo "══════════════════════════════════════════════"
	@echo "  Serving at http://localhost:8080"
	@echo "  Press Ctrl+C to stop."
	@echo "══════════════════════════════════════════════"
	python3 -m http.server 8080

## Show available targets
help:
	@echo "Available targets:"
	@echo "  make          — Build the Wasm module"
	@echo "  make clean    — Remove build artifacts"
	@echo "  make rebuild  — Clean + build"
	@echo "  make serve    — Start local HTTP server on :8080"
	@echo "  make help     — Show this message"
