// The preview proxy. It sits between Roadie's preview pane and the running site.
//
// What it changes, and nothing else:
//   1. Framing: removes X-Frame-Options and the frame-ancestors directive, so the
//      site can be shown inside Roadie. The rest of the site's policy is untouched.
//   2. Caching: answers with Cache-Control: no-cache, so an edit shows up at once.
//   3. Roadie's page script: adds one <script src="/__roadie/reload.js"> to HTML
//      pages. It is served from the page's own origin, so a script-src 'self'
//      policy allows it. The script reloads the page when a file changes and,
//      when the owner switches on "Edit on page", reports what they click or
//      type back to Roadie (see preview-page.js). It never edits anything itself.
//
// The site's own files and headers are never edited.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const RELOAD_TAG = '<script src="/__roadie/reload.js"></script>';

const RELOAD_JS = fs.readFileSync(new URL('./preview-page.js', import.meta.url), 'utf8');

// A Cookie header with Roadie's own cookies taken out ('' if nothing is left).
export function withoutRoadieCookies(header) {
  return String(header).split(';').map((c) => c.trim()).filter((c) => c && !/^roadie_session/i.test(c)).join('; ');
}

export function stripFrameAncestors(policy) {
  return String(policy)
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d))
    .join('; ');
}

// Returns a copy of the response headers that allows framing.
export function relaxFraming(headers) {
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') delete out[name];
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      // Node joins repeated headers with ", ": each part is a separate policy.
      const policies = (Array.isArray(out[name]) ? out[name] : String(out[name]).split(','))
        .map(stripFrameAncestors)
        .filter(Boolean);
      if (policies.length) out[name] = policies.join(', ');
      else delete out[name];
    }
  }
  return out;
}

export function injectReload(buf) {
  const text = buf.toString('latin1'); // one char per byte, so indexes line up
  let at = text.search(/<\/head\s*>/i);
  if (at < 0) at = text.search(/<\/body\s*>/i);
  if (at < 0) at = buf.length;
  return Buffer.concat([buf.subarray(0, at), Buffer.from(RELOAD_TAG), buf.subarray(at)]);
}

function downPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>Preview</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1rem;color:#555;text-align:center}</style>
<p>${message}</p>${RELOAD_TAG}`;
}

// getTarget() returns { host, port } for the running site, or null.
export function createPreviewProxy({ getTarget }) {
  const clients = new Set();

  const rightHost = (req) => {
    const port = req.socket.localPort;
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
  };

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    // Only answer when addressed as this machine, so another website cannot
    // point its own name here and read the unpublished site.
    if (!rightHost(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Wrong host');
    }

    if (pathname === '/__roadie/reload.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(RELOAD_JS);
    }
    if (pathname === '/__roadie/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const target = getTarget();
    const down = (message) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(downPage(message));
    };
    if (!target) return down('The site is not running.');

    // Ask for an uncompressed answer so HTML can have the reload tag added.
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    // Roadie's own session cookie is for Roadie, not for the site being previewed.
    if (headers.cookie) {
      const kept = withoutRoadieCookies(headers.cookie);
      if (kept) headers.cookie = kept; else delete headers.cookie;
    }

    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers },
      (ur) => {
        const out = relaxFraming(ur.headers);
        out['cache-control'] = 'no-cache';
        const isHtml = req.method === 'GET' && ur.statusCode !== 304 && !out['content-encoding'] &&
          /text\/html/i.test(String(out['content-type'] || ''));
        if (!isHtml) {
          res.writeHead(ur.statusCode, out);
          return ur.pipe(res);
        }
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const body = injectReload(Buffer.concat(chunks));
          delete out['transfer-encoding'];
          out['content-length'] = body.length;
          res.writeHead(ur.statusCode, out);
          res.end(body);
        });
        ur.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => down('The site is not answering. It may still be starting.'));
    // If the browser goes away (a reload, a closed tab), let go of the site's side too.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  // WebSocket pass-through, for sites whose dev server uses one.
  server.on('upgrade', (req, socket, head) => {
    const target = getTarget();
    if (!target || !rightHost(req)) return socket.destroy();
    const up = net.connect({ host: target.host, port: target.port }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        let value = req.rawHeaders[i + 1];
        if (req.rawHeaders[i].toLowerCase() === 'cookie') {
          value = withoutRoadieCookies(value);
          if (!value) continue;
        }
        lines.push(`${req.rawHeaders[i]}: ${value}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
  ping.unref();

  return {
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    // Tell every open preview page to reload.
    reload() {
      for (const c of clients) c.write('event: reload\ndata: 1\n\n');
    },
    close() {
      clearInterval(ping);
      for (const c of clients) c.destroy();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
