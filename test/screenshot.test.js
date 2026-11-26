import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { SIZES, browserArgs, browserCandidates, capturePage, cleanPagePath, findBrowser } from '../src/screenshot.js';
import { sniffImage } from '../src/uploads.js';

test('a browser is found on each system, or not at all', () => {
  const mac = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  assert.equal(findBrowser({ platform: 'darwin', env: { HOME: '/Users/x' }, exists: (f) => f === mac }), mac);
  const win = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findBrowser({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' }, exists: (f) => f === win }), win);
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin:/snap/bin' }, exists: (f) => f === '/snap/bin/chromium' }), '/snap/bin/chromium');
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), null);
  // The owner can name one; a wrong name is not silently replaced by another browser.
  assert.equal(findBrowser({ platform: 'darwin', env: { ROADIE_BROWSER: '/opt/b' }, exists: (f) => f === '/opt/b' }), '/opt/b');
  assert.equal(findBrowser({ platform: 'darwin', env: { ROADIE_BROWSER: '/missing' }, exists: (f) => f !== '/missing' }), null);
  assert.ok(browserCandidates('darwin', {}).length > 3);
});

test('only a path inside the site is ever shown', () => {
  assert.equal(cleanPagePath(), '/');
  assert.equal(cleanPagePath('about.html'), '/about.html');
  assert.equal(cleanPagePath('/blog/?page=2'), '/blog/?page=2');
  assert.equal(cleanPagePath('https://example.com/x?y=1'), '/x?y=1', 'another website is cut down to its path');
  assert.equal(cleanPagePath('//example.com/x'), '/example.com/x');
  assert.throws(() => cleanPagePath('/a b'), /not a usable page address/);
  assert.throws(() => cleanPagePath('/a\\b'), /not a usable page address/);
});

test('the browser is told to reach this machine only', () => {
  const args = browserArgs({ url: 'http://127.0.0.1:8080/', out: '/tmp/o.png', profile: '/tmp/p', width: 390, height: 1400 });
  assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE [::1]'));
  assert.ok(args.includes('--window-size=390,1400'));
  assert.ok(args.includes('--user-data-dir=/tmp/p'), "a throwaway profile, never the owner's own");
  assert.equal(args.at(-1), 'http://127.0.0.1:8080/');
});

test('taking the picture: plain errors, and the temporary files are removed', async () => {
  await assert.rejects(capturePage({ base: null, browser: '/b' }), /not running/);
  await assert.rejects(capturePage({ base: 'http://127.0.0.1:1', browser: null }), /No Chrome, Edge/);
  let seen;
  const shot = await capturePage({
    base: 'http://127.0.0.1:8080', page: 'https://evil.example/about.html', size: 'phone', browser: '/b',
    runImpl: async (cmd, args) => { seen = { cmd, args }; fs.writeFileSync(args.find((a) => a.startsWith('--screenshot=')).slice(13), 'PNG'); return { code: 0, stderr: '' }; },
  });
  assert.equal(seen.cmd, '/b');
  assert.equal(seen.args.at(-1), 'http://127.0.0.1:8080/about.html', 'always the local site');
  assert.deepEqual([shot.png.toString(), shot.width, shot.height], ['PNG', SIZES.phone.width, SIZES.phone.height]);
  assert.equal(fs.existsSync(seen.args.find((a) => a.startsWith('--screenshot=')).slice(13)), false);
  await assert.rejects(capturePage({ base: 'http://127.0.0.1:8080', browser: '/b', runImpl: async () => ({ code: 1, stderr: 'boom\n' }) }), /did not produce a picture of \/: boom/);
});

test('a real browser takes a real picture of a local page', { skip: !findBrowser() && 'no Chrome or Edge on this machine' }, async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<body style="background:#0a0"><h1>Hello</h1><img src="http://example.invalid/x.png"></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const shot = await capturePage({ base: `http://127.0.0.1:${server.address().port}`, size: 'phone' });
  assert.equal(sniffImage(shot.png), 'image/png');
  assert.ok(shot.png.length > 1000);
});
