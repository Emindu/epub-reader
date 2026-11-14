// Production server: serves the built app from ../dist and the article
// importer endpoint. No dependencies beyond Node's standard library.
//
//   npm run build && npm start        (PORT defaults to 8080)

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { articleMiddleware } from './article-proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');
const port = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  let file = path.join(distDir, pathname);
  // Refuse anything that escapes dist/ (path traversal).
  if (!file.startsWith(distDir + path.sep) && file !== distDir) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // Single-page app: unknown paths fall back to the shell.
    file = path.join(distDir, 'index.html');
  }

  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // Hashed build assets can be cached forever; the shell must revalidate.
  res.setHeader(
    'Cache-Control',
    file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
  createReadStream(file)
    .on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); })
    .pipe(res);
}

const server = http.createServer((req, res) => {
  articleMiddleware(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end('Method not allowed');
    }
    serveStatic(req, res);
  });
});

server.listen(port, () => {
  console.log(`Read web app running at http://localhost:${port}`);
});
