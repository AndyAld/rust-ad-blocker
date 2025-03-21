# Rust-Powered Ad Blocker Extension

 A browser extension that uses WebAssembly and Rust to efficiently block unwanted ads and trackers.

 ## Features

 - High-performance ad blocking using Rust compiled to WebAssembly
 - Multiple rule types support (direct matches, regex patterns, domain rules)
 - Easy rule management through JSON configuration
 - Minimal browser performance impact

 ## Architecture

 This extension uses a hybrid approach:
 - **Core Logic**: Written in Rust and compiled to WebAssembly for optimal performance
 - **Browser Integration**: JavaScript handles browser API interactions and UI
 - **Rule Processing**: The Rust component efficiently processes URLs against blocking rules

 ## Development

 ### Prerequisites

 - Rust toolchain with wasm32 target
 - wasm-pack
 - Node.js and npm

 ### Building

 1. Compile the Rust code to WebAssembly:
```wasm-pack build --target web```

 2. Build the extension:
```npm run build```

### Loading the Extension

 1. Open your browser's extension page
 2. Enable developer mode
 3. Click "Load unpacked" and select the extension directory

