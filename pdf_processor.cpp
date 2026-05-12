/**
 * pdf_processor.cpp
 *
 * A minimal PDF file analyzer compiled to WebAssembly via Emscripten.
 * Uses Embind to expose C++ functions to JavaScript.
 *
 * Functionality:
 *   - Accepts a binary buffer (PDF file bytes) from JavaScript via typed array
 *   - Validates the PDF magic number (%PDF)
 *   - Extracts basic metadata (size, version hint, page count)
 *   - Returns a JSON string with the analysis results
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <sstream>
#include <cstdint>
#include <vector>
#include <algorithm>
#include <cctype>
#include <cstring>

namespace pdf {

/**
 * Escape a string for safe JSON embedding.
 * Handles quotes, backslashes, and control characters.
 */
static std::string jsonEscape(const std::string& input) {
    std::string output;
    output.reserve(input.size() + 16);
    for (char c : input) {
        switch (c) {
            case '"':  output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\n': output += "\\n";  break;
            case '\r': output += "\\r";  break;
            case '\t': output += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned int>(c));
                    output += buf;
                } else {
                    output += c;
                }
        }
    }
    return output;
}

/**
 * Try to extract the PDF version string from the header.
 * A valid PDF starts with "%PDF-X.Y" where X.Y is the version.
 * Returns the version string (e.g., "1.7") or "unknown".
 */
static std::string extractPdfVersion(const uint8_t* data, size_t len) {
    // Minimum header: %PDF-X.Y = 8 bytes
    if (len < 8) return "unknown";

    // Look for "%PDF-" prefix
    if (memcmp(data, "%PDF-", 5) != 0) return "unknown";

    // Extract version: scan forward from position 5 until we hit
    // a character that isn't a digit or period
    std::string version;
    for (size_t i = 5; i < std::min(len, static_cast<size_t>(12)); ++i) {
        char c = static_cast<char>(data[i]);
        if (std::isdigit(static_cast<unsigned char>(c)) || c == '.') {
            version += c;
        } else {
            break;
        }
    }

    return version.empty() ? "unknown" : version;
}

/**
 * Helper: check if a byte is PDF whitespace.
 * PDF spec defines whitespace as: 0x00, 0x09, 0x0A, 0x0D, 0x0C, 0x20
 */
static inline bool isPdfWhitespace(uint8_t b) {
    return b == 0x00 || b == 0x09 || b == 0x0A ||
           b == 0x0D || b == 0x0C || b == 0x20;
}

/**
 * Find a byte sequence needle in a buffer (like memmem but portable).
 */
static const uint8_t* findBytes(const uint8_t* haystack, size_t haystackLen,
                                 const uint8_t* needle, size_t needleLen) {
    if (needleLen > haystackLen) return nullptr;
    const uint8_t* end = haystack + haystackLen - needleLen + 1;
    for (const uint8_t* p = haystack; p < end; ++p) {
        if (memcmp(p, needle, needleLen) == 0) {
            return p;
        }
    }
    return nullptr;
}

/**
 * Count pages by searching for "/Type" followed by whitespace then "/Page"
 * while excluding "/Type ... /Pages" (the page tree root).
 *
 * This handles multiple whitespace variations found in real-world PDFs:
 *   /Type /Page       (single space)
 *   /Type  /Page      (multiple spaces)
 *   /Type\n/Page      (newline)
 *   /Type\r\n/Page    (CRLF)
 *
 * Also handles the compact form: /Type/Page (no whitespace — valid per PDF spec).
 *
 * Additional heuristic: if no /Type /Page markers found, try to parse /Count
 * from the /Pages dictionary which gives the total page count directly.
 */
static int estimatePageCount(const uint8_t* data, size_t len) {
    int count = 0;
    const uint8_t typeTag[] = "/Type";
    const size_t typeTagLen = 5;
    const uint8_t pageTag[] = "/Page";
    const size_t pageTagLen = 5;

    size_t pos = 0;
    while (pos + typeTagLen < len) {
        // Find next "/Type"
        const uint8_t* found = findBytes(data + pos, len - pos, typeTag, typeTagLen);
        if (!found) break;

        size_t foundPos = static_cast<size_t>(found - data);
        size_t cursor = foundPos + typeTagLen;

        // Skip optional whitespace between /Type and the value
        while (cursor < len && isPdfWhitespace(data[cursor])) {
            ++cursor;
        }

        // Check if next token is "/Page"
        if (cursor + pageTagLen <= len &&
            memcmp(data + cursor, pageTag, pageTagLen) == 0) {
            // Now check: is this "/Pages" (with 's' after) or "/Page" (leaf)?
            size_t afterPage = cursor + pageTagLen;
            if (afterPage < len && data[afterPage] == 's') {
                // It's /Pages — skip (this is the page tree node, not an actual page)
                pos = afterPage + 1;
            } else {
                // It's /Page (a leaf page object) — count it
                ++count;
                pos = afterPage;
            }
        } else {
            pos = cursor;
        }
    }

    // Fallback: if no /Type /Page found, try parsing /Count from /Pages dict
    if (count == 0) {
        const uint8_t countTag[] = "/Count ";
        const size_t countTagLen = 7;
        const uint8_t pagesType[] = "/Type /Pages";
        const size_t pagesTypeLen = 12;

        // Find /Type /Pages first
        const uint8_t* pagesObj = findBytes(data, len, pagesType, pagesTypeLen);
        if (!pagesObj) {
            // Try without space
            const uint8_t pagesType2[] = "/Type/Pages";
            pagesObj = findBytes(data, len, pagesType2, 11);
        }

        if (pagesObj) {
            // Look for /Count in the vicinity (within 512 bytes)
            size_t searchStart = static_cast<size_t>(pagesObj - data);
            size_t searchEnd = std::min(len, searchStart + 512);
            const uint8_t* countPtr = findBytes(data + searchStart,
                                                 searchEnd - searchStart,
                                                 countTag, countTagLen);
            if (countPtr) {
                size_t numStart = static_cast<size_t>(countPtr - data) + countTagLen;
                // Skip whitespace
                while (numStart < len && isPdfWhitespace(data[numStart])) {
                    ++numStart;
                }
                // Parse integer
                int val = 0;
                while (numStart < len && data[numStart] >= '0' && data[numStart] <= '9') {
                    val = val * 10 + (data[numStart] - '0');
                    ++numStart;
                }
                if (val > 0) count = val;
            }
        }
    }

    return count;
}

/**
 * Check if the PDF is linearized (optimized for fast web viewing).
 * Linearized PDFs contain a "/Linearized" entry near the start.
 */
static bool isLinearized(const uint8_t* data, size_t len) {
    size_t searchLen = std::min(len, static_cast<size_t>(4096));
    const uint8_t tag[] = "/Linearized";
    return findBytes(data, searchLen, tag, 11) != nullptr;
}

/**
 * Check for encryption by looking for /Encrypt dictionary reference.
 */
static bool hasEncryption(const uint8_t* data, size_t len) {
    const uint8_t tag[] = "/Encrypt";
    return findBytes(data, len, tag, 8) != nullptr;
}

/**
 * Main entry point: analyze a PDF binary buffer.
 *
 * Accepts a JS Uint8Array via emscripten::val, copies the data into
 * a C++ vector, and processes it. This avoids the UTF-8 encoding
 * corruption that happens with std::string Embind bindings.
 *
 * @param jsArray  A JS Uint8Array containing the raw PDF bytes.
 * @return         A JSON string containing the analysis results.
 */
std::string processPdfFile(const emscripten::val& jsArray) {
    // Get length from the JS typed array
    const size_t fileSize = jsArray["length"].as<size_t>();

    // Copy JS Uint8Array data into a C++ vector
    // Use the Emscripten memory view to avoid UTF-8 corruption
    std::vector<uint8_t> buffer(fileSize);
    if (fileSize > 0) {
        emscripten::val memoryView = emscripten::val::global("Uint8Array")
            .new_(emscripten::val::module_property("HEAPU8")["buffer"],
                  reinterpret_cast<uintptr_t>(buffer.data()),
                  fileSize);
        memoryView.call<void>("set", jsArray);
    }

    const uint8_t* data = buffer.data();
    std::ostringstream json;

    // --- Validate magic number ---
    bool isValidPdf = false;
    std::string magicBytesHex;

    if (fileSize >= 4) {
        // PDF magic: 0x25 0x50 0x44 0x46 == "%PDF"
        isValidPdf = (data[0] == 0x25 && data[1] == 0x50 &&
                      data[2] == 0x44 && data[3] == 0x46);

        char hexBuf[32];
        snprintf(hexBuf, sizeof(hexBuf), "0x%02X 0x%02X 0x%02X 0x%02X",
                 data[0], data[1], data[2], data[3]);
        magicBytesHex = hexBuf;
    } else {
        magicBytesHex = "insufficient data";
    }

    // --- Extract metadata ---
    std::string version = isValidPdf ? extractPdfVersion(data, fileSize) : "N/A";
    int estimatedPages  = isValidPdf ? estimatePageCount(data, fileSize) : 0;
    bool linearized     = isValidPdf ? isLinearized(data, fileSize) : false;
    bool encrypted      = isValidPdf ? hasEncryption(data, fileSize) : false;

    // --- Build JSON response ---
    json << "{\n";
    json << "  \"success\": "       << (isValidPdf ? "true" : "false") << ",\n";
    json << "  \"message\": \""     << jsonEscape(isValidPdf
                                        ? "Valid PDF file detected and analyzed successfully."
                                        : "Invalid file: PDF magic number (%PDF) not found.")
                                    << "\",\n";
    json << "  \"fileSize\": "      << fileSize << ",\n";
    json << "  \"fileSizeHuman\": \"";

    // Human-readable file size
    if (fileSize < 1024) {
        json << fileSize << " B";
    } else if (fileSize < 1024 * 1024) {
        json << std::fixed;
        json.precision(2);
        json << (static_cast<double>(fileSize) / 1024.0) << " KB";
    } else {
        json << std::fixed;
        json.precision(2);
        json << (static_cast<double>(fileSize) / (1024.0 * 1024.0)) << " MB";
    }
    json << "\",\n";

    json << "  \"magicBytes\": \""  << jsonEscape(magicBytesHex) << "\",\n";
    json << "  \"pdfVersion\": \""  << jsonEscape(version) << "\",\n";
    json << "  \"estimatedPages\": " << estimatedPages << ",\n";
    json << "  \"linearized\": "    << (linearized ? "true" : "false") << ",\n";
    json << "  \"encrypted\": "     << (encrypted ? "true" : "false") << "\n";
    json << "}";

    return json.str();
}

} // namespace pdf

// --- Embind bindings ---
EMSCRIPTEN_BINDINGS(pdf_processor_module) {
    emscripten::function("processPdfFile", &pdf::processPdfFile);
}
