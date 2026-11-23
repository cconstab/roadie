import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createPreviewProxy, injectReload, relaxFraming, stripFrameAncestors } from '../src/proxy.js';

const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'";

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A site that refuses to be framed, like many real ones.
async function setup(t) {
  const seen = [];
  const site = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const security = { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' };
      if (req.url === '/style.css') {
        res.writeHead(200, { ...security, 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=300' });
        return res.end('body { color: red }');
      }
      if (req.method === 'POST') {
        res.writeHead(201, { ...security, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ got: body }));
      }
      res.writeHead(200, { ...security, 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>t</title></head><body>héllo</body></html>');
    });
  });
  const sitePort = await listen(site);
  let target = { host: '127.0.0.1', port: sitePort };
  const proxy = createPreviewProxy({ getTarget: () => target });
  const port = await proxy.listen(0);
  t.after(async () => { await proxy.close(); site.closeAllConnections(); site.close(); });
  return { base: `http://127.0.0.1:${port}`, port, seen, proxy, setTarget: (v) => { target = v; } };
}

test('stripFrameAncestors removes only that directive', () => {
  assert.equal(stripFrameAncestors(CSP), "default-src 'self'; script-src 'self'; object-src 'none'");
  assert.equal(stripFrameAncestors("frame-ancestors 'none'"), '');
  assert.equal(stripFrameAncestors("FRAME-ANCESTORS https://a.example; img-src *"), 'img-src *');
  assert.equal(stripFrameAncestors("frame-src 'self'"), "frame-src 'self'");
});

test('relaxFraming drops X-Frame-Options and keeps every other header', () => {
  const out = relaxFraming({
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': `${CSP}, frame-ancestors 'self'; img-src 'self'`,
    'content-security-policy-report-only': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=1',
  });
  assert.deepEqual(out, {
    'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none', img-src 'self'",
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=1',
  });
});

test('injectReload adds the script before </head>, or at the end', () => {
  const tag = '<script src="/__roadie/reload.js"></script>';
  assert.equal(injectReload(Buffer.from('<head></head><body></body>')).toString(), `<head>${tag}</head><body></body>`);
  assert.equal(injectReload(Buffer.from('<body>x</body>')).toString(), `<body>x${tag}</body>`);
  assert.equal(injectReload(Buffer.from('plain')).toString(), `plain${tag}`);
});

test('an HTML page comes through framable, with its policy otherwise intact', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; object-src 'none'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(text, /<script src="\/__roadie\/reload\.js"><\/script><\/head>/);
  assert.match(text, /héllo/);
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(text));
});

test('other files pass through unchanged, but are never cached', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/style.css');
  assert.equal(await res.text(), 'body { color: red }');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('x-frame-options'), null);
});

test('the Host header and request body reach the site as the browser sent them', async (t) => {
  const { base, port, seen } = await setup(t);
  const res = await fetch(base + '/api/posts?x=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: '{"a":1}',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { got: '{"a":1}' });
  const hit = seen.at(-1);
  assert.equal(hit.url, '/api/posts?x=1');
  assert.equal(hit.headers.host, `127.0.0.1:${port}`);
  assert.equal(hit.headers.origin, base);
  assert.equal(hit.headers['accept-encoding'], undefined);
});

test('the reload script is served from the page\'s own origin', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/__roadie/reload.js');
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /EventSource\('\/__roadie\/events'\)/);
});

test('reload() reaches pages that are listening', async (t) => {
  const { base, proxy } = await setup(t);
  const controller = new AbortController();
  const res = await fetch(base + '/__roadie/events', { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read(); // the retry line
  proxy.reload();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /event: reload/);
  controller.abort();
});

test('when the site is down the preview says so and can still reload itself', async (t) => {
  const { base, setTarget } = await setup(t);
  setTarget(null);
  const stopped = await fetch(base + '/');
  assert.equal(stopped.status, 502);
  const text = await stopped.text();
  assert.match(text, /not running/);
  assert.match(text, /__roadie\/reload\.js/);

  setTarget({ host: '127.0.0.1', port: 1 }); // nothing listens there
  const refused = await fetch(base + '/');
  assert.equal(refused.status, 502);
  assert.match(await refused.text(), /not answering/);
});

test("Roadie's own cookies never reach the site, on ordinary requests or WebSocket ones", async (t) => {
  const { withoutRoadieCookies } = await import('../src/proxy.js');
  assert.equal(withoutRoadieCookies('roadie_session_4747=secret'), '');
  assert.equal(withoutRoadieCookies('theme=dark; roadie_session_4747=secret; cart=3'), 'theme=dark; cart=3');
  assert.equal(withoutRoadieCookies('roadie_session=old-style; a=1'), 'a=1');

  const { base, port, seen } = await setup(t);
  await fetch(base + '/', { headers: { Cookie: 'theme=dark; roadie_session_4747=secret' } });
  assert.equal(seen.at(-1).headers.cookie, 'theme=dark', "the site's own cookies still get through");
  await fetch(base + '/', { headers: { Cookie: 'roadie_session_4747=secret' } });
  assert.equal(seen.at(-1).headers.cookie, undefined);

  // A WebSocket upgrade (what a dev server's live-reload uses) goes through a different path.
  const net = await import('node:net');
  const upstreamSaw = await new Promise((resolve, reject) => {
    const upstream = net.createServer((sock) => sock.once('data', (d) => { resolve(d.toString()); sock.destroy(); }));
    upstream.listen(0, '127.0.0.1', async () => {
      const proxyMod = await import('../src/proxy.js');
      const p = proxyMod.createPreviewProxy({ getTarget: () => ({ host: '127.0.0.1', port: upstream.address().port }) });
      const pp = await p.listen(0);
      t.after(async () => { await p.close(); upstream.close(); });
      const client = net.connect(pp, '127.0.0.1', () => {
        client.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${pp}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: roadie_session_4747=secret; theme=dark\r\nSec-WebSocket-Key: x\r\n\r\n`);
      });
      client.on('error', reject);
      t.after(() => client.destroy());
    });
  });
  assert.match(upstreamSaw, /^GET \/hmr HTTP\/1\.1/);
  assert.match(upstreamSaw, /Cookie: theme=dark\r\n/);
  assert.doesNotMatch(upstreamSaw, /roadie_session|secret/);
  assert.ok(port > 0);
});
