import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { applyTextEdit, cleanPick, editRequest, flexPattern, locateImage, newPage, pageFileName, pageFiles, pickContext, pickLabel, sitePages } from '../src/pageedit.js';
import { createPreviewProxy } from '../src/proxy.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

const HOME = `<!doctype html>
<html>
<head><title>Bakery</title></head>
<body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <h1>Bakery</h1>
  <p class="lead">
    Fresh bread &amp; cakes,
    baked every morning &copy; 2026.
  </p>
  <p>Open <strong>seven</strong> days a week.</p>
  <img src="/images/loaf.png" alt="Bakery">
  <footer>Home of good bread</footer>
</body>
</html>
`;

function siteWith(t, files) {
  const dir = tmpDir(t);
  writeFiles(dir, files);
  const list = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else list.push(r); } };
  walk(dir, '');
  return { dir, gitops: fakeGitOps({ listFiles: list.sort() }), read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}

test('page text is found however the file writes it', () => {
  const find = (text, source) => new RegExp(flexPattern(text)).test(source);
  assert.ok(find('Fresh bread & cakes, baked', 'Fresh bread &amp; cakes,\r\n    baked'));
  assert.ok(find('© 2026 – “Bakery”', '&copy; 2026 &ndash; &ldquo;Bakery&rdquo;'));
  assert.ok(find('© 2026', '&#169;&nbsp;2026'));
  assert.ok(find('a b', 'a&nbsp;b'));
  assert.ok(find('1 < 2 (yes?) [a] $5.00', '1 &lt; 2 (yes?) [a] $5.00'));
  assert.ok(!find('a.c', 'abc'), 'punctuation is literal');
  assert.ok(!find('Bakery', 'bakery'), 'letter case counts');
});

test('the files behind a page address', () => {
  const files = ['public/index.html', 'public/about.html', 'public/blog/index.html', 'docs/notes/index.html', 'README.md'];
  assert.deepEqual(pageFiles('/', files), ['public/index.html']);
  assert.deepEqual(pageFiles('/about?x=1#top', files), ['public/about.html']);
  assert.deepEqual(pageFiles('/blog/', files), ['public/blog/index.html']);
  assert.deepEqual(pageFiles('/blog', files), ['public/blog/index.html']);
  assert.deepEqual(pageFiles('/pricing', files), []);
});

test('a reworded heading is changed in the file, and only where the page text is', async (t) => {
  const { dir, gitops, read } = siteWith(t, { 'public/index.html': HOME, 'public/about.html': '<h1>About the Bakery</h1>\n', 'test/site.test.js': "assert.match(body, /Bakery/);\n" });
  const result = await applyTextEdit({ gitops, dir, page: '/', changes: [{ before: 'Bakery', after: 'The Corner Bakery', parent: 'h1', first: true, last: true }] });
  // A test that checks the old words is named, so the owner can ask the AI about it.
  assert.deepEqual(result, { ok: true, files: ['public/index.html'], alsoIn: ['test/site.test.js'] });
  const after = read('public/index.html');
  assert.match(after, /<h1>The Corner Bakery<\/h1>/);
  assert.match(after, /<title>Bakery<\/title>/, 'the title is a different piece of text');
  assert.match(after, /alt="Bakery"/, 'so is the alt text');
  assert.equal(after.replace('The Corner Bakery', 'Bakery'), HOME, 'nothing else in the file moved');
  assert.equal(read('public/about.html'), '<h1>About the Bakery</h1>\n');
});

test('only the changed words are rewritten: line breaks, indentation and entities around them stay', async (t) => {
  const { dir, gitops, read } = siteWith(t, { 'index.html': HOME.replace(/\n/g, '\r\n') });
  const before = '\n    Fresh bread & cakes,\n    baked every morning © 2026.\n  ';
  const result = await applyTextEdit({ gitops, dir, page: '/', changes: [{ before, after: before.replace('every morning', 'at dawn <daily>'), parent: 'p', first: true, last: true }] });
  assert.equal(result.ok, true);
  assert.equal(read('index.html'), HOME.replace('every morning', 'at dawn &lt;daily&gt;').replace(/\n/g, '\r\n'), 'Windows line endings and &amp; &copy; are as they were');
});

test('text beside an inline tag, and a space the browser made non-breaking', async (t) => {
  const { dir, gitops, read } = siteWith(t, { 'index.html': HOME });
  const result = await applyTextEdit({ gitops, dir, page: '/', changes: [
    { before: 'Open ', after: 'Open ', parent: 'p', first: true, last: false }, // unchanged in substance
    { before: 'seven', after: 'six', parent: 'strong', first: true, last: true },
    { before: ' days a week.', after: ' days a week, 7 till 5.', parent: 'p', first: false, last: true },
  ] });
  assert.equal(result.ok, true);
  assert.match(read('index.html'), /<p>Open <strong>six<\/strong> days a week, 7 till 5\.<\/p>/);
});

test('when the text is in more than one place, or nowhere, nothing is written', async (t) => {
  const twice = HOME.replace('<footer>', '<h1>Bakery</h1><footer>');
  const { dir, gitops, read } = siteWith(t, { 'index.html': twice, 'about.html': HOME, '.env': 'NAME=Bakery' });
  const many = await applyTextEdit({ gitops, dir, page: '/', changes: [{ before: 'Bakery', after: 'Cafe', parent: 'h1', first: true, last: true }] });
  assert.deepEqual(many, { ok: false, reason: 'many', files: ['about.html', 'index.html'] });
  assert.equal(read('index.html'), twice);

  const none = await applyTextEdit({ gitops, dir, page: '/', changes: [{ before: 'Made by a script', after: 'x', parent: 'p', first: true, last: true }] });
  assert.deepEqual(none, { ok: false, reason: 'none', files: [] });

  // Part of a sentence is not a piece of page text on its own.
  const part = await applyTextEdit({ gitops, dir, page: '/about', changes: [{ before: 'good bread', after: 'great bread', parent: 'footer', first: true, last: true }] });
  assert.equal(part.ok, false);
  assert.deepEqual(part.files, ['about.html', 'index.html'], 'but the files that hold those words are named for the AI');

  // Two changes, the second not found: the first is not written either.
  const half = await applyTextEdit({ gitops, dir, page: '/about', changes: [
    { before: 'Home of good bread', after: 'Home of great bread', parent: 'footer', first: true, last: true },
    { before: 'not there', after: 'x', parent: 'p', first: true, last: true },
  ] });
  assert.equal(half.ok, false);
  assert.equal(read('about.html'), HOME);
  assert.equal(read('.env'), 'NAME=Bakery');
  assert.deepEqual(await applyTextEdit({ gitops, dir, page: '/', changes: [] }), { ok: false, reason: 'unclear', files: [] });
  assert.deepEqual(await applyTextEdit({ gitops, dir, page: '/', changes: [{ before: '   ', after: 'x' }] }), { ok: false, reason: 'unclear', files: [] });
});

test('a page with no file of its own is edited where its text uniquely is, never in scripts or secrets', async (t) => {
  const outside = tmpDir(t);
  writeFiles(outside, { 'page.html': '<h2>Opening hours</h2>' });
  const { dir, gitops, read } = siteWith(t, {
    'views/hours.ejs': '<h2>Opening hours</h2>\n<p><%= hours %></p>\n',
    'server.js': "const title = 'Shop news';\n",
    'node_modules/pkg/readme.html': '<h2>Opening hours</h2>',
    'content/story.md': '# Our story\n\nWe began in 1990.\n',
  });
  try { fs.symlinkSync(path.join(outside, 'page.html'), path.join(dir, 'linked.html')); gitops.listFiles = async () => ['content/story.md', 'linked.html', 'node_modules/pkg/readme.html', 'server.js', 'views/hours.ejs']; } catch { /* no symlinks here */ }

  const ejs = await applyTextEdit({ gitops, dir, page: '/hours', changes: [{ before: 'Opening hours', after: 'When we are open', parent: 'h2', first: true, last: true }] });
  assert.deepEqual(ejs, { ok: true, files: ['views/hours.ejs'], alsoIn: [] });
  assert.match(read('views/hours.ejs'), /<h2>When we are open<\/h2>/);
  assert.equal(fs.readFileSync(path.join(outside, 'page.html'), 'utf8'), '<h2>Opening hours</h2>', 'a link out of the site is not followed');
  assert.equal(read('node_modules/pkg/readme.html'), '<h2>Opening hours</h2>');

  // Markdown has no tags round its text; < is still written safely.
  const md = await applyTextEdit({ gitops, dir, page: '/story', changes: [{ before: 'We began in 1990.', after: 'We began in 1990 & never stopped.', parent: 'p', first: true, last: true }] });
  assert.equal(md.ok, true);
  assert.match(read('content/story.md'), /We began in 1990 & never stopped\./);

  // Text that only lives in a script is the AI's job.
  const js = await applyTextEdit({ gitops, dir, page: '/', changes: [{ before: 'Shop news', after: 'Latest news', parent: 'h1', first: true, last: true }] });
  assert.equal(js.ok, false);
  assert.equal(read('server.js'), "const title = 'Shop news';\n");
});

test('what was clicked is tidied before it is used, and described to the AI', () => {
  assert.equal(cleanPick(null), null);
  assert.equal(cleanPick({ tag: '<script>' }).tag, 'script');
  assert.equal(cleanPick({ tag: '' }), null);
  const pick = cleanPick({ page: '/about', tag: 'H1', selector: 'main > h1', text: 'x'.repeat(500), html: '<h1>…</h1>', extra: 'dropped', image: { alt: 'A loaf', attr: '/images/loaf.png', path: '/images/loaf.png', file: 'public/images/loaf.png', more: 1 } });
  assert.equal(pick.text.length, 200);
  assert.equal(pick.extra, undefined);
  assert.deepEqual(Object.keys(pick.image), ['alt', 'attr', 'path', 'file']);
  assert.equal(pickLabel(pick), 'Pointing at the image public/images/loaf.png on /about');
  assert.equal(pickLabel(cleanPick({ page: '/', tag: 'h1', text: 'Bakery' })), 'Pointing at <h1> “Bakery” on /');
  const context = pickContext(pick);
  assert.match(context, /Page address: \/about/);
  assert.match(context, /CSS path: main > h1/);
  assert.match(context, /The image file in the site: public\/images\/loaf\.png/);

  assert.equal(locateImage(['public/images/loaf.png', 'docs/old/images/loaf.png', 'index.html'], '/images/loaf.png?v=2'), 'public/images/loaf.png');
  assert.equal(locateImage(['a/images/loaf.png', 'b/images/loaf.png'], '/images/loaf.png'), null, 'two candidates: not guessed');
  assert.equal(locateImage(['images/loaf.png'], '/images/../.env'), null);
  assert.equal(locateImage(['.env'], '/.env'), null);

  const ask = editRequest({ where: pick, beforeText: 'Old "words"', afterText: 'New words', result: { reason: 'many', files: ['index.html'] } });
  assert.equal(ask.text, 'On /about, change the text of the <h1> element (CSS path: main > h1) from "Old \\"words\\"" to "New words". Change only that element.');
  assert.match(ask.why, /more than one place, so Roadie has not changed any file/);
});

test('the page script is served to the preview and only acts for Roadie', async (t) => {
  const proxy = createPreviewProxy({ getTarget: () => null });
  const port = await proxy.listen(0);
  t.after(() => proxy.close());
  const script = await (await fetch(`http://127.0.0.1:${port}/__roadie/reload.js`)).text();
  assert.match(script, /e\.source !== parent/, 'it takes orders from the window that frames it, and no other');
  assert.match(script, /if \(parent === window\) return;/, 'and does nothing more when the page is opened on its own');
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|innerHTML = (?!e\.html)/, 'it reports; it does not send or rewrite anything itself');
});

test('edits from the page go through the API: applied when clear, handed to the AI when not', async (t) => {
  const { z } = await import('zod');
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
  const gitops = fakeGitOps({ clone: (slug, dir) => writeFiles(dir, { 'index.html': HOME, 'images/loaf.png': 'PNG' }), listFiles: ['images/loaf.png', 'index.html'] });
  const home = tmpDir(t);
  const app = await createApp({ home, gitops, config: createConfig(home), agentSdk: async () => ({ sdk, z }) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const where = { page: '/', tag: 'h1', selector: 'body > h1', text: 'Bakery' };
  assert.equal((await call('POST', '/api/edit/text', { where, changes: [] })).status, 400, 'no site open yet');
  await call('POST', '/api/open', { repo: 'acme/site' });
  await call('POST', '/api/preview/stop');
  const file = path.join(home, 'sites', 'acme', 'site', 'index.html');

  const done = await call('POST', '/api/edit/text', { where, changes: [{ before: 'Bakery', after: 'Bread Shop', parent: 'h1', first: true, last: true }], beforeText: 'Bakery', afterText: 'Bread Shop' });
  assert.deepEqual(done.data, { ok: true, files: ['index.html'], alsoIn: [] });
  assert.match(fs.readFileSync(file, 'utf8'), /<h1>Bread Shop<\/h1>/);

  const nav = { page: '/', tag: 'a', selector: 'nav > a', text: 'Home' };
  const unclear = await call('POST', '/api/edit/text', { where: nav, changes: null, beforeText: 'Home About', afterText: 'Start About' });
  assert.equal(unclear.status, 200);
  assert.equal(unclear.data.ok, false);
  assert.match(unclear.data.ask.text, /^On \/, change the text of the <a> element \(CSS path: nav > a\) from "Home About" to "Start About"/);
  assert.equal((await call('POST', '/api/edit/text', { where: { tag: '' }, changes: [] })).status, 400);

  assert.deepEqual((await call('POST', '/api/edit/locate', { path: '/images/loaf.png' })).data, { file: 'images/loaf.png' });
  assert.deepEqual((await call('POST', '/api/edit/locate', { path: '/../../etc/passwd' })).data, { file: null });

  // Pointing travels with a chat message as background, and shows as one line in the chat.
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  assert.equal((await call('POST', '/api/chat/send', { text: 'Make this bigger', pick: where })).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(turns[0], /^Make this bigger\n\n<background from="Roadie">\nThe owner clicked an element in the live preview/);
  assert.match(turns[0], /CSS path: body > h1/);
  const { chat } = (await call('GET', '/api/state')).data;
  assert.deepEqual([chat.items[0].text, chat.items[0].detail], ['Make this bigger', 'Pointing at <h1> “Bakery” on /']);
});

test('the pages of a site are listed as preview addresses, home first', () => {
  const files = ['README.md', 'server.js', 'public/index.html', 'public/about.html', 'public/blog/index.html', 'public/blog/first post.html',
    'public/css/styles.css', 'public/404.html', 'node_modules/x/index.html', 'docs/index.html', '.github/page.html', 'public/dist/built.html'];
  assert.deepEqual(sitePages(files), [
    { path: '/', file: 'public/index.html' },
    { path: '/404.html', file: 'public/404.html' },
    { path: '/about.html', file: 'public/about.html' },
    { path: '/blog/', file: 'public/blog/index.html' },
    { path: '/blog/first%20post.html', file: 'public/blog/first post.html' },
  ]);
  // A site kept at the top of the repo.
  assert.deepEqual(sitePages(['index.html', 'contact.htm', 'js/app.js']).map((p) => p.path), ['/', '/contact.htm']);
  // No home page: every page is still offered.
  assert.deepEqual(sitePages(['pages/a.html']).map((p) => p.path), ['/pages/a.html']);
  assert.deepEqual(sitePages([]), []);
});

test('a new page is a copy of an existing one, with its own title, and never replaces a file', (t) => {
  const dir = tmpDir(t);
  const home = '<!doctype html>\n<title>Bakery</title>\n<nav><a href="/">Home</a></nav>\n<h1 class="big">Bakery</h1>\n<h1>second</h1>\n';
  writeFiles(dir, { 'public/index.html': home, 'public/about.html': '<title>About</title><h1>About</h1>', 'public/blog/index.html': '<title>Blog</title>', '.env': 'KEY=1' });
  const files = ['public/index.html', 'public/about.html', 'public/blog/index.html'];

  assert.equal(pageFileName('Our Story'), 'our-story.html');
  assert.equal(pageFileName('Café & Bar.HTM'), 'cafe-bar.htm');
  assert.throws(() => pageFileName(' !! '), /Give the page a name/);

  const made = newPage({ dir, files, from: 'public/index.html', name: 'Our Story', title: 'Our <story> & more' });
  assert.deepEqual(made, { file: 'public/our-story.html', path: '/our-story.html', from: 'public/index.html' });
  const text = fs.readFileSync(path.join(dir, 'public/our-story.html'), 'utf8');
  assert.match(text, /<title>Our &lt;story&gt; &amp; more<\/title>/);
  assert.match(text, /<h1 class="big">Our &lt;story&gt; &amp; more<\/h1>\n<h1>second<\/h1>/, 'only the first heading changes');
  assert.match(text, /<nav><a href="\/">Home<\/a><\/nav>/, 'the rest is the same');
  assert.equal(fs.readFileSync(path.join(dir, 'public/index.html'), 'utf8'), home, 'the page copied is untouched');

  // By address as well as by file; a page in a folder gets its copy in that folder.
  assert.equal(newPage({ dir, files, from: '/blog/', name: 'first', title: '' }).file, 'public/blog/first.html');
  assert.throws(() => newPage({ dir, files, from: 'public/index.html', name: 'about', title: 'x' }), /already exists/);
  assert.throws(() => newPage({ dir, files, from: '.env', name: 'x', title: 'x' }), /Choose one of the site's pages/);
  // A name cannot climb out of the folder: the dots and slashes are dropped.
  assert.equal(newPage({ dir, files, from: 'public/index.html', name: '../../up', title: 'x' }).file, 'public/up.html');
  assert.equal(fs.existsSync(path.join(dir, 'up.html')), false);
});
