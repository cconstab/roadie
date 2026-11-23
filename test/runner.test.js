import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Runner, freePort, listeningHost } from '../src/runner.js';
import { needsRestart } from '../src/watcher.js';
import { tmpDir, writeFiles } from './helpers.js';

const SERVER = `
const http = require('node:http');
const port = Number(process.env.FIXED_PORT || process.env.PORT);
http.createServer((req, res) => res.end(JSON.stringify({
  host: process.env.HOST, key: process.env.ANTHROPIC_API_KEY || null,
}))).listen(port, '127.0.0.1', () => console.log('up on ' + port));
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid) {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

test('the start command runs on a free port and is stopped as a whole', async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'server.js': SERVER });
  const runner = new Runner();
  t.after(() => runner.stop());
  const logs = [];
  runner.on('log', (e) => logs.push(e.line));

  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });

  const status = await runner.start({ dir, command: 'node server.js', portHint: 8080 });
  assert.equal(status.state, 'running');
  assert.equal(status.mode, 'command');
  assert.equal(status.host, '127.0.0.1');
  assert.notEqual(status.port, 8080);

  const seen = await (await fetch(`http://127.0.0.1:${status.port}/`)).json();
  assert.equal(seen.host, '127.0.0.1', 'the site is told to listen on this machine only');
  assert.equal(seen.key, null, "the site must not inherit Roadie's AI key");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(logs.some((l) => l.includes('up on')));

  const pid = runner.child.pid;
  await runner.stop();
  assert.equal(runner.status.state, 'stopped');
  assert.ok(await waitGone(pid), 'the child process is gone');
  assert.equal(await listeningHost(status.port), null);
});

test('a restart reuses the same port', async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'server.js': SERVER });
  const runner = new Runner();
  t.after(() => runner.stop());
  const first = await runner.start({ dir, command: 'node server.js' });
  const second = await runner.start({ dir, command: 'node server.js' });
  assert.equal(second.state, 'running');
  assert.equal(second.port, first.port);
});

test('a site that ignores PORT is found on its usual port', async (t) => {
  const dir = tmpDir(t);
  // Works the same under sh and cmd.exe: the port is an argument, not a shell variable.
  writeFiles(dir, { 'server.js': SERVER, 'fixed.js': 'process.env.FIXED_PORT = process.argv[2]; require("./server.js");' });
  const fixed = await freePort();
  const runner = new Runner();
  t.after(() => runner.stop());
  const status = await runner.start({ dir, command: `node fixed.js ${fixed}`, portHint: fixed });
  assert.equal(status.state, 'running');
  assert.equal(status.port, fixed);
});

test('a start command that exits is reported as failed', async (t) => {
  const dir = tmpDir(t);
  const runner = new Runner();
  const status = await runner.start({ dir, command: 'node -e "process.exit(3)"' });
  assert.equal(status.state, 'failed');
  assert.match(status.error, /exit 3/);
});

test('a site that never listens times out and is stopped', async (t) => {
  const dir = tmpDir(t);
  const runner = new Runner({ startTimeoutMs: 600 });
  const status = await runner.start({ dir, command: 'node -e "setInterval(()=>{},1000)"' });
  assert.equal(status.state, 'failed');
  assert.match(status.error, /nothing answered/);
  assert.equal(runner.child, null);
});

test('the install command runs first when node_modules is missing', async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'server.js': SERVER });
  const runner = new Runner();
  t.after(() => runner.stop());
  const status = await runner.start({ dir, command: 'node server.js', install: 'mkdir node_modules && echo installed > node_modules/marker' }); // valid in sh and cmd.exe
  assert.equal(status.state, 'running');
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'marker')));

  const failing = await new Runner().start({ dir: tmpDir(t), command: 'node server.js', install: 'exit 2' });
  assert.equal(failing.state, 'failed');
  assert.match(failing.error, /install command failed/);
});

test('with no start command the folder is served as static files', async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, {
    'index.html': '<h1>home</h1>', 'about.html': '<h1>about</h1>', 'css/site.css': 'a{}',
    '.env': 'SECRET=1', '.git/config': '[core]',
  });
  const runner = new Runner();
  t.after(() => runner.stop());
  const status = await runner.start({ dir, command: '' });
  assert.equal(status.state, 'running');
  assert.equal(status.mode, 'static');
  const base = `http://127.0.0.1:${status.port}`;

  const home = await fetch(base + '/');
  assert.equal(await home.text(), '<h1>home</h1>');
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(await (await fetch(base + '/about')).text(), '<h1>about</h1>');
  assert.match((await fetch(base + '/css/site.css')).headers.get('content-type'), /text\/css/);

  // A link to a dotfile, and the Windows spellings of one, are hidden too.
  try { fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'settings.txt')); } catch { /* no symlinks here */ }
  for (const hidden of ['/.env', '/.git/config', '/missing.html', '/%2e%2e/%2e%2e/etc/passwd', '/settings.txt', '/index.html::$DATA', '/about.html.', '/css%20/site.css']) {
    assert.equal((await fetch(base + hidden)).status, 404, hidden);
  }
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);

  await runner.stop();
  assert.equal(await listeningHost(status.port), null);
});

test('only non-static changes restart the site', () => {
  assert.equal(needsRestart(['css/styles.css', 'index.html', 'img/logo.png']), false);
  assert.equal(needsRestart(['index.html', 'server.js']), true);
  assert.equal(needsRestart(['package.json']), true);
});

test('a site that rewrites its own files on every start is not restarted for ever', async () => {
  const { createRestartGuard } = await import('../src/watcher.js');
  let time = 10_000;
  const guard = createRestartGuard({ now: () => time });

  // A loop: the same file changes just after each restart.
  assert.equal(guard.allow(['server.js']), true, 'the first change always restarts');
  for (let i = 0; i < 2; i++) { guard.started(); time += 400; assert.equal(guard.allow(['cache/build.json']), true); }
  guard.started(); time += 400;
  assert.equal(guard.allow(['cache/build.json']), false, 'third time in a row: held back');
  guard.started(); time += 400;
  assert.equal(guard.allow(['cache/build.json']), false);

  // Someone editing: different files in quick succession are never held back.
  const editing = createRestartGuard({ now: () => time });
  for (const file of ['server.js', 'routes.js', 'package.json', 'lib/a.js', 'lib/b.js', 'lib/c.js']) {
    editing.started(); time += 300;
    assert.equal(editing.allow([file]), true, file);
  }
  // Nor is the same file edited with pauses, however many times.
  for (let i = 0; i < 6; i++) { editing.started(); time += 5000; assert.equal(editing.allow(['server.js']), true); }
  // And after a held-back loop, a real edit restarts again.
  guard.started(); time += 6000;
  assert.equal(guard.allow(['server.js']), true);
});

test('git-hook installers are told to stand down, and failures in the sandbox are explained', async (t) => {
  const { sandboxHint } = await import('../src/sandbox.js');
  const dir = tmpDir(t);
  writeFiles(dir, { 'server.js': SERVER });
  const runner = new Runner();
  t.after(() => runner.stop());
  const status = await runner.start({ dir, command: 'node server.js', install: `node -e "process.exit(process.env.HUSKY === '0' ? 0 : 1)" && mkdir node_modules` });
  assert.equal(status.state, 'running', 'the install saw HUSKY=0');

  assert.match(sandboxHint('sh: /Users/x/file: Operation not permitted', 'tests'), /Roadie's sandbox.*cannot reach the internet/s);
  assert.doesNotMatch(sandboxHint('npm ERR! EPERM: open', 'install'), /cannot reach the internet/);
  assert.equal(sandboxHint('AssertionError: 1 !== 2', 'tests'), '');
});
