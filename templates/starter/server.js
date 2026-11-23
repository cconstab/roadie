#!/usr/bin/env node
/* {{TITLE}}: a small web server with no dependencies.

   node server.js            -> http://localhost:8080
   PORT=3000 node server.js

   Env:
     PORT         port to listen on (default 8080)
     HOST         interface to bind (default 127.0.0.1; the Docker image sets 0.0.0.0)
     APP_VERSION  which build this is, reported by /api/health (set by CI)
*/
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PUBLIC = path.join(__dirname, 'public'); // only files in here are ever served
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = process.env.APP_VERSION || 'dev';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

async function notFound(res) {
  try {
    const page = await fsp.readFile(path.join(PUBLIC, '404.html'));
    send(res, 404, page, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

async function serveFile(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return notFound(res); }
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return notFound(res); // no dotfiles, no ".."
  let file = path.join(PUBLIC, ...parts);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return notFound(res);

  let stat = await fsp.stat(file).catch(() => null);
  if (stat && stat.isDirectory()) { file = path.join(file, 'index.html'); stat = await fsp.stat(file).catch(() => null); }
  if (!stat && !path.extname(file)) { file += '.html'; stat = await fsp.stat(file).catch(() => null); } // /about -> about.html
  if (!stat || !stat.isFile()) return notFound(res);

  const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=300, must-revalidate',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, null, headers);
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      // Which build is live. The deploy checks use this.
      if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION });
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'no such route' });
      await serveFile(req, res, url.pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => console.log(`{{TITLE}} is running at http://localhost:${PORT}`));
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
