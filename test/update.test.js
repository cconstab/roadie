// Finding out about a newer Roadie, installing it on request, and the
// installer's check for the other tools Roadie needs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { applyUpdate, checkForUpdate, installInfo, isNewer, latestRelease, updatePlan } from '../src/update.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

const pointsAt = (tag) => async (url, opts) => {
  assert.equal(url, 'https://github.com/cconstab/roadie/releases/latest');
  assert.equal(opts.redirect, 'manual', 'only the address is read; nothing is downloaded');
  return { headers: new Headers(tag ? { location: `https://github.com/cconstab/roadie/releases/tag/${tag}` } : {}) };
};

test('a release is newer only when its version really is later', () => {
  assert.equal(isNewer('v0.2.0', 'v0.1.9'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true, 'with or without the v');
  assert.equal(isNewer('v0.1.10', 'v0.1.9'), true, 'numbers, not text');
  assert.equal(isNewer('v0.1.0', 'v0.1.0'), false);
  assert.equal(isNewer('v0.1.0', 'v0.2.0'), false);
  assert.equal(isNewer('nightly', 'v0.1.0'), false);
  assert.equal(isNewer('v0.2.0', ''), false);
});

test('an installed copy and a copy run from source are told apart', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'VERSION': 'roadie v0.3.1\nnode v24.0.0\nmacos-arm64\n', 'app/package.json': { version: '9.9.9' }, 'source/package.json': { version: '0.3.0' } });
  assert.deepEqual(installInfo(path.join(dir, 'app')), { installed: true, dir, appDir: path.join(dir, 'app'), version: 'v0.3.1' });
  const source = installInfo(path.join(dir, 'source', '.'));
  assert.equal(source.installed, true, 'a VERSION file one level up marks an install');
  const plain = tmpDir(t);
  writeFiles(plain, { 'repo/package.json': { version: '0.3.0' } });
  assert.deepEqual(installInfo(path.join(plain, 'repo')), { installed: false, dir: null, appDir: path.join(plain, 'repo'), version: '0.3.0' });
});

test('the check reads only the address of the newest release, and can be turned off', async () => {
  assert.equal(await latestRelease({ fetchImpl: pointsAt('v0.4.0') }), 'v0.4.0');
  assert.equal(await latestRelease({ fetchImpl: pointsAt(null) }), null, 'no release yet');
  assert.equal(await latestRelease({ fetchImpl: async () => { throw new Error('offline'); } }), null);

  const info = { installed: true, dir: '/opt/roadie', appDir: '/opt/roadie/app', version: 'v0.3.0' };
  const found = await checkForUpdate({ info, fetchImpl: pointsAt('v0.4.0'), env: {} });
  assert.equal(found.latest, 'v0.4.0');
  assert.equal(found.current, 'v0.3.0');
  assert.match(found.how, /download v0\.4\.0 from GitHub, check it .* replace the copy in \/opt\/roadie, and stop/);
  assert.equal(await checkForUpdate({ info, fetchImpl: pointsAt('v0.3.0'), env: {} }), null, 'already current');
  assert.equal(await checkForUpdate({ info, fetchImpl: async () => assert.fail('must not ask'), env: { ROADIE_NO_UPDATE_CHECK: '1' } }), null);

  const fromSource = await checkForUpdate({ info: { installed: false, dir: null, version: '0.3.0' }, fetchImpl: pointsAt('v0.4.0'), env: {} });
  assert.match(fromSource.how, /git pull/);
});

test('an update is the installer, told which release and which folder', () => {
  const info = { installed: true, dir: '/opt/roadie', appDir: '/opt/roadie/app', version: 'v0.3.0' };
  const unix = updatePlan({ info, tag: 'v0.4.0', platform: 'darwin' });
  assert.equal(unix.cmd, '/bin/sh');
  assert.deepEqual(unix.args, ['/opt/roadie/app/scripts/install.sh']);
  assert.deepEqual(unix.env, { ROADIE_VERSION: 'v0.4.0', ROADIE_INSTALL_DIR: '/opt/roadie', ROADIE_INSTALL_DEPS: 'no', ROADIE_NO_LINK: '1' });
  assert.equal(unix.afterExit, false);

  const win = updatePlan({ info, tag: 'v0.4.0', platform: 'win32', pid: 321, tmp: 'C:\\Temp' });
  assert.equal(win.afterExit, true, 'Windows cannot replace a running program');
  assert.equal(win.cmd, 'powershell');
  assert.match(win.args.at(-1), /^Wait-Process -Id 321 /);
  assert.match(win.copy.to, /roadie-update-321\.ps1$/);

  assert.throws(() => updatePlan({ info, tag: 'v0.4.0; rm -rf ~' }), /does not look like a release version/);
  assert.throws(() => updatePlan({ info: { installed: false }, tag: 'v0.4.0' }), /runs from source/);
});

test('a failed update says so and leaves the reason; a good one says to start again', async () => {
  const info = { installed: true, dir: '/opt/roadie', appDir: '/opt/roadie/app', version: 'v0.3.0' };
  const spawnWith = (code, text) => (cmd, args, opts) => {
    assert.equal(opts.env.ROADIE_VERSION, 'v0.4.0');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stderr.emit('data', text); child.emit('close', code); });
    return child;
  };
  const good = await applyUpdate({ info, tag: 'v0.4.0', platform: 'linux', spawnImpl: spawnWith(0, '') });
  assert.match(good.message, /v0\.4\.0 is installed.*start it again/);
  await assert.rejects(
    applyUpdate({ info, tag: 'v0.4.0', platform: 'linux', spawnImpl: spawnWith(1, "The download does not match the release's checksum, so nothing was installed.\n") }),
    /update failed, and the installed copy was left as it was[\s\S]*does not match the release's checksum/,
  );
});

test('the window is told about a newer release, and only its button installs it', async (t) => {
  const home = tmpDir(t);
  const asked = [];
  let stopped = 0;
  const updater = {
    check: async () => ({ current: 'v0.3.0', latest: 'v0.4.0', installed: true, dir: '/opt/roadie', url: 'https://example.invalid', how: 'how' }),
    apply: async (tag) => { asked.push(tag); return { message: `Roadie ${tag} is installed.` }; },
    stop: () => { stopped++; },
  };
  const app = await createApp({ home, gitops: fakeGitOps(), config: createConfig(home), updater });
  const port = await app.listen(0);
  t.after(() => app.close());
  const call = async (method, p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie } });
    return { status: res.status, data: await res.json() };
  };
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await call('GET', '/api/state')).data.update.latest, 'v0.4.0');
  assert.deepEqual(asked, [], 'finding an update installs nothing');

  const noToken = await fetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST' });
  assert.ok(noToken.status >= 400);
  assert.deepEqual(asked, []);

  const done = await call('POST', '/api/update');
  assert.equal(done.status, 200);
  assert.match(done.data.message, /v0\.4\.0 is installed/);
  assert.deepEqual(asked, ['v0.4.0']);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(stopped, 1, 'Roadie stops after updating');
  assert.equal((await call('POST', '/api/update')).status >= 400, true, 'nothing left to install');
});

test('without an updater (tests, or no newer release) there is nothing to install', async (t) => {
  const home = tmpDir(t);
  const app = await createApp({ home, gitops: fakeGitOps(), config: createConfig(home) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const res = await fetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST', headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie } });
  assert.ok(res.status >= 400);
  assert.match((await res.json()).error, /no update/);
});

// --- the installer's look for the other tools ------------------------------------

const INSTALL_SH = new URL('../scripts/install.sh', import.meta.url).pathname;

test('the installer offers to install missing tools, shows the command, and obeys yes and no', { skip: process.platform === 'win32' && 'install.sh is for macOS and Linux' }, (t) => {
  const dir = tmpDir(t);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'log');
  // A pretend package manager that records what it was asked for, and a pretend git.
  writeFiles(dir, {
    'bin/brew': `#!/bin/sh\necho "brew $*" >> "${log}"\n`,
    'bin/git': '#!/bin/sh\n[ "$1" = config ] && echo "Someone"\nexit 0\n',
  });
  fs.chmodSync(path.join(bin, 'brew'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  // Only the pretend tools and the basic system ones: no real gh.
  const tools = path.join(dir, 'sys');
  fs.mkdirSync(tools);
  for (const name of ['sh', 'uname', 'sed', 'awk', 'head', 'cat', 'printf', 'echo']) {
    for (const from of ['/bin', '/usr/bin']) if (fs.existsSync(`${from}/${name}`)) { fs.symlinkSync(`${from}/${name}`, path.join(tools, name)); break; }
  }
  const run = (deps) => execFileSync('/bin/sh', [INSTALL_SH, '--check'], { env: { HOME: dir, PATH: `${bin}:${tools}`, ROADIE_INSTALL_DEPS: deps }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

  const declined = run('no');
  assert.match(declined, /missing: gh/);
  assert.match(declined, /To install: brew install gh/);
  assert.match(declined, /git: found/);
  assert.match(declined, /set ANTHROPIC_API_KEY/);
  assert.ok(!fs.existsSync(log), 'nothing was installed without a yes');

  const accepted = run('yes');
  assert.match(accepted, /Running: brew install gh/);
  assert.equal(fs.readFileSync(log, 'utf8'), 'brew install gh\n');
});
