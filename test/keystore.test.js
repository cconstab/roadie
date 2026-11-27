import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { cleanKey, createKeyStore, keyEnding } from '../src/keystore.js';
import { fakeGitOps, tmpDir } from './helpers.js';

const KEY = 'sk-ant-api03-' + 'abcdefghij0123456789' + '-WXYZ';

// Stands in for the system tools. Records every command line, so the tests can
// check the key never appears on one.
function fakeTools() {
  const lines = [];
  let kept = null;
  const run = async (cmd, args, { input = '' } = {}) => {
    lines.push([cmd, ...args].join(' '));
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (cmd.endsWith('security')) {
      if (args[0] === '-i') { kept = input.trim().split(' ').at(-1); return ok(); }
      if (args[0] === 'find-generic-password') return kept ? ok(kept + '\n') : { code: 44, stdout: '', stderr: 'could not be found' };
      if (args[0] === 'delete-generic-password') { kept = null; return ok(); }
    }
    if (cmd === 'powershell.exe') {
      const script = args.at(-1);
      const pad = 'x'.repeat(80); // real sealed text is much longer than the key
      if (script.includes('::Protect(')) return ok(Buffer.from(`sealed:${pad}:${input.trim()}`).toString('base64') + '\r\n');
      return ok(Buffer.from(input.trim(), 'base64').toString().replace(`sealed:${pad}:`, '') + '\r\n');
    }
    if (cmd === 'secret-tool') {
      if (args[0] === 'store') { kept = input; return ok(); }
      if (args[0] === 'lookup') return kept ? ok(kept) : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') { kept = null; return ok(); }
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { run, lines };
}

test('a key is checked before it goes anywhere, and only its ending is ever shown', () => {
  assert.equal(cleanKey(`  ${KEY}\n`), KEY);
  assert.throws(() => cleanKey(''), /Paste the API key/);
  assert.throws(() => cleanKey('sk-ant-short'), /does not look like/);
  assert.throws(() => cleanKey(`${KEY}"; rm -rf ~`), /does not look like/);
  assert.throws(() => cleanKey(`${KEY}\nadd-generic-password`), /does not look like/);
  assert.equal(keyEnding(KEY), '…WXYZ');
  assert.equal(keyEnding(null), '');
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`on ${platform} the key is stored, read back and removed without ever being on a command line`, async (t) => {
    const home = tmpDir(t);
    const tools = fakeTools();
    const store = createKeyStore({ home, platform, run: tools.run });
    assert.equal(await store.get(), null);
    await store.set(KEY);
    assert.equal(await store.get(), KEY);
    await assert.rejects(store.set('not a key'), /does not look like/);
    assert.equal(await store.get(), KEY, 'a refused key changes nothing');
    assert.ok(tools.lines.length > 0);
    assert.ok(!tools.lines.join('\n').includes(KEY), 'the key is passed on standard input only');
    for (const name of fs.readdirSync(home)) {
      assert.ok(!fs.readFileSync(path.join(home, name), 'utf8').includes(KEY), `${name} does not hold the key in the clear`);
    }
    await store.remove();
    assert.equal(await store.get(), null);
  });
}

test('on Windows, anything but sealed text from PowerShell is refused and not written down', async (t) => {
  const home = tmpDir(t);
  const store = createKeyStore({ home, platform: 'win32', run: async (cmd, args, { input }) => ({ code: 0, stdout: input, stderr: '' }) });
  await assert.rejects(store.set(KEY), /could not protect the key/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('on Linux with no keyring tool, saving says so plainly', async () => {
  const store = createKeyStore({ platform: 'linux', run: async () => ({ code: -1, stdout: '', stderr: 'spawn secret-tool ENOENT', missing: true }) });
  assert.equal(await store.get(), null);
  await assert.rejects(store.set(KEY), /no keyring tool.*Set ANTHROPIC_API_KEY/s);
});

test('through the app: a pasted key is stored and used, never sent back, and can be removed', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved) process.env.ANTHROPIC_API_KEY = saved; else delete process.env.ANTHROPIC_API_KEY; });

  let kept = null;
  const keystore = { where: 'a test store', get: async () => kept, set: async (k) => { kept = k; }, remove: async () => { kept = null; } };
  const open = async () => {
    const home = tmpDir(t);
    const app = await createApp({ home, gitops: fakeGitOps(), config: createConfig(home), keystore });
    const port = await app.listen(0);
    const headers = { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' };
    const call = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, text: await res.text() };
    };
    return { app, call };
  };

  let { app, call } = await open();
  let state = JSON.parse((await call('GET', '/api/state')).text);
  assert.equal(state.ai.status.ready, false);
  assert.match(state.ai.status.problem, /paste one into AI settings.*ANTHROPIC_API_KEY/);
  assert.deepEqual(state.ai.key, { canStore: true, where: 'a test store', stored: false, ending: '', fromEnv: false, problem: null });

  const bad = await call('POST', '/api/ai/key', { key: 'hello' });
  assert.equal(bad.status, 400);
  assert.equal(kept, null);

  const ok = await call('POST', '/api/ai/key', { key: ` ${KEY} ` });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes(KEY), 'the answer never carries the key');
  state = JSON.parse(ok.text);
  assert.equal(state.ai.status.ready, true);
  assert.equal(state.ai.key.stored, true);
  assert.equal(state.ai.key.ending, '…WXYZ');
  assert.equal(kept, KEY);
  assert.equal(process.env.ANTHROPIC_API_KEY, KEY);
  assert.ok(!(await call('GET', '/api/state')).text.includes(KEY));

  // Closing Roadie takes the key out of the process; starting again finds it in the store.
  await app.close();
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  ({ app, call } = await open());
  t.after(() => app.close());
  state = JSON.parse((await call('GET', '/api/state')).text);
  assert.equal(state.ai.status.ready, true);
  assert.equal(state.ai.key.ending, '…WXYZ');

  state = JSON.parse((await call('POST', '/api/ai/key/remove')).text);
  assert.equal(kept, null);
  assert.equal(state.ai.status.ready, false);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});

test('a key in the environment wins, and a stored one does not replace it', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-from-the-environment';
  t.after(() => { if (saved) process.env.ANTHROPIC_API_KEY = saved; else delete process.env.ANTHROPIC_API_KEY; });
  const home = tmpDir(t);
  const app = await createApp({ home, gitops: fakeGitOps(), config: createConfig(home), keystore: { where: 'x', get: async () => KEY, set: async () => {}, remove: async () => {} } });
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-from-the-environment');
  await app.close();
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-from-the-environment');
});

// The real thing, where it can be tried without touching anything shared: on
// Windows the sealed key lives in a file under the given folder.
test('on a real Windows machine, PowerShell seals the key and gives it back', { skip: process.platform !== 'win32' }, async (t) => {
  const home = tmpDir(t);
  const store = createKeyStore({ home });
  assert.equal(await store.get(), null);
  await store.set(KEY);
  const onDisk = fs.readFileSync(path.join(home, 'anthropic-key.protected'), 'utf8');
  assert.ok(!onDisk.includes(KEY));
  assert.match(onDisk.trim(), /^[A-Za-z0-9+\/=]+$/);
  assert.equal(await store.get(), KEY);
  await store.remove();
  assert.equal(await store.get(), null);
});
