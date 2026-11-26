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
      headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { app, home, port, base, call, gitops };
}

test('the page, and the token in it, is only given to the browser that came with the launch link', async (t) => {
  const { app, port, base } = await setup(t);
  const host = { Host: `127.0.0.1:${port}` };

  // Anything else on this machine that asks for the page gets no token.
  const stranger = await raw(port, { headers: host });
  assert.equal(stranger.status, 403);
  assert.ok(!stranger.body.includes(app.token));
  assert.match(stranger.body, /link it prints in the terminal/);
  for (const p of ['/app.js', '/api/state', '/api/events']) {
    const res = await raw(port, { path: p, headers: { ...host, 'X-Roadie-Token': app.token } });
    assert.equal(res.status, 403, p);
  }

  // A wrong key earns nothing.
  const wrong = await fetch(`${base}/?key=not-the-key`, { redirect: 'manual' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.get('set-cookie'), null);

  // The launch link sets a cookie the page's own scripts cannot read, and moves on.
  const launch = await fetch(`${base}/?key=${app.launchKey}`, { redirect: 'manual' });
  assert.equal(launch.status, 302);
  assert.equal(launch.headers.get('location'), '/');
  const cookie = launch.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.split(';')[0], app.cookie);
  assert.ok(!cookie.includes(app.token), 'the cookie is its own secret, not the API token');
  assert.ok(cookie.startsWith(`roadie_session_${port}=`), 'named for this port, so a second Roadie does not replace it');

  const page = await raw(port, { headers: { ...host, Cookie: app.cookie } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(app.token), 'the page carries the per-run token');
});

test('Roadie and its preview proxy listen on 127.0.0.1 only and answer only as this machine', async (t) => {
  const { app, port } = await setup(t);
  assert.equal(app.address().address, '127.0.0.1');
  const proxied = await raw(app.proxyPort, { headers: { Host: 'evil.example' } });
  assert.equal(proxied.status, 403, 'another site cannot point its name at the preview');
  const fine = await raw(app.proxyPort, { headers: { Host: `127.0.0.1:${app.proxyPort}` } });
  assert.equal(fine.status, 502, 'addressed properly, it answers (no site is running yet)');
  assert.ok(port > 0);
});

test('requests for another host name are refused', async (t) => {
  const { app, port } = await setup(t);
  const res = await raw(port, { path: '/api/state', headers: { Host: 'evil.example', 'X-Roadie-Token': app.token, Cookie: app.cookie } });
  assert.equal(res.status, 403);
});

test('requests from another origin are refused, including the previewed site', async (t) => {
  const { app, base } = await setup(t);
  for (const origin of ['https://evil.example', `http://127.0.0.1:${app.proxyPort}`]) {
    const res = await fetch(base + '/api/preview/start', {
      method: 'POST', headers: { Origin: origin, 'X-Roadie-Token': app.token, Cookie: app.cookie },
    });
    assert.equal(res.status, 403, origin);
  }
});

test('the API needs the per-run token', async (t) => {
  const { app, base, call } = await setup(t);
  assert.equal((await fetch(base + '/api/state')).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: app.cookie } })).status, 403, 'the cookie alone is not enough');
  assert.equal((await fetch(base + '/api/open', { method: 'POST', body: '{}', headers: { Cookie: app.cookie } })).status, 403);
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

test('chat and changed files work through the API, with secrets kept out of view', async (t) => {
  const { z } = await import('zod');
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, { 'index.html': '<h1>hi</h1>' }),
    changes: [
      { path: 'index.html', from: null, status: 'modified', diff: '@@ -1 +1 @@\n-<h1>hi</h1>\n+<h1>yo</h1>\n' },
      { path: '.env', from: null, status: 'added', diff: '@@ -0,0 +1 @@\n+ADMIN_TOKEN=hunter2\n' },
    ],
  });
  const queries = [];
  const sdk = {
    tool: (name, d, s, handler) => ({ name, handler }),
    createSdkMcpServer: (o) => o,
    query({ prompt, options }) {
      queries.push(options);
      const it = (async function* () {
        for await (const turn of prompt) {
          yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `You said: ${turn.message.content}` }] } };
          yield { type: 'result', subtype: 'success' };
        }
      })();
      it.interrupt = async () => {};
      it.close = () => {};
      return it;
    },
  };
  const home = tmpDir(t);
  const app = await createApp({ home, gitops, config: createConfig(home), agentSdk: async () => ({ sdk, z }) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  assert.equal((await call('POST', '/api/chat/send', { text: 'hi' })).status, 400, 'no site open yet');
  await call('POST', '/api/open', { repo: 'acme/site' });

  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved) process.env.ANTHROPIC_API_KEY = saved; else delete process.env.ANTHROPIC_API_KEY; });
  const noKey = await call('POST', '/api/chat/send', { text: 'hi' });
  assert.equal(noKey.status, 400);
  assert.match(noKey.data.error, /ANTHROPIC_API_KEY/);
  assert.equal(queries.length, 0, 'the SDK is never started without a key');

  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  assert.equal((await call('POST', '/api/chat/send', { text: 'make it pop' })).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  const state = (await call('GET', '/api/state')).data;
  assert.deepEqual(state.chat.items.map((i) => [i.role, i.text]), [['user', 'make it pop'], ['assistant', 'You said: make it pop']]);
  assert.equal(state.chat.busy, false);
  assert.equal(queries[0].cwd, path.join(home, 'sites', 'acme', 'site'));

  const { files } = (await call('GET', '/api/changes')).data;
  assert.match(files[0].diff, /<h1>yo<\/h1>/);
  assert.equal(files[1].diff, '');
  assert.match(files[1].hidden, /secrets file/);
  assert.ok(!JSON.stringify(files).includes('hunter2'));

  // Changing the AI keeps what was said on screen (the new AI is told the gist with
  // the next message); no key is ever written to disk.
  const switched = await call('POST', '/api/ai', { ai: { provider: 'ollama', ollamaModel: 'local-model' } });
  assert.equal(switched.data.ai.status.ready, true);
  assert.deepEqual(switched.data.chat.items.map((i) => i.text), ['make it pop', 'You said: make it pop']);
  assert.equal(switched.data.chat.busy, false);
  assert.ok(!fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes('sk-test'));
});

test('a reply can be undone as a whole, and the chat is kept across a restart', async (t) => {
  const { z } = await import('zod');
  const home = tmpDir(t);
  const trees = ['a'.repeat(40), 'b'.repeat(40)]; // before the reply, and at the time of the undo
  const restored = [];
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, { 'index.html': '<h1>hi</h1>' }),
    treeId: () => trees.shift() || 'c'.repeat(40),
    restoreTree: (dir, tree) => { restored.push(tree); return { stashed: true }; },
  });
  const turns = [];
  const sdk = {
    tool: (name, d, s, handler) => ({ name, handler }),
    createSdkMcpServer: (o) => o,
    query({ prompt }) {
      const it = (async function* () {
        for await (const turn of prompt) {
          turns.push(turn.message.content);
          yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Changed it.' }] } };
          yield { type: 'result', subtype: 'success' };
        }
      })();
      it.interrupt = async () => {};
      it.close = () => {};
      return it;
    },
  };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const start = async () => {
    const app = await createApp({ home, gitops, config: createConfig(home), agentSdk: async () => ({ sdk, z }) });
    const port = await app.listen(0);
    const call = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json() };
    };
    return { app, call };
  };
  const wait = () => new Promise((r) => setTimeout(r, 60));

  const first = await start();
  await first.call('POST', '/api/open', { repo: 'acme/site' });
  assert.equal((await first.call('GET', '/api/state')).data.chat.canUndo, false);
  assert.equal((await first.call('POST', '/api/chat/undo')).status, 400, 'nothing to undo yet');
  assert.equal((await first.call('POST', '/api/chat/send', { text: 'Make it red', page: '/about.html' })).status, 200);
  await wait();
  assert.equal((await first.call('GET', '/api/state')).data.chat.canUndo, true);

  // Undo: the files go back to the snapshot taken before the message was sent.
  assert.deepEqual((await first.call('POST', '/api/chat/undo')).data, { stashed: true });
  assert.deepEqual(restored, ['a'.repeat(40)]);
  const after = (await first.call('GET', '/api/state')).data.chat;
  assert.equal(after.canUndo, false, 'only once');
  assert.match(after.items.at(-1).text, /You undid the changes from the last reply/);
  // The AI is told, with the next message, that its edits are gone.
  await first.call('POST', '/api/chat/send', { text: 'Try green' });
  await wait();
  assert.match(turns[1], /The owner has undone the file changes from your last reply/);

  // The chat is in Roadie's own folder, not in the site.
  const file = path.join(home, 'chats', 'acme__site.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((i) => i.role), ['user', 'assistant', 'note', 'user', 'assistant']);
  await first.app.close();

  // Roadie starts again: the chat is back, and the new AI process is told the gist.
  const second = await start();
  t.after(() => second.app.close());
  await second.call('POST', '/api/open', { repo: 'acme/site' });
  const back = (await second.call('GET', '/api/state')).data.chat;
  assert.deepEqual(back.items.map((i) => i.text).slice(0, 2), ['Make it red', 'Changed it.']);
  assert.equal(back.canUndo, false, 'a snapshot does not outlive the run that took it');
  await second.call('POST', '/api/chat/send', { text: 'And bigger' });
  await wait();
  assert.match(turns[2], /^And bigger\n\n<background from="Roadie">\nYou were restarted[\s\S]*Owner: Try green/);

  // New chat forgets it for good.
  await second.call('POST', '/api/chat/new');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((await second.call('GET', '/api/state')).data.chat.items, []);
});
