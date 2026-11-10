'use strict';
// What the desktop shell serves: the game's files from the folder inside the app, over its own "tower://app/" address.
// A real address (not file://) so the game's ES modules, fetch() and microphone work exactly as on the web.
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// The file for a URL path, or null when it would leave the folder (../, encoded tricks, absolute paths).
function resolveAppPath(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath || '/').split(/[?#]/)[0]); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const rel = path.posix.normalize(`/${p}`).replace(/^\/+/, '');
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

module.exports = { MIME, mimeFor, resolveAppPath };
