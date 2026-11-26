import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGitOps } from '../src/gitops.js';
import { runTests, sandboxAvailable } from '../src/tests.js';
import { tmpDir, writeFiles } from './helpers.js';

// A real local repository. Nothing here touches the network.
function repo(t, files) {
  const dir = tmpDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFiles(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { dir, git };
}

test('changes lists modified, new, deleted and renamed files with their diffs', async (t) => {
  const { dir, git } = repo(t, { 'index.html': '<h1>old</h1>\n', 'gone.txt': 'bye\n', 'old name.txt': 'same content\nline two\nline three\n', '.gitignore': 'data/\n' });
  writeFiles(dir, { 'index.html': '<h1>new</h1>\n', 'css/new file.css': 'a { color: red }\n', 'data/db.json': '{}' });
  fs.rmSync(path.join(dir, 'gone.txt'));
  git('mv', 'old name.txt', 'new name.txt');

  const changes = await createGitOps().changes(dir);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), ['css/new file.css', 'gone.txt', 'index.html', 'new name.txt']);

  assert.equal(byPath['index.html'].status, 'modified');
  assert.match(byPath['index.html'].diff, /-<h1>old<\/h1>\n\+<h1>new<\/h1>/);
  assert.equal(byPath['css/new file.css'].status, 'added');
  assert.match(byPath['css/new file.css'].diff, /\+a \{ color: red \}/);
  assert.equal(byPath['gone.txt'].status, 'deleted');
  assert.match(byPath['gone.txt'].diff, /-bye/);
  assert.equal(byPath['new name.txt'].status, 'renamed');
  assert.equal(byPath['new name.txt'].from, 'old name.txt');
});

test('a clean repo has no changes, and listFiles leaves out ignored files', async (t) => {
  const { dir } = repo(t, { 'index.html': 'x', '.gitignore': 'data/\nnode_modules/\n' });
  const gitops = createGitOps();
  assert.deepEqual(await gitops.changes(dir), []);
  writeFiles(dir, { 'data/db.json': '{}', 'node_modules/x/index.js': '', 'new.js': '' });
  assert.deepEqual(await gitops.listFiles(dir), ['.gitignore', 'index.html', 'new.js']);
  assert.deepEqual([...(await gitops.ignored(dir, ['data/db.json', 'new.js']))], ['data/db.json']);
});

test("a hook planted in the site's clone is not run by Roadie's git commands", async (t) => {
  const { dir } = repo(t, { 'index.html': 'x' });
  const marker = path.join(dir, 'hook-ran');
  const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const calls = [];
  const gitops = createGitOps({
    run: async (cmd, args, opts) => { calls.push([cmd, ...args]); return (await import('../src/exec.js')).run(cmd, args, opts); },
  });
  await gitops.currentBranch(dir);
  assert.ok(calls.every(([cmd, a, b]) => cmd !== 'git' || (a === '-c' && b === 'core.hooksPath=/dev/null')), 'every git call disables hooks');
  assert.ok(!fs.existsSync(marker));
});

test('runTests reports pass, fail, a missing command and a timeout', async (t) => {
  const dir = tmpDir(t);
  const seen = [];
  const pass = await runTests({ dir, command: 'echo all good', onOutput: (s) => seen.push(s) });
  assert.equal(pass.passed, true);
  assert.match(pass.output, /all good/);
  assert.match(seen.join(''), /all good/);

  const fail = await runTests({ dir, command: `node -e "console.error('broken'); process.exit(3)"` });
  assert.equal(fail.passed, false);
  assert.equal(fail.code, 3);
  assert.match(fail.output, /broken/);

  const none = await runTests({ dir, command: '' });
  assert.equal(none.passed, false);
  assert.match(none.output, /no test command/);

  const slow = await runTests({ dir, command: 'node -e "setInterval(() => {}, 1000)"', timeoutMs: 300 });
  assert.equal(slow.passed, false);
  assert.equal(slow.timedOut, true);
});

test('tests do not inherit AI or GitHub credentials', async (t) => {
  const dir = tmpDir(t);
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  process.env.GH_TOKEN = 'ghp_test_not_real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.GH_TOKEN; });
  const result = await runTests({ dir, command: `node -e "console.log('key=[' + (process.env.ANTHROPIC_API_KEY || '') + '] gh=[' + (process.env.GH_TOKEN || '') + ']')"` });
  assert.match(result.output, /key=\[\] gh=\[\]/);
});

test('sandboxed tests cannot write to .git or reach beyond this machine', { skip: !sandboxAvailable() && 'needs macOS sandbox-exec' }, async (t) => {
  const { dir } = repo(t, { 'index.html': 'x' });
  const hook = await runTests({ dir, command: 'echo "#!/bin/sh" > .git/hooks/pre-push' });
  assert.equal(hook.sandboxed, true);
  assert.equal(hook.passed, false);
  assert.ok(!fs.existsSync(path.join(dir, '.git/hooks/pre-push')));

  const config = await runTests({ dir, command: 'git config user.name Mallory' });
  assert.equal(config.passed, false);

  const ok = await runTests({ dir, command: 'echo hi > made-by-test.txt && cat made-by-test.txt' });
  assert.equal(ok.passed, true, 'writing inside the site is still allowed');

  // 192.0.2.1 is a reserved documentation address: nothing is there, but the
  // sandbox must refuse the connection outright rather than let it time out.
  const net = await runTests({ dir, command: `node -e "require('net').connect(80,'192.0.2.1').on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:1)}).setTimeout(2000,()=>process.exit(2))"` });
  assert.match(net.output, /EPERM/);
});

test('the secret scan sees real content whatever .gitattributes says', async (t) => {
  const { dir, git } = repo(t, { 'index.html': 'x\n', '.gitattributes': '*.js -diff\n*.dat binary\n' });
  const gitops = createGitOps();
  const key = `${'gh' + 'p_'}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
  writeFiles(dir, { 'config.js': `const token = "${key}";\n`, 'blob.dat': `password=${key}\n`, 'notes.txt': '++ a line that starts with two pluses\n+++ and three\n' });

  const pending = await gitops.additions(dir, 'HEAD');
  assert.ok(pending.some((a) => a.path === 'config.js' && a.line.includes(key)), 'an untracked file marked -diff is still read');
  assert.ok(pending.some((a) => a.path === 'blob.dat' && a.line.includes(key)), 'so is one marked binary');
  assert.deepEqual(pending.filter((a) => a.path === 'notes.txt').map((a) => a.line), ['++ a line that starts with two pluses', '+++ and three']);

  git('add', '-A');
  const staged = await gitops.stagedAdditions(dir);
  assert.ok(staged.some((a) => a.path === 'config.js' && a.line.includes(key)));
  assert.ok(staged.some((a) => a.path === 'notes.txt' && a.line === '++ a line that starts with two pluses'));
  git('commit', '-q', '-m', 'second');

  // And for a change to a file that is already tracked.
  writeFiles(dir, { 'config.js': `const token = "${key}";\nconst other = "${key}x";\n` });
  const edited = await gitops.additions(dir, 'HEAD');
  assert.deepEqual(edited.map((a) => a.path), ['config.js']);
  assert.ok(edited[0].line.includes(`${key}x`));
});

test('a file-system-monitor program named in the clone is never run', async (t) => {
  const { dir, git } = repo(t, { 'index.html': 'x\n' });
  const marker = path.join(dir, 'monitor-ran');
  const script = path.join(dir, 'monitor.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  git('config', 'core.fsmonitor', script);
  const gitops = createGitOps();
  await gitops.changes(dir);
  await gitops.treeId(dir);
  await gitops.isClean(dir);
  assert.ok(!fs.existsSync(marker));
});

test('one AI reply can be undone as a whole, and what it did is kept in the stash', async (t) => {
  const { dir, git } = repo(t, { 'index.html': '<h1>one</h1>\n', 'gone.txt': 'bye\n', '.gitignore': 'data/\n' });
  const gitops = createGitOps();
  // Before the reply: an edit, a new file and a deletion the owner already made, none committed.
  writeFiles(dir, { 'index.html': '<h1>mine</h1>\n', 'notes.txt': 'my notes\n', 'data/keep.json': '{}' });
  fs.rmSync(path.join(dir, 'gone.txt'));
  const before = await gitops.treeId(dir);

  // The reply: edits a file, adds one, deletes one, brings one back.
  writeFiles(dir, { 'index.html': '<h1>AI</h1>\n', 'ai.css': 'a{}\n', 'gone.txt': 'back\n' });
  fs.rmSync(path.join(dir, 'notes.txt'));

  assert.deepEqual(await gitops.restoreTree(dir, before), { stashed: true });
  assert.equal(await gitops.treeId(dir), before, 'every file is as it was');
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>mine</h1>\n');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'my notes\n');
  assert.equal(fs.existsSync(path.join(dir, 'ai.css')), false);
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'data/keep.json')), true, 'ignored files are left alone');
  assert.match(String(git('stash', 'list')), /roadie: undo AI reply/);
  assert.match(String(git('show', 'stash@{0}:index.html')), /AI/, 'the undone edit can be recovered');
  assert.equal(String(git('log', '--oneline')).trim().split('\n').length, 1, 'no commit was made');
  assert.equal(String(git('branch', '--show-current')).trim(), 'main', 'and no branch moved');

  await assert.rejects(gitops.restoreTree(dir, 'HEAD; rm -rf /'), /not a snapshot/);
});

test('undoing a reply needs a commit to keep the edits against', async (t) => {
  const dir = tmpDir(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFiles(dir, { 'index.html': 'x\n' });
  const gitops = createGitOps();
  await assert.rejects(gitops.restoreTree(dir, await gitops.treeId(dir)), /no commits yet/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'x\n');
});
