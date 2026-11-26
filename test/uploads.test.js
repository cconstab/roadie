import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { agentOptions, checkToolUse, createChat } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { cleanAi, createConfig } from '../src/config.js';
import { createGitOps } from '../src/gitops.js';
import { addFile, cleanChatImages, cleanUploadPath, imageType, moveFile, removeFile, sniffImage, uploadFolders, browseFiles } from '../src/uploads.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

// The smallest real PNG: one transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);

test('a chosen folder and name become one path inside the site, or a plain refusal', () => {
  assert.equal(cleanUploadPath('images', 'hero.png'), 'images/hero.png');
  assert.equal(cleanUploadPath(' /public\\images/ ', 'team photo.jpg'), 'public/images/team photo.jpg');
  assert.equal(cleanUploadPath('', 'favicon.ico'), 'favicon.ico');
  assert.throws(() => cleanUploadPath('images', ''), /Give the file a name/);
  assert.throws(() => cleanUploadPath('../outside', 'a.png'), /inside the site/);
  assert.throws(() => cleanUploadPath('images', '..'), /inside the site/);
  for (const bad of ['a:b.png', 'what?.png', 'a*.png', 'tab\tname.png', 'quote".png']) {
    assert.throws(() => cleanUploadPath('images', bad), /cannot be used in a file name/, bad);
  }
  assert.throws(() => cleanUploadPath('images', 'photo.'), /ends with a dot or a space/);
  assert.throws(() => cleanUploadPath('aux', 'a.png'), /Windows keeps for itself/);
  assert.throws(() => cleanUploadPath('images', 'NUL.png'), /Windows keeps for itself/);
  assert.throws(() => cleanUploadPath('images', 'x'.repeat(130) + '.png'), /too long/);
});

test('a file is written inside the site only, never over .git or a secret, and never silently over another file', (t) => {
  const dir = tmpDir(t);
  const outside = tmpDir(t);
  writeFiles(dir, { 'index.html': '<h1>hi</h1>', '.git/config': '[core]', 'notes': 'a file' });
  let linked = true;
  try { fs.symlinkSync(outside, path.join(dir, 'elsewhere')); } catch { linked = false; /* no symlinks for this account (Windows) */ }

  assert.deepEqual(addFile(dir, 'images/new/hero.png', PNG), { path: 'images/new/hero.png', bytes: PNG.length, replaced: false });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'images', 'new', 'hero.png')), PNG);

  // The same name again is refused, and says so in a way the interface can ask about.
  assert.throws(() => addFile(dir, 'images/new/hero.png', JPEG), (err) => err.data.exists === true && err.data.path === 'images/new/hero.png' && /already exists/.test(err.message));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'images', 'new', 'hero.png')), PNG, 'left as it was');
  assert.equal(addFile(dir, 'images/new/hero.png', JPEG, { replace: true }).replaced, true);

  assert.throws(() => addFile(dir, '.git/hooks/pre-push', PNG), /\.git folder is off limits/);
  assert.throws(() => addFile(dir, '.GIT/config', PNG, { replace: true }), /\.git folder is off limits/);
  assert.throws(() => addFile(dir, '.env', PNG), /secrets file/);
  assert.throws(() => addFile(dir, 'keys/server.pem', PNG), /secrets file/);
  assert.throws(() => addFile(dir, '../escape.png', PNG), /outside the site folder/);
  if (linked) assert.throws(() => addFile(dir, 'elsewhere/escape.png', PNG), /outside the site folder/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing went through the link');
  assert.throws(() => addFile(dir, 'images', PNG, { replace: true }), /is a folder/);
  assert.throws(() => addFile(dir, 'notes/a.png', PNG), /part of that folder path is a file/);
  assert.throws(() => addFile(dir, 'empty.png', Buffer.alloc(0)), /empty/);
  assert.throws(() => addFile(dir, 'huge.bin', Buffer.alloc(25 * 1024 * 1024 + 1)), /too big/);
});

test('the folder offered for images is the one the site already uses', () => {
  assert.deepEqual(uploadFolders(['index.html', 'css/site.css']), { folders: ['images'], suggested: 'images' });
  // The starter site serves a public folder: pictures go inside it.
  assert.equal(uploadFolders(['server.js', 'public/index.html', 'public/styles.css']).suggested, 'public/images');
  const used = uploadFolders(['index.html', 'favicon.ico', 'logo.png', 'apple-touch.png', 'img/a.jpg', 'img/b.webp', 'img/icons/x.svg', 'node_modules/pkg/logo.png', '.github/shot.png']);
  assert.equal(used.suggested, 'img', 'a picture folder beats the top folder');
  assert.deepEqual(used.folders, ['img', 'img/icons', 'images']);
});

test('pictures are told by their bytes, not their names', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.from('#!/bin/sh\n')), null);
  assert.equal(imageType('a/b/Photo.JPG'), 'image/jpeg');
  assert.equal(imageType('logo.svg'), 'image/svg+xml');
  assert.equal(imageType('page.html'), null);

  const [image] = cleanChatImages([{ name: 'shot.png', mediaType: 'text/html', data: JPEG.toString('base64') }]);
  assert.deepEqual(image, { name: 'shot.png', mediaType: 'image/jpeg', data: JPEG.toString('base64') });
  assert.deepEqual(cleanChatImages(undefined), []);
  assert.throws(() => cleanChatImages([{ name: 'page.png', data: Buffer.from('<html>').toString('base64') }]), /not a PNG, JPEG, GIF or WebP/);
  assert.throws(() => cleanChatImages(new Array(6).fill({ name: 'a.png', data: PNG.toString('base64') })), /at most 5/);
  assert.throws(() => cleanChatImages([{ name: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64') }]), /larger than 5 MB/);
});

test('the AI can delete and move files, inside the site only', async (t) => {
  const dir = tmpDir(t);
  const outside = tmpDir(t);
  writeFiles(dir, { 'index.html': 'x', 'img/old/hero.png': 'PNG', 'img/logo.png': 'LOGO', '.env': 'A=1', '.git/config': '[core]' });
  writeFiles(outside, { 'keep.txt': 'keep' });

  assert.deepEqual(moveFile(dir, 'img/old/hero.png', 'images/banner.png'), { from: 'img/old/hero.png', to: 'images/banner.png' });
  assert.equal(fs.readFileSync(path.join(dir, 'images', 'banner.png'), 'utf8'), 'PNG');
  assert.ok(!fs.existsSync(path.join(dir, 'img', 'old')), 'the folder left empty is removed');
  assert.ok(fs.existsSync(path.join(dir, 'img', 'logo.png')));
  // An absolute path inside the site is as good as a relative one.
  assert.equal(moveFile(dir, path.join(dir, 'images', 'banner.png'), path.join(dir, 'images', 'top.png')).to, 'images/top.png');

  assert.throws(() => moveFile(dir, 'img/logo.png', 'images/top.png'), /already exists/);
  // A change of letter case alone is a rename, but never a way to replace a different file.
  writeFiles(dir, { 'img/Mixed.PNG': 'MIXED' });
  assert.equal(moveFile(dir, 'img/Mixed.PNG', 'img/mixed.png').to, 'img/mixed.png');
  assert.ok(fs.readdirSync(path.join(dir, 'img')).includes('mixed.png'));
  writeFiles(dir, { 'img/other.png': 'OTHER' });
  assert.throws(() => moveFile(dir, 'img/other.png', 'img/mixed.png'), /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'img', 'mixed.png'), 'utf8'), 'MIXED');
  removeFile(dir, 'img/other.png'); removeFile(dir, 'img/mixed.png');
  assert.throws(() => moveFile(dir, 'img/logo.png', '../logo.png'), /outside the site folder/);
  assert.throws(() => moveFile(dir, 'img/logo.png', path.join(outside, 'logo.png')), /outside the site folder/);
  assert.throws(() => moveFile(dir, 'img/logo.png', '.git/hooks/pre-push'), /\.git folder is off limits/);
  assert.throws(() => moveFile(dir, '.env', 'env.txt'), /secrets file/);
  assert.throws(() => moveFile(dir, 'index.html', '.env'), /secrets file/);
  assert.throws(() => moveFile(dir, 'img', 'pictures'), /is a folder/);
  assert.throws(() => moveFile(dir, 'missing.png', 'a.png'), /does not exist/);
  assert.throws(() => moveFile(dir, 'img/logo.png', 'img/lo?go.png'), /cannot be used in a file name/);

  assert.throws(() => removeFile(dir, path.join(outside, 'keep.txt')), /outside the site folder/);
  assert.throws(() => removeFile(dir, '.git/config'), /\.git folder is off limits/);
  assert.throws(() => removeFile(dir, '.env'), /secrets file/);
  assert.throws(() => removeFile(dir, 'images'), /is a folder/);
  assert.deepEqual(removeFile(dir, 'images/top.png'), { path: 'images/top.png' });
  assert.ok(!fs.existsSync(path.join(dir, 'images')));
  assert.ok(fs.existsSync(dir), 'the site folder itself is never removed');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');

  // The same rules stand in front of the tools, and the tools answer the AI in words.
  assert.match(checkToolUse(dir, 'mcp__roadie__delete_file', { path: '.git/config' }), /off limits/);
  assert.match(checkToolUse(dir, 'move_file', { from: 'index.html', to: '../x' }), /outside the site folder/);
  assert.equal(checkToolUse(dir, 'mcp__roadie__move_file', { from: 'index.html', to: 'home.html' }), null);
  const sdk = { tool: (name, d, s, handler) => ({ name, handler }), createSdkMcpServer: (o) => o };
  const options = agentOptions({ sdk, z, gitops: fakeGitOps(), site: { dir, settings: {} }, ai: cleanAi({}), runTests: async () => ({}) });
  const tool = (name) => options.mcpServers.roadie.tools.find((x) => x.name === name).handler;
  assert.deepEqual(await tool('move_file')({ from: 'index.html', to: 'home.html' }), { content: [{ type: 'text', text: 'Moved index.html to home.html.' }] });
  const refused = await tool('delete_file')({ path: '.env' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /secrets file/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'A=1');
  assert.equal(options.toolAliases.delete_file, 'mcp__roadie__delete_file');
});

test('pictures attached to a message reach the AI as images, with the words after them', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const turns = [];
  const sdk = {
    tool: (name, d, s, handler) => ({ name, handler }),
    createSdkMcpServer: (o) => o,
    query({ prompt }) {
      const it = (async function* () { for await (const turn of prompt) { turns.push(turn.message.content); yield { type: 'result', subtype: 'success' }; } })();
      it.interrupt = async () => {}; it.close = () => {};
      return it;
    },
  };
  const dir = tmpDir(t);
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: { dir, settings: {} }, ai: cleanAi({}), runTests: async () => ({}), emit: () => {} });
  t.after(() => chat.close());
  const images = cleanChatImages([{ name: 'design.png', data: PNG.toString('base64') }]);
  chat.send('Make the header look like this', { images });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(turns[0], [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
    { type: 'text', text: 'Make the header look like this' },
  ]);
  assert.equal(chat.items[0].detail, 'Shown to the AI: design.png');
  assert.ok(!JSON.stringify(chat.items).includes(PNG.toString('base64')), 'the picture itself is not kept in the chat list');
  chat.send('', { images }); // a picture alone is a message too
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turns[1][1].text, 'Look at the attached image.');
  chat.send('plain words');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turns[2], 'plain words');
});

// --- through the API ---------------------------------------------------------

async function openApp(t, gitops) {
  const home = tmpDir(t);
  const app = await createApp({ home, gitops, config: createConfig(home) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'X-Roadie-Token': app.token, Cookie: app.cookie };
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const put = async (query, bytes, headers = auth) => {
    const res = await fetch(`${base}/api/files/add?${new URLSearchParams(query)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
    return { status: res.status, data: await res.json() };
  };
  return { app, home, base, auth, call, put, siteDir: path.join(home, 'sites', 'acme', 'site') };
}

test('adding a file through the API puts it in the site, and only Roadie\'s own page may do it', async (t) => {
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, { 'index.html': '<h1>hi</h1>', 'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', '.env': 'A=1' }),
    listFiles: ['index.html', 'img/logo.svg'],
    ignored: (dir, paths) => new Set(paths.filter((p) => p.startsWith('dist/'))),
  });
  const { app, base, auth, call, put, siteDir } = await openApp(t, gitops);

  assert.equal((await put({ folder: 'img', name: 'a.png' }, PNG)).status, 400, 'no site open yet');
  await call('POST', '/api/open', { repo: 'acme/site' });
  await call('POST', '/api/preview/stop');

  assert.deepEqual((await call('GET', '/api/files/folders')).data, { folders: ['img', 'images'], suggested: 'img' });

  const added = await put({ folder: 'img', name: 'hero.png' }, PNG);
  assert.deepEqual(added, { status: 200, data: { path: 'img/hero.png', bytes: PNG.length, replaced: false, ignored: false } });
  assert.deepEqual(fs.readFileSync(path.join(siteDir, 'img', 'hero.png')), PNG);

  const again = await put({ folder: 'img', name: 'hero.png' }, JPEG);
  assert.equal(again.status, 400);
  assert.equal(again.data.exists, true);
  assert.equal((await put({ folder: 'img', name: 'hero.png', replace: '1' }, JPEG)).data.replaced, true);
  assert.equal((await put({ folder: 'dist', name: 'x.png' }, PNG)).data.ignored, true, 'says when .gitignore will leave the file out');

  for (const [query, why] of [
    [{ folder: '', name: '.env' }, /secrets file/],
    [{ folder: '.git/hooks', name: 'pre-push' }, /off limits/],
    [{ folder: '../..', name: 'x.png' }, /inside the site/],
    [{ folder: 'img', name: '' }, /Give the file a name/],
  ]) {
    const res = await put(query, PNG);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.match(res.data.error, why);
  }
  assert.equal(fs.readFileSync(path.join(siteDir, '.env'), 'utf8'), 'A=1');

  // Too big: refused whole, with the limit in words.
  const big = await put({ folder: 'img', name: 'big.bin' }, Buffer.alloc(25 * 1024 * 1024 + 10));
  assert.equal(big.status, 400);
  assert.match(big.data.error, /too large/i);
  assert.ok(!fs.existsSync(path.join(siteDir, 'img', 'big.bin')));

  // Without the token, or the cookie, nothing is written.
  assert.equal((await put({ folder: 'img', name: 'no-token.png' }, PNG, { Cookie: app.cookie })).status, 403);
  assert.equal((await put({ folder: 'img', name: 'no-cookie.png' }, PNG, { 'X-Roadie-Token': app.token })).status, 403);
  assert.ok(!fs.existsSync(path.join(siteDir, 'img', 'no-token.png')));

  // Pictures are shown back for the changed-files pane: pictures only, and in a form a browser will not run.
  const shown = await fetch(`${base}/api/file?path=${encodeURIComponent('img/logo.svg')}`, { headers: { Cookie: app.cookie } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/svg+xml');
  assert.match(shown.headers.get('content-security-policy'), /sandbox/);
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['index.html', '.env', '../../config.json', '.git/config', 'img/missing.png']) {
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent(p)}`, { headers: { Cookie: app.cookie } })).status, 404, p);
  }
  assert.equal((await fetch(`${base}/api/file?path=img/logo.svg`)).status, 403, 'not without the session cookie');
  assert.equal((await fetch(`${base}/api/file?path=img/logo.svg`, { headers: { Cookie: app.cookie, 'Sec-Fetch-Site': 'same-site' } })).status, 403, 'not as a picture on another page');
  assert.equal((await fetch(`${base}/api/file?path=img/logo.svg`, { headers: { Cookie: app.cookie, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await fetch(`${base}/api/file?path=img/logo.svg`, { headers: { ...auth, Origin: 'http://127.0.0.1:1' } })).status, 403, 'not for the previewed site');
});

// --- undoing one file, with real git -------------------------------------------

function repo(t, files) {
  const dir = tmpDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFiles(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { dir, git };
}

test('undoing one file puts it back as it was, keeps the rest, and the edits can be recovered', async (t) => {
  const ODD = process.platform === 'win32' ? 'img/[odd] name.png' : 'img/[odd] *name.png'; // Windows has no * in names
  const { dir, git } = repo(t, { 'index.html': '<h1>old</h1>\n', 'about.html': 'about\n', 'gone.txt': 'bye\n', 'old.txt': 'one\ntwo\nthree\n' });
  const base = git('rev-parse', 'HEAD').trim();
  const gitops = createGitOps();
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  const undo = async (name) => {
    const change = (await gitops.changes(dir, base)).find((c) => c.path === name);
    assert.ok(change, `${name} is listed as changed`);
    return gitops.restoreFile(dir, base, change);
  };
  const changed = async () => (await gitops.changes(dir, base)).map((c) => c.path);

  // Work on a change's branch: one edit already committed there, the rest not.
  git('switch', '-q', '-c', 'change/x');
  writeFiles(dir, { 'about.html': 'about, committed on the branch\n', 'committed-new.png': 'PNG' });
  git('add', '-A');
  git('commit', '-q', '-m', 'on the branch');
  writeFiles(dir, { 'index.html': '<h1>new</h1>\n', [ODD]: 'PNG2', 'about.html': 'about, edited again\n' });
  fs.rmSync(path.join(dir, 'gone.txt'));
  git('mv', 'old.txt', 'new.txt');
  assert.deepEqual(await changed(), ['about.html', 'committed-new.png', 'gone.txt', ODD, 'index.html', 'new.txt']);

  assert.deepEqual(await undo('index.html'), { stashed: true });
  assert.equal(read('index.html'), '<h1>old</h1>\n');
  assert.equal(read('about.html'), 'about, edited again\n', 'other files are untouched');

  await undo(ODD); // a new file is taken out; its odd name matches nothing else
  assert.ok(!fs.existsSync(path.join(dir, ODD)));
  assert.equal(read('about.html'), 'about, edited again\n');

  await undo('gone.txt');
  assert.equal(read('gone.txt'), 'bye\n');

  await undo('new.txt'); // a rename goes back to its old name
  assert.equal(read('old.txt'), 'one\ntwo\nthree\n');
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));

  await undo('about.html'); // back past the branch's own commit, to where the change began
  assert.equal(read('about.html'), 'about\n');
  assert.deepEqual(await undo('committed-new.png'), { stashed: false });
  assert.ok(!fs.existsSync(path.join(dir, 'committed-new.png')));

  assert.deepEqual(await changed(), [], 'the site is as it was before the change');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'change/x', 'still on the branch');
  assert.equal(git('log', '--oneline').trim().split('\n').length, 2, 'no commits were made or removed');

  // Every edit that was not committed is in git stash, newest first.
  const stash = git('stash', 'list');
  assert.match(stash, /roadie: undo index\.html/);
  assert.match(stash, /roadie: undo about\.html/);
  assert.match(git('stash', 'show', '-p', '--include-untracked', 'stash@{0}'), /about, edited again/);
});

test('in a repo with no commits yet, undo takes the file out, as there is nothing to go back to', async (t) => {
  const dir = tmpDir(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFiles(dir, { 'index.html': 'x', 'images/a.png': 'PNG' });
  const gitops = createGitOps();
  const change = (await gitops.changes(dir)).find((c) => c.path === 'images/a.png');
  assert.deepEqual(await gitops.restoreFile(dir, 'HEAD', change), { stashed: false });
  assert.ok(!fs.existsSync(path.join(dir, 'images', 'a.png')));
  assert.deepEqual((await gitops.changes(dir)).map((c) => c.path), ['index.html']);
});

test('undo through the API only touches a file that is listed as changed, and nothing else', async (t) => {
  const restored = [];
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, { 'index.html': '<h1>hi</h1>' }),
    changes: [{ path: 'index.html', from: null, status: 'modified', diff: '' }],
    restoreFile: (dir, base, change) => { restored.push([base, change.path]); return { stashed: true }; },
  });
  const { call } = await openApp(t, gitops);
  assert.equal((await call('POST', '/api/changes/undo', { path: 'index.html' })).status, 400, 'no site open yet');
  await call('POST', '/api/open', { repo: 'acme/site' });
  await call('POST', '/api/preview/stop');

  const other = await call('POST', '/api/changes/undo', { path: '../../.ssh/id_rsa' });
  assert.equal(other.status, 400);
  assert.match(other.data.error, /no changes to undo/);
  assert.deepEqual(restored, []);

  assert.deepEqual((await call('POST', '/api/changes/undo', { path: 'index.html' })).data, { ok: true, stashed: true });
  assert.deepEqual(restored, [['HEAD', 'index.html']]);
});

test('the file browser lists the site\'s files with sizes, and never a secret or a link out', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'index.html': '<h1>hi</h1>', 'images/logo.png': 'PNGDATA', '.env': 'KEY=1', 'docs/readme.md': 'x' });
  try { fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt')); } catch { /* Windows may not allow links; the file is then simply absent */ }
  const listed = browseFiles(dir, ['index.html', 'images/logo.png', '.env', 'innocent.txt', 'gone.txt', 'docs', '../outside.txt']);
  assert.deepEqual(listed, [{ path: 'images/logo.png', size: 7, image: true }, { path: 'index.html', size: 11, image: false }]);
});

test("right after the first commit the pane lists that commit's files, to read and not to undo", async (t) => {
  let uncommitted = [];
  const firstFiles = [{ path: 'index.html', from: null, status: 'added', diff: '+<h1>hi</h1>' }];
  const gitops = fakeGitOps({
    clone: (slug, dir) => writeFiles(dir, { 'index.html': '<h1>hi</h1>' }),
    changes: () => uncommitted,
    firstCommitFiles: () => firstFiles,
  });
  const { call } = await openApp(t, gitops);
  await call('POST', '/api/open', { repo: 'acme/site' });
  await call('POST', '/api/preview/stop');

  let data = (await call('GET', '/api/changes')).data;
  assert.equal(data.committed, 'first');
  assert.deepEqual(data.files.map((f) => f.path), ['index.html']);
  const undo = await call('POST', '/api/changes/undo', { path: 'index.html' });
  assert.equal(undo.status, 400);
  assert.match(undo.data.error, /no changes to undo/);

  // As soon as something is edited, the list is the edits again.
  uncommitted = [{ path: 'about.html', from: null, status: 'added', diff: '+x' }];
  data = (await call('GET', '/api/changes')).data;
  assert.equal(data.committed, null);
  assert.deepEqual(data.files.map((f) => f.path), ['about.html']);
});
