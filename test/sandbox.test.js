// What site code can and cannot do inside the box. These run real commands
// under macOS sandbox-exec, so they are skipped where it does not exist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Runner } from '../src/runner.js';
import { protectRoadie, sandboxAvailable, sandboxProfile } from '../src/sandbox.js';
import { runTests } from '../src/tests.js';
import { tmpDir, writeFiles } from './helpers.js';

const skip = !sandboxAvailable() && 'needs macOS sandbox-exec';

function listen(body) {
  const server = http.createServer((req, res) => res.end(body));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const get = (port) => `node -e "fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>{console.log('GOT:'+t)}).catch(e=>{console.log('BLOCKED:'+(e.cause&&e.cause.code||e.message))})"`;

test('the profile differs by what is being run', () => {
  const dir = os.tmpdir();
  const tests = sandboxProfile({ siteDir: dir, mode: 'tests', blockPorts: [4747, 5151] });
  assert.match(tests, /\(deny network-outbound\)\n\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.match(tests, /\(deny network-outbound \(remote ip "localhost:4747"\)\)/);
  assert.match(tests, /\(deny network-outbound \(remote ip "localhost:5151"\)\)/);
  assert.match(tests, /\(deny file-write\*\)/);
  assert.match(tests, /com\.apple\.SecurityServer/);

  const preview = sandboxProfile({ siteDir: dir, mode: 'preview' });
  assert.match(preview, /\(deny network-outbound\)\n/, 'a previewed site is offline unless its owner says otherwise');
  const open = sandboxProfile({ siteDir: dir, mode: 'preview', openNetwork: true, blockPorts: [4747] });
  assert.doesNotMatch(open, /\(deny network-outbound\)\n/);
  assert.match(open, /\(deny network-outbound \(remote unix-socket\)\)/, 'with the internet on, local sockets such as ssh-agent stay closed');
  assert.match(open, /localhost:4747/, "Roadie's own port stays closed either way");

  const install = sandboxProfile({ siteDir: dir, mode: 'install' });
  assert.doesNotMatch(install, /\(deny network-outbound\)\n/);
  assert.match(install, /\.npmrc/);
  assert.doesNotMatch(tests, /\.npmrc"\)/, 'only an install may read the npm settings file');
});

test('boxed code cannot reach Roadie, but can reach servers it starts itself', { skip }, async (t) => {
  const dir = tmpDir(t);
  const roadie = await listen('ROADIE PAGE WITH TOKEN');
  const other = await listen('a server the tests started');
  t.after(() => { roadie.close(); other.close(); });
  protectRoadie({ ports: [roadie.address().port] });

  const blocked = await runTests({ dir, command: get(roadie.address().port) });
  assert.equal(blocked.sandboxed, true);
  assert.match(blocked.output, /BLOCKED:/);
  assert.doesNotMatch(blocked.output, /TOKEN/);

  const allowed = await runTests({ dir, command: get(other.address().port) });
  assert.match(allowed.output, /GOT:a server the tests started/);
});

test('boxed code cannot read the home folder, the sign-in, or the site\'s secrets', { skip }, async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'index.html': 'public\n', '.env': 'ADMIN_TOKEN=do-not-leak\n', 'config/.env.production': 'KEY=do-not-leak-either\n' });
  const home = os.homedir();

  const ls = await runTests({ dir, command: `ls "${home}" && echo LISTED` });
  assert.doesNotMatch(ls.output, /LISTED/);

  const gh = await runTests({ dir, command: `cat "${home}/.config/gh/hosts.yml" 2>&1; cat "${home}/.ssh/id_rsa" "${home}/.ssh/id_ed25519" "${home}/.netrc" "${home}/.git-credentials" 2>&1; echo done` });
  assert.doesNotMatch(gh.output, /oauth_token|PRIVATE KEY|password/i);

  const env = await runTests({ dir, command: 'cat .env config/.env.production; cat index.html' });
  assert.doesNotMatch(env.output, /do-not-leak/, 'a test cannot print the secrets file for the AI to read');
  assert.match(env.output, /public/);
});

test('boxed code can write in the site and temp folders only, and never in .git', { skip }, async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const probe = path.join(os.homedir(), `.roadie-sandbox-probe-${process.pid}`);
  t.after(() => fs.rmSync(probe, { force: true }));

  const outside = await runTests({ dir, command: `echo x > "${probe}"` });
  assert.equal(outside.passed, false);
  assert.ok(!fs.existsSync(probe));

  for (const target of ['.git/hooks/pre-push', '.GIT/hooks/pre-push', '.git/config']) {
    const r = await runTests({ dir, command: `echo x > ${target}` });
    assert.equal(r.passed, false, target);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, '.git')), ['hooks']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'hooks')), []);

  const inside = await runTests({ dir, command: 'mkdir -p out && echo ok > out/result.txt && echo ok > "$TMPDIR/roadie-probe" && rm "$TMPDIR/roadie-probe" && cat out/result.txt' });
  assert.equal(inside.passed, true, inside.output);
});

test("the preview's server runs in the box too", { skip }, async (t) => {
  const dir = tmpDir(t);
  const roadie = await listen('ROADIE PAGE WITH TOKEN');
  t.after(() => roadie.close());
  protectRoadie({ ports: [roadie.address().port] });
  const probe = path.join(os.homedir(), `.roadie-preview-probe-${process.pid}`);
  t.after(() => fs.rmSync(probe, { force: true }));
  // A server as the AI might have left it: it tries to reach Roadie, the internet, and the home folder.
  writeFiles(dir, { 'server.js': `
    const http = require('node:http'); const fs = require('node:fs');
    const tried = {};
    const attempt = async (name, fn) => { try { tried[name] = 'DID: ' + await fn(); } catch (e) { tried[name] = 'blocked'; } };
    http.createServer(async (req, res) => {
      await attempt('roadie', () => fetch('http://127.0.0.1:${roadie.address().port}/').then(r => r.text()));
      await attempt('home', () => fs.promises.writeFile(${JSON.stringify(probe)}, 'x').then(() => 'wrote'));
      await attempt('hook', () => fs.promises.writeFile('.git/hooks/pre-push', 'x').then(() => 'wrote'));
      res.end(JSON.stringify(tried));
    }).listen(process.env.PORT, '127.0.0.1');
  ` });
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const runner = new Runner();
  t.after(() => runner.stop());
  const logs = [];
  runner.on('log', (e) => logs.push(e.line));
  const status = await runner.start({ dir, command: 'node server.js' });
  assert.equal(status.state, 'running');
  assert.ok(logs.some((l) => /sandboxed\)/.test(l)), logs.join('\n'));
  const tried = await (await fetch(`http://127.0.0.1:${status.port}/`)).json();
  assert.deepEqual(tried, { roadie: 'blocked', home: 'blocked', hook: 'blocked' });
  assert.ok(!fs.existsSync(probe));
});

test('tests may read secret-looking files that are committed, but not private ones', { skip }, async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { '.env': 'TOKEN=private-do-not-leak\n', '.env.test': 'TOKEN=fixture-ok\n', 'test/fixtures/server.pem': 'fixture-cert-ok\n' });
  const tracked = ['.env.test', 'test/fixtures/server.pem']; // what git says is in the repo
  const r = await runTests({ dir, command: 'cat .env.test test/fixtures/server.pem; cat .env', tracked });
  assert.match(r.output, /fixture-ok/);
  assert.match(r.output, /fixture-cert-ok/);
  assert.doesNotMatch(r.output, /private-do-not-leak/);
  assert.match(r.output, /Note from Roadie: this ran in Roadie's sandbox/, 'the refusal is explained');

  // Without the list, every secret-looking file is withheld.
  const cautious = await runTests({ dir, command: 'cat .env.test; true' });
  assert.doesNotMatch(cautious.output, /fixture-ok/);
});
