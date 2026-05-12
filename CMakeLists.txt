cmake_minimum_required(VERSION 3.13)
project(pdf_wasm_poc LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ─── Source ──────────────────────────────────────────────
add_executable(pdf_processor pdf_processor.cpp)

# ─── Emscripten-specific compiler & linker flags ────────
if(EMSCRIPTEN)
    # Compiler flags
    target_compile_options(pdf_processor PRIVATE
        -O2
        -Wall
        -Wextra
    )

    # Linker flags — produce a modular ES6 module
    target_link_options(pdf_processor PRIVATE
        # Embind support
        --bind
        # Allow heap to grow at runtime
        -sALLOW_MEMORY_GROWTH=1
        # Modularize: export a factory function
        -sMODULARIZE=1
        # ES6 module output
        -sEXPORT_ES6=1
        # Module factory name used in JS
        -sEXPORT_NAME=createPdfModule
        # Build environment — web only
        -sENVIRONMENT=web
        # Export HEAPU8 for binary data transfer from JS typed arrays
        -sEXPORTED_RUNTIME_METHODS=['HEAPU8']
        # Output .wasm alongside the JS glue
        -sWASM=1
    )

    # Output filenames
    set_target_properties(pdf_processor PROPERTIES
        OUTPUT_NAME "pdf_processor"
        SUFFIX ".js"
        # Put output directly in project root for easy serving
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}"
    )
else()
    message(FATAL_ERROR
        "This project must be built with Emscripten.\n"
        "Use: emcmake cmake .. && emmake make"
    )
endif()
