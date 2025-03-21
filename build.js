const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Ensure the extension/pkg directory exists
const pkgDir = path.join(__dirname, 'extension', 'pkg');
if (!fs.existsSync(pkgDir)) {
  fs.mkdirSync(pkgDir, { recursive: true });
}

// Build the Rust WebAssembly module
console.log('Building Rust WebAssembly module...');
try {
  execSync('wasm-pack build --target web --out-dir extension/pkg', { stdio: 'inherit' });
  console.log('WebAssembly build completed successfully!');
} catch (error) {
  console.error('Error building WebAssembly module:', error);
  process.exit(1);
}

console.log('Build completed successfully!');
