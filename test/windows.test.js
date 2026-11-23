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

// --- CRLF and Windows paths ----------------------------------------------------

test('a clone checked out with CRLF line endings (Windows git) behaves like any other', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { createRemote } = await import('./fake-github.js');
  const { createGitOps } = await import('../src/gitops.js');
  const { scanForSecrets } = await import('../src/guards.js');
  const { searchFiles } = await import('../src/agent.js');

  const root = tmpDir(t);
  const remote = createRemote(root, { 'index.html': '<h1>one</h1>\n<p>two</p>\n<p>three</p>\n', 'css/site.css': 'a { color: red }\n' });
  const dir = remote.clone(path.join(root, 'site'));
  // What Git for Windows does by default: text files are CRLF on disk, LF in the repo.
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('config', 'core.autocrlf', 'true');
  fs.rmSync(path.join(dir, 'index.html'));
  fs.rmSync(path.join(dir, 'css/site.css'));
  git('checkout', '--', '.');
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<h1>one<\/h1>\r\n/, 'the clone really has CRLF on disk');

  const gitops = createGitOps();
  assert.equal(await gitops.isClean(dir), true, 'CRLF on disk alone is not a change');
  assert.deepEqual(await gitops.changes(dir), []);
  const before = await gitops.treeId(dir);

  // An editor that keeps CRLF, one that writes LF, and a new CRLF file holding a secret-looking line.
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>one</h1>\r\n<p>2</p>\r\n<p>three</p>\r\n');
  fs.writeFileSync(path.join(dir, 'css/site.css'), 'a { color: blue }\n');
  const key = ['sk', 'ant', 'api03', 'x'.repeat(30)].join('-');
  fs.writeFileSync(path.join(dir, 'notes.txt'), `first\r\nkey = ${key}\r\n`);

  const changes = await gitops.changes(dir);
  assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`), ['modified css/site.css', 'modified index.html', 'added notes.txt']);
  const html = changes.find((c) => c.path === 'index.html').diff;
  assert.equal(html.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length, 2, 'one line changed, not the whole file');
  assert.notEqual(await gitops.treeId(dir), before);
  assert.equal(await gitops.treeId(dir), await gitops.treeId(dir), 'the same files give the same fingerprint');

  const findings = scanForSecrets({ files: changes.map((c) => c.path), additions: await gitops.additions(dir) });
  assert.deepEqual(findings.map((f) => f.path), ['notes.txt'], 'a secret on a CRLF line is still caught');
  assert.match(await searchFiles({ gitops, dir, query: 'three' }), /^index\.html:3: <p>three<\/p>$/, 'no stray carriage return in search results');

  // Commit and push on a branch: what reaches the remote has LF only.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'first\r\nsecond\r\n');
  await gitops.startBranch(dir, 'change/crlf', 'main');
  await gitops.stageAll(dir);
  await gitops.commit(dir, 'CRLF change', { defaultBranch: 'main' });
  await gitops.push(dir, 'change/crlf', { defaultBranch: 'main' });
  assert.equal(remote.show('change/crlf', 'notes.txt'), 'first\nsecond');
  assert.doesNotMatch(remote.show('change/crlf', 'index.html'), /\r/);
  assert.equal(await gitops.isClean(dir), true);
});

test('the starter is written with LF endings and says so to git', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { writeStarter, fill } = await import('../src/starter.js');
  const dir = tmpDir(t);
  writeStarter(dir, { owner: 'acme', repo: 'site', title: 'Acme', domain: 'acme.example' });
  assert.match(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  for (const file of ['deploy/update.sh', 'Dockerfile', 'server.js', 'compose.yaml']) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /\r/, file);
  }
  assert.match(fs.readFileSync(path.join(dir, 'deploy/crontab.example'), 'utf8'), / sh "\$HOME\/site\/deploy\/update\.sh"/, 'run through sh: Windows cannot record the executable flag');
  assert.equal(fill('a\r\n{{TITLE}}', { TITLE: 'x' }), 'a\r\nx');
});

test('Windows-only folder names are avoided for the site folder', async () => {
  const { folderName, siteDir } = await import('../src/sites.js');
  for (const name of ['con', 'NUL', 'aux', 'com1', 'LPT9', 'nul.dev', 'site.']) assert.equal(folderName(name, 'win32'), `${name}_`, name);
  for (const name of ['console', 'null', 'my-site', 'com10', '3Chords.dev']) assert.equal(folderName(name, 'win32'), name, name);
  assert.equal(folderName('con', 'darwin'), 'con');
  assert.match(siteDir('/home', 'aux', 'nul.dev', 'win32'), /aux_.nul\.dev_$/);
});
