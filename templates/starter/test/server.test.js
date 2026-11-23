'use strict';
// Run: npm test   (node --test, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

let base;
let server;
test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('serves the home page with security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /<h1>/);
});

test('serves the stylesheet', async () => {
  const res = await fetch(base + '/css/styles.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('health reports the build version', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: process.env.APP_VERSION || 'dev' });
});

test('unknown pages get the 404 page', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Page not found/);
});

test('server source, dotfiles and paths outside public are never served', async () => {
  for (const p of ['/server.js', '/package.json', '/.env', '/.git/config', '/..%2fserver.js', '/%2e%2e/server.js', '/test/server.test.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /createServer|"scripts"/, p);
  }
});

test('only GET and HEAD are allowed', async () => {
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
