import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

// fetch() will not let a test set Host, so use http.request for those cases.
function raw(port, { method = 'GET', path: p = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function setup(t, gitops = fakeGitOps()) {
  const home = tmpDir(t);
  const app = await createApp({ home, gitops, config: createConfig(home) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Roadie-Token': app.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { app, home, port, base, call, gitops };
}

test('Roadie listens on 127.0.0.1 only', async (t) => {
  const { app, port } = await setup(t);
  assert.ok(port > 0);
  const page = await raw(port, { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(app.token), 'the page carries the per-run token');
});

test('requests for another host name are refused', async (t) => {
  const { app, port } = await setup(t);
  const res = await raw(port, { path: '/api/state', headers: { Host: 'evil.example', 'X-Roadie-Token': app.token } });
  assert.equal(res.status, 403);
});

test('requests from another origin are refused, including the previewed site', async (t) => {
  const { app, base } = await setup(t);
  for (const origin of ['https://evil.example', `http://127.0.0.1:${app.proxyPort}`]) {
    const res = await fetch(base + '/api/preview/start', {
      method: 'POST', headers: { Origin: origin, 'X-Roadie-Token': app.token },
    });
    assert.equal(res.status, 403, origin);
  }
});

test('the API needs the per-run token', async (t) => {
  const { base, call } = await setup(t);
  assert.equal((await fetch(base + '/api/state')).status, 403);
  assert.equal((await fetch(base + '/api/open', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('GET', '/api/state')).status, 200);
});

test('opening a site clones it, detects its commands, runs it and previews it through the proxy', async (t) => {
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, {
      'package.json': { scripts: { test: 'node --test' } },
      'index.html': '<html><head></head><body>the site</body></html>',
    }),
  });
  const { app, home, call } = await setup(t, gitops);

  const bad = await call('POST', '/api/open', { repo: '../etc' });
  assert.equal(bad.status, 400);

  const opened = await call('POST', '/api/open', { repo: 'acme/site' });
  assert.equal(opened.status, 200);
  const site = opened.data.site;
  assert.equal(site.dir, path.join(home, 'sites', 'acme', 'site'));
  assert.equal(site.saved, false);
  assert.equal(site.settings.start, '');
  assert.equal(site.settings.test, 'npm test');

  const saved = await call('POST', '/api/settings', { settings: { ...site.settings, healthPath: '/health' } });
  assert.equal(saved.data.site.saved, true);
  assert.equal(saved.data.site.settings.healthPath, '/health');
  assert.ok(!fs.existsSync(path.join(site.dir, 'config.json')), 'nothing is written into the site');
  assert.ok(fs.existsSync(path.join(home, 'config.json')));

  const started = await call('POST', '/api/preview/start');
  assert.equal(started.data.preview.state, 'running');
  assert.equal(started.data.preview.mode, 'static');
  assert.equal(started.data.preview.url, `http://127.0.0.1:${app.proxyPort}`);

  const page = await (await fetch(started.data.preview.url + '/')).text();
  assert.match(page, /the site/);
  assert.match(page, /__roadie\/reload\.js/);
  const direct = await (await fetch(started.data.preview.directUrl + '/')).text();
  assert.ok(!direct.includes('__roadie'), 'the direct link shows the site untouched');

  const stopped = await call('POST', '/api/preview/stop');
  assert.equal(stopped.data.preview.state, 'stopped');
  assert.equal((await fetch(`http://127.0.0.1:${app.proxyPort}/`)).status, 502);

  // Saved settings come back the next time the site is opened.
  const again = await call('POST', '/api/open', { repo: 'acme/site' });
  assert.equal(again.data.site.saved, true);
  assert.equal(again.data.site.settings.healthPath, '/health');
});
