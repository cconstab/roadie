// Built-in static file server, used when a site has no start command.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
};

export function createStaticServer(root) {
  const base = fs.realpathSync(root);

  return http.createServer((req, res) => {
    const notFound = () => {
      fs.readFile(path.join(base, '404.html'), (err, buf) => {
        res.writeHead(404, { 'Content-Type': err ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(err ? 'Not found' : buf);
      });
    };
    // Only answer when addressed as this machine, so another website cannot
    // point its own name here and read the unpublished site. (Any port: the
    // preview proxy passes on the address the browser used for the proxy.)
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(String(req.headers.host))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Wrong host');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { return notFound(); }
    const parts = rel.split('/').filter(Boolean);
    // No dotfiles (.git, .env) and no stepping out of the folder.
    if (parts.some((p) => p.startsWith('.'))) return notFound();
    let file = path.join(base, ...parts);
    if (file !== base && !file.startsWith(base + path.sep)) return notFound();

    fs.stat(file, (err, stat) => {
      if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
      else if (err && !path.extname(file)) file += '.html';
      fs.realpath(file, (err2, real) => {
        if (err2 || (real !== base && !real.startsWith(base + path.sep))) return notFound();
        fs.stat(real, (err3, st) => {
          if (err3 || !st.isFile()) return notFound();
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': 'no-cache',
          });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
        });
      });
    });
  });
}
