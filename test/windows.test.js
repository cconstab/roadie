// What Roadie does differently on Windows. These run on every system by
// telling the code which platform to behave as.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSitePath, isGitFolderName, isSecretPath, isShortName } from '../src/guards.js';
import { browserOpener, stopTree, taskkillArgs, treeOptions } from '../src/proc.js';
import { Runner } from '../src/runner.js';
import { runTests } from '../src/tests.js';
import { tmpDir, writeFiles } from './helpers.js';

test('a site command is started so its whole tree can be stopped, on each system', () => {
  assert.deepEqual(treeOptions('darwin'), { detached: true });
  assert.deepEqual(treeOptions('linux'), { detached: true });
  assert.deepEqual(treeOptions('win32'), { windowsHide: true }, 'no process groups on Windows, and no console window');
});

test('stopping a tree signals the process group, or uses taskkill on Windows', () => {
  const killed = [];
  stopTree({ pid: 4321 }, 'SIGKILL', { platform: 'darwin', kill: (pid, sig) => killed.push([pid, sig]) });
  assert.deepEqual(killed, [[-4321, 'SIGKILL']]);

  const ran = [];
  stopTree({ pid: 4321 }, 'SIGTERM', { platform: 'win32', kill: () => assert.fail('no signals on Windows'), runSync: (cmd, args) => ran.push([cmd, ...args]) });
  assert.deepEqual(ran, [['taskkill', '/pid', '4321', '/T', '/F']]);
  assert.deepEqual(taskkillArgs(7), ['/pid', '7', '/T', '/F']);

  // Nothing to stop, or already gone: never throws.
  stopTree(null);
  stopTree({ pid: 1 }, 'SIGTERM', { platform: 'linux', kill: () => { throw new Error('ESRCH'); } });
  stopTree({ pid: 1 }, 'SIGTERM', { platform: 'win32', runSync: () => { throw new Error('ENOENT'); } });
});

test('the launch link is opened without a shell reading it', () => {
  const url = 'http://127.0.0.1:4747/?key=abc&x=1';
  assert.deepEqual(browserOpener(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserOpener(url, 'linux'), ['xdg-open', [url]]);
  const [program, args] = browserOpener(url, 'win32');
  assert.equal(program, 'rundll32');
  assert.equal(args.at(-1), url);
  assert.notEqual(program, 'cmd');
});

test('Windows spellings of .git and of secret files are recognised', () => {
  for (const name of ['.git', '.GIT', '.git.', '.git ', '.git::$INDEX_ALLOCATION', '.git:stream', 'GIT~1', 'git~2']) {
    assert.equal(isGitFolderName(name), true, name);
  }
  for (const name of ['.github', '.gitignore', 'git', 'digit~']) assert.equal(isGitFolderName(name), false, name);

  for (const name of ['.env::$DATA', '.ENV:stream', '.env.', 'id_rsa::$DATA', 'server.pem:x']) assert.equal(isSecretPath(name), true, name);
  assert.equal(isSecretPath('.env.example::$DATA'), false);

  assert.equal(isShortName('ENV~1'), true);
  assert.equal(isShortName('PROGRA~2'), true);
  assert.equal(isShortName('notes~'), false);
  assert.equal(isShortName('index.html'), false);
});

test('on Windows the AI cannot name a file by its short name', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'index.html': 'x', '.env': 'KEY=1' });
  const win = { platform: 'win32' };
  assert.equal(checkSitePath(dir, 'index.html', win).ok, true);
  assert.equal(checkSitePath(dir, 'css/new.css', win).ok, true);
  assert.match(checkSitePath(dir, 'ENV~1', win).reason, /short name/);
  assert.match(checkSitePath(dir, 'INDEX~1.HTM', win).reason, /short name/);
  assert.match(checkSitePath(dir, 'sub/SECRET~1/file.txt', win).reason, /short name/);
  assert.match(checkSitePath(dir, 'GIT~1/config', win).reason, /\.git folder/);
  assert.match(checkSitePath(dir, '.git::$INDEX_ALLOCATION/config', win).reason, /\.git folder/);
  assert.match(checkSitePath(dir, '.env::$DATA', win).reason, /secrets file/);
  assert.match(checkSitePath(dir, '../x', win).reason, /outside the site folder/);
  // Elsewhere a "~1" name is an ordinary file.
  assert.equal(checkSitePath(dir, 'backup~1.txt', { platform: 'darwin' }).ok, true);
});

test('without a sandbox (as on Windows and Linux) commands run through the plain shell and stop as a tree', async (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'server.js': "require('node:http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, '127.0.0.1');" });

  const ok = await runTests({ dir, command: 'node -e "console.log(40 + 2)"', sandbox: false });
  assert.equal(ok.passed, true);
  assert.equal(ok.sandboxed, false);
  assert.match(ok.output, /42/);

  const started = Date.now();
  const slow = await runTests({ dir, command: 'node -e "setInterval(() => {}, 1000)"', sandbox: false, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'the timeout stopped it');

  const runner = new Runner();
  t.after(() => runner.stop());
  const status = await runner.start({ dir, command: 'node server.js' });
  assert.equal(status.state, 'running');
  assert.equal(await (await fetch(`http://127.0.0.1:${status.port}/`)).text(), 'ok');
  await runner.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${status.port}/`));
});
