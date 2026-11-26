import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  ALLOWED_TOOLS, NO_CHANGE_NOTE, STANDING_INSTRUCTIONS, TOOL_ALIASES, agentEnv, agentOptions, aiStatus, checkToolUse, createChat, globToRegExp, searchFiles,
} from '../src/agent.js';
import { cleanAi, createConfig } from '../src/config.js';
import { isSecretPath } from '../src/guards.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

const CLAUDE = cleanAi({ provider: 'anthropic', model: 'claude-test' });
const OLLAMA = cleanAi({ provider: 'ollama', ollamaUrl: 'http://localhost:11434/', ollamaModel: 'qwen-test' });

// A stand-in for the Agent SDK. `script(text)` returns the messages to answer a user turn with.
function fakeSdk(script = () => []) {
  const sdk = {
    queries: [],
    interrupts: 0,
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (o) => ({ type: 'sdk', name: o.name, tools: o.tools }),
    query({ prompt, options }) {
      sdk.queries.push(options);
      const it = (async function* () {
        for await (const turn of prompt) {
          for (const m of script(turn.message.content)) yield m;
        }
      })();
      it.interrupt = async () => { sdk.interrupts++; };
      it.close = () => {};
      return it;
    },
  };
  return sdk;
}

function site(t, files = { 'index.html': '<h1>hi</h1>' }) {
  const dir = tmpDir(t);
  writeFiles(dir, files);
  return { dir, settings: { test: 'npm test' } };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('secret-looking file names are recognised, examples are not', () => {
  for (const name of ['.env', '.env.local', 'config/.env.production', 'server.pem', 'deploy/id_rsa', '.npmrc', 'secrets.json', 'credentials']) {
    assert.equal(isSecretPath(name), true, name);
  }
  for (const name of ['.env.example', '.env.staging.example', 'env.js', 'index.html', 'keys.md', 'secrets.example']) {
    assert.equal(isSecretPath(name), false, name);
  }
});

test('the AI may only touch files inside the site, and never .git or secrets', (t) => {
  const { dir } = site(t, { 'index.html': 'x', 'css/a.css': 'y', '.env': 'KEY=1', '.env.example': 'KEY=', '.git/config': '[core]' });
  const outside = tmpDir(t);
  writeFiles(outside, { 'private.txt': 'no' });
  fs.symlinkSync(outside, path.join(dir, 'sneaky'));
  fs.symlinkSync(path.join(outside, 'gone'), path.join(dir, 'dangling'));

  const allowed = ['index.html', 'css/a.css', path.join(dir, 'index.html'), 'new/folder/page.html', '.env.example', '.github/workflows/test.yml'];
  for (const p of allowed) {
    for (const tool of ['Read', 'Edit', 'Write']) assert.equal(checkToolUse(dir, tool, { file_path: p }), null, `${tool} ${p}`);
  }

  const refused = {
    '../outside.txt': /outside the site folder/,
    '/etc/passwd': /outside the site folder/,
    [path.join(os.homedir(), '.ssh/id_rsa')]: /outside the site folder/,
    'css/../../escape.txt': /outside the site folder/,
    'sneaky/private.txt': /outside the site folder/,
    'dangling': /broken link|outside the site folder/,
    '.git/config': /\.git folder is off limits/,
    '.git/hooks/pre-commit': /\.git folder is off limits/,
    '.env': /secrets file/,
    'config/.env.production': /secrets file/,
  };
  for (const [p, why] of Object.entries(refused)) {
    for (const tool of ['Read', 'Edit', 'Write']) assert.match(checkToolUse(dir, tool, { file_path: p }) || '', why, `${tool} ${p}`);
  }
  assert.match(checkToolUse(dir, 'Write', {}), /No file path/);
});

test('tools outside the short list are refused by name', (t) => {
  const { dir } = site(t);
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit', 'Glob', 'Grep', 'mcp__github__create_pull_request', 'mcp__roadie__push']) {
    assert.match(checkToolUse(dir, tool, { command: 'git push' }), /not available here/, tool);
  }
  for (const tool of ['mcp__roadie__list_files', 'mcp__roadie__search_files', 'mcp__roadie__run_tests', 'list_files']) {
    assert.equal(checkToolUse(dir, tool, {}), null, tool);
  }
});

test('a slightly wrong tool name is sent to the real tool, under the same checks', async (t) => {
  const s = site(t);
  const options = agentOptions({ sdk: fakeSdk(), z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}) });
  assert.equal(options.toolAliases, TOOL_ALIASES);
  // Seen from a local model: Roadie's prefix put on a built-in tool.
  for (const [wrong, right] of [['mcp__roadie__read', 'Read'], ['mcp__roadie__edit', 'Edit'], ['mcp__roadie__write', 'Write'], ['read_file', 'Read'], ['mcp__roadie__write_file', 'Write'], ['run_tests', 'mcp__roadie__run_tests']]) {
    assert.equal(TOOL_ALIASES[wrong], right, wrong);
  }
  // An alias only ever leads to a tool on the allowed list: none opens a new door.
  for (const [wrong, right] of Object.entries(TOOL_ALIASES)) assert.ok(ALLOWED_TOOLS.includes(right), `${wrong} -> ${right}`);
  // Whichever name the hook is shown, the path rules are the same.
  assert.equal(checkToolUse(s.dir, 'mcp__roadie__read', { file_path: 'index.html' }), null);
  assert.match(checkToolUse(s.dir, 'mcp__roadie__read', { file_path: '.env' }), /secret/i);
  assert.match(checkToolUse(s.dir, 'mcp__roadie__write', { file_path: '/tmp/elsewhere.txt' }), /outside|inside/i);
  assert.match(checkToolUse(s.dir, 'mcp__roadie__read', {}), /./, 'no path, no reading');
  assert.match(checkToolUse(s.dir, 'constructor', {}), /not available here/);
});

test('the options handed to the SDK lock the agent down', async (t) => {
  const s = site(t);
  const sdk = fakeSdk();
  const options = agentOptions({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}) });

  assert.equal(options.cwd, s.dir);
  assert.deepEqual(options.tools, ['Read', 'Edit', 'Write'], 'no shell, web or subagent tools exist for the model');
  assert.deepEqual(options.allowedTools, ALLOWED_TOOLS);
  assert.ok(!options.allowedTools.some((name) => /bash|web|git|agent|task/i.test(name)));
  assert.equal(options.permissionMode, 'dontAsk');
  assert.deepEqual(options.settingSources, [], "this machine's Claude settings and CLAUDE.md are not loaded");
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(options.mcpServers), ['roadie']);
  assert.deepEqual(options.mcpServers.roadie.tools.map((x) => x.name), ['list_files', 'search_files', 'delete_file', 'move_file', 'run_tests']);
  assert.equal(options.model, 'claude-test');
  assert.equal(options.systemPrompt.preset, 'claude_code');
  assert.equal(options.systemPrompt.append, STANDING_INSTRUCTIONS);
  assert.equal(options.canUseTool, undefined, 'nothing can approve a tool the list does not name');

  // The hook is the last word on every tool call.
  const [matcher] = options.hooks.PreToolUse;
  assert.equal(matcher.matcher, undefined, 'it applies to every tool');
  const hook = matcher.hooks[0];
  const ask = (tool_name, tool_input) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input });
  assert.deepEqual(await ask('Edit', { file_path: 'index.html' }), {});
  const denied = await ask('Write', { file_path: '/tmp/elsewhere.txt' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal((await ask('Bash', { command: 'gh pr merge' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('the standing instructions carry every rule the owner asked for', () => {
  for (const phrase of [
    'source of truth', 'README and the tests', 'existing structure and style', 'no frameworks, build steps or dependencies',
    'security policy intact', 'only what the task needs', 'CI, Docker and deploy files alone', 'Update the tests',
  ]) assert.ok(STANDING_INSTRUCTIONS.includes(phrase), phrase);
});

test('run_tests takes no arguments and runs only the saved command', async (t) => {
  const s = site(t);
  const ran = [];
  const options = agentOptions({
    sdk: fakeSdk(), z, gitops: fakeGitOps(), site: s, ai: CLAUDE,
    runTests: async (args) => { ran.push(args); return { passed: false, code: 1, output: '1 failing' }; },
  });
  const tool = options.mcpServers.roadie.tools.find((x) => x.name === 'run_tests');
  assert.deepEqual(tool.schema, {});
  const result = await tool.handler({ command: 'git push' });
  assert.deepEqual(ran, [{ dir: s.dir, command: 'npm test' }]);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /FAILED \(exit 1\)[\s\S]*1 failing/);
});

test('listing and searching skip ignored files and secrets', async (t) => {
  const s = site(t, { 'index.html': '<h1>Hello World</h1>', 'js/app.js': 'const hello = 1;\n// HELLO again', '.env': 'HELLO_SECRET=1', 'img/x.png': 'a\0b hello' });
  const gitops = fakeGitOps({ listFiles: ['.env', 'img/x.png', 'index.html', 'js/app.js'] }); // git already left out ignored files
  const options = agentOptions({ sdk: fakeSdk(), z, gitops, site: s, ai: CLAUDE, runTests: async () => ({}) });
  const list = options.mcpServers.roadie.tools.find((x) => x.name === 'list_files');
  assert.equal((await list.handler({})).content[0].text, 'img/x.png\nindex.html\njs/app.js');
  assert.equal((await list.handler({ glob: '*.js' })).content[0].text, 'js/app.js');

  const found = await searchFiles({ gitops, dir: s.dir, query: 'hello' });
  assert.equal(found, 'index.html:1: <h1>Hello World</h1>\njs/app.js:1: const hello = 1;\njs/app.js:2: // HELLO again');
  assert.equal(await searchFiles({ gitops, dir: s.dir, query: 'hello', glob: '**/*.html' }), 'index.html:1: <h1>Hello World</h1>');
  // Plain text only: pattern characters mean themselves.
  assert.equal(await searchFiles({ gitops, dir: s.dir, query: 'h.llo w' }), 'No matches.');
  assert.equal(await searchFiles({ gitops, dir: s.dir, query: '(a+)+$' }), 'No matches.');
  assert.equal(await searchFiles({ gitops, dir: s.dir, query: '<h1>hello' }), 'index.html:1: <h1>Hello World</h1>');
  const tool = options.mcpServers.roadie.tools.find((x) => x.name === 'search_files');
  assert.deepEqual(Object.keys(tool.schema), ['query', 'glob'], 'no regular-expression option');
});

test('globs match the way people expect', () => {
  assert.ok(globToRegExp('*.css').test('styles.css'));
  assert.ok(!globToRegExp('*.css').test('css/styles.css'));
  assert.ok(globToRegExp('**/*.css').test('css/deep/styles.css'));
  assert.ok(globToRegExp('**/*.css').test('styles.css'));
  assert.ok(globToRegExp('test/*.test.js').test('test/server.test.js'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('the AI needs a key or a local model before it will start', () => {
  assert.equal(aiStatus(CLAUDE, {}).ready, false);
  assert.match(aiStatus(CLAUDE, {}).problem, /ANTHROPIC_API_KEY/);
  assert.equal(aiStatus(CLAUDE, { ANTHROPIC_API_KEY: 'k' }).ready, true);
  assert.equal(aiStatus(CLAUDE, { CLAUDE_CODE_USE_BEDROCK: '1' }).ready, true);
  assert.equal(aiStatus(OLLAMA, {}).ready, true);
  assert.equal(aiStatus(cleanAi({ provider: 'ollama' }), {}).ready, false);
});

test('the agent process gets the right sign-in and no GitHub credentials', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', SSH_AUTH_SOCK: '/tmp/agent' };
  const claude = agentEnv(CLAUDE, base);
  assert.equal(claude.ANTHROPIC_API_KEY, 'sk-real');
  assert.equal(claude.PATH, '/bin');
  assert.equal(claude.ANTHROPIC_BASE_URL, undefined);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(claude[key], undefined, key);

  const ollama = agentEnv(OLLAMA, base);
  assert.equal(ollama.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(ollama.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(ollama.ANTHROPIC_API_KEY, '', 'the real key is never sent to the local server');
  assert.equal(ollama.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen-test');
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-real', 'the caller\'s environment is not modified');
});

test('AI settings are saved without any key', (t) => {
  const home = tmpDir(t);
  const config = createConfig(home);
  assert.equal(config.getAi().provider, 'anthropic');
  config.saveAi({ provider: 'ollama', ollamaUrl: 'http://localhost:11434/', ollamaModel: 'qwen', apiKey: 'sk-should-not-be-kept' });
  assert.deepEqual(config.getAi(), { provider: 'ollama', model: 'claude-fable-5-2', ollamaUrl: 'http://localhost:11434', ollamaModel: 'qwen' });
  assert.ok(!fs.readFileSync(config.file, 'utf8').includes('sk-should-not-be-kept'));
});

test('a chat turn streams text and tool activity to the interface', async (t) => {
  const s = site(t);
  const sdk = fakeSdk(() => [
    { type: 'system', subtype: 'init', tools: ['Read', 'Edit', 'Write'] },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looking ' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'at it.' } } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Looking at it.' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(s.dir, 'index.html') } }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/etc/hosts' } }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'outside the site folder' }] }] } },
    { type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'hidden subagent chatter' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done, not streamed.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done' },
  ]);
  const updates = [];
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: (u) => updates.push(u) });
  t.after(() => chat.close());

  chat.send('  make the heading red ');
  assert.equal(chat.busy, true);
  assert.throws(() => chat.send('and blue'), /still working/);
  await settle();

  assert.equal(chat.busy, false);
  assert.deepEqual(chat.items.map((i) => [i.role, i.text, i.status]), [
    ['user', 'make the heading red', undefined],
    ['assistant', 'Looking at it.', undefined],
    ['tool', 'Edit index.html', 'done'],
    ['tool', 'Write /etc/hosts', 'failed'],
    ['assistant', 'Done, not streamed.', undefined],
  ]);
  assert.equal(chat.items[3].detail, 'outside the site folder');
  assert.deepEqual(updates.at(-1), { op: 'busy', busy: false });
  assert.ok(updates.some((u) => u.op === 'append' && u.text === 'at it.'));

  // A second message continues the same conversation rather than starting a new one.
  chat.send('thanks');
  await settle();
  assert.equal(sdk.queries.length, 1);
  assert.throws(() => chat.send('   '), /Type a message/);
});

test('a reply that claims a change without making one is flagged', async (t) => {
  const s = site(t);
  const say = (text) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
  const use = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const got = (id, is_error = false) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'x' }] } });
  const end = { type: 'result', subtype: 'success', is_error: false };
  const replies = {
    // What the owner saw: reads failed, tests ran, and the AI reported an edit it never made.
    claimed: [use('a', 'mcp__roadie__run_tests', {}), got('a'), say('I have updated the rotator content list in js/script.js.'), end],
    failed: [use('b', 'Edit', { file_path: 'index.html' }), got('b', true), say('The heading has been changed to red.'), end],
    edited: [use('c', 'Edit', { file_path: 'index.html' }), got('c'), say('I have updated the heading.'), end],
    aliased: [use('d', 'mcp__roadie__write', { file_path: 'new.html' }), got('d'), say("I've added the page."), end],
    answered: [say('The heading is in index.html. I can change it if you like.'), end],
  };
  const sdk = fakeSdk((content) => replies[content]);
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  t.after(() => chat.close());
  const flagged = async (message) => {
    const from = chat.items.length;
    chat.send(message);
    await settle();
    return chat.items.slice(from).some((i) => i.role === 'note' && i.text === NO_CHANGE_NOTE);
  };
  assert.equal(await flagged('claimed'), true);
  assert.equal(await flagged('failed'), true, 'an edit that was refused is not a change');
  assert.equal(await flagged('edited'), false);
  assert.equal(await flagged('aliased'), false, 'a change made under a mistaken tool name still counts');
  assert.equal(await flagged('answered'), false, 'an answer that claims nothing is left alone');
  assert.equal(await flagged('claimed'), true, 'an earlier real edit does not excuse a later reply');
  assert.equal(chat.items.find((i) => i.role === 'tool' && i.text.startsWith('Write')).text, 'Write new.html', 'shown by its real name');
});

test('errors and Stop are reported plainly', async (t) => {
  const s = site(t);
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });

  const failing = fakeSdk(() => [
    { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 unauthorized'] },
  ]);
  const chat = createChat({ sdk: failing, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  t.after(() => chat.close());
  chat.send('hello');
  await settle();
  assert.deepEqual(chat.items.map((i) => i.role), ['user', 'error', 'error']);
  assert.match(chat.items[1].text, /rejected the sign-in/);
  assert.equal(chat.busy, false);

  let release;
  const slow = fakeSdk(() => []);
  slow.query = ({ prompt }) => {
    const it = (async function* () {
      for await (const _ of prompt) { await new Promise((r) => { release = r; }); yield { type: 'result', subtype: 'error_during_execution', is_error: true }; }
    })();
    it.interrupt = async () => { slow.interrupts++; release(); };
    it.close = () => {};
    return it;
  };
  const chat2 = createChat({ sdk: slow, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  t.after(() => chat2.close());
  chat2.send('do a long thing');
  await settle();
  await chat2.stop();
  await settle();
  assert.equal(slow.interrupts, 1);
  assert.deepEqual(chat2.items.map((i) => [i.role, i.text]), [['user', 'do a long thing'], ['note', 'Stopped.']]);
  assert.equal(chat2.busy, false);
});

test('without a key the chat refuses to start and says how to fix it', (t) => {
  const s = site(t);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved) process.env.ANTHROPIC_API_KEY = saved; });
  const sdk = fakeSdk();
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  assert.throws(() => chat.send('hi'), /ANTHROPIC_API_KEY/);
  assert.equal(sdk.queries.length, 0);
  assert.equal(chat.items.length, 0);
});

test('.git cannot be reached by respelling it', (t) => {
  const { dir } = site(t, { 'index.html': 'x', '.git/config': '[core]' });
  // macOS and Windows treat all of these as the .git folder.
  for (const p of ['.GIT/config', '.Git/hooks/pre-push', '.git./config', '.git /config', '.g​it/config', 'GIT~1/config', 'sub/../.GIT/config']) {
    for (const tool of ['Read', 'Edit', 'Write']) {
      assert.match(checkToolUse(dir, tool, { file_path: p }) || '', /\.git folder is off limits/, `${tool} ${JSON.stringify(p)}`);
    }
  }
  for (const p of ['.ENV', '.Env.local', '.env.', 'ID_RSA', 'Server.PEM']) {
    assert.match(checkToolUse(dir, 'Read', { file_path: p }) || '', /secrets file/, p);
  }
  // Names that merely resemble it are fine.
  for (const p of ['.github/workflows/test.yml', '.gitignore', '.gitattributes', 'docs/git.md', 'gitlab.html']) {
    assert.equal(checkToolUse(dir, 'Write', { file_path: p }), null, p);
  }
});

test('search does not follow a link out of the site or to a secret', async (t) => {
  const outside = tmpDir(t);
  writeFiles(outside, { 'id_ed25519': 'PRIVATE KEY MATERIAL needle\n' });
  const s = site(t, { 'index.html': 'needle in the page\n', '.env': 'TOKEN=needle\n' });
  fs.symlinkSync(path.join(outside, 'id_ed25519'), path.join(s.dir, 'notes.txt'));
  fs.symlinkSync(path.join(s.dir, '.env'), path.join(s.dir, 'settings.txt'));
  fs.symlinkSync(outside, path.join(s.dir, 'vendor'));
  const gitops = fakeGitOps({ listFiles: ['index.html', 'notes.txt', 'settings.txt', 'vendor/id_ed25519'] });
  assert.equal(await searchFiles({ gitops, dir: s.dir, query: 'needle' }), 'index.html:1: needle in the page');
});

test('a message sent after the AI process has died goes to its replacement', async (t) => {
  const s = site(t);
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  let started = 0;
  const sdk = fakeSdk();
  sdk.query = ({ prompt }) => {
    const n = ++started;
    const it = (async function* () {
      for await (const turn of prompt) {
        if (n === 1) throw new Error('process exited with code 1'); // the first process dies on its first message
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `process ${n} got: ${turn.message.content}` }] } };
        yield { type: 'result', subtype: 'success' };
      }
    })();
    it.interrupt = async () => {};
    it.close = () => {};
    return it;
  };
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  t.after(() => chat.close());
  chat.send('first');
  await settle();
  assert.equal(chat.busy, false);
  assert.match(chat.items.at(-1).text, /AI process stopped/);
  chat.send('second');
  await settle();
  assert.equal(started, 2);
  assert.equal(chat.items.at(-1).text, 'process 2 got: second');
  assert.equal(chat.busy, false);
});

test('if the AI cannot be started, the chat says so and stays usable', (t) => {
  const s = site(t);
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const sdk = fakeSdk();
  let fail = true;
  const realQuery = sdk.query;
  sdk.query = (args) => { if (fail) throw new Error('Native CLI binary for darwin-arm64 not found'); return realQuery(args); };
  const chat = createChat({ sdk, z, gitops: fakeGitOps(), site: s, ai: CLAUDE, runTests: async () => ({}), emit: () => {} });
  t.after(() => chat.close());
  chat.send('hello');
  assert.equal(chat.busy, false, 'not left busy');
  assert.match(chat.items.at(-1).text, /could not be started: Native CLI binary/);
  fail = false;
  chat.send('hello again'); // and the next message goes through
  assert.equal(chat.busy, true);
});

test('a chat adds up the tokens and estimated cost the SDK reports', async () => {
  const { usageOf, addUsage } = await import('../src/agent.js');
  assert.deepEqual(usageOf(null), { input: 0, cached: 0, output: 0, cost: 0 });
  const result = {
    total_cost_usd: 0.42,
    modelUsage: {
      'claude-fable-5-2': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200 },
      'claude-haiku-5-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  };
  // "input" is everything sent, including what was read from or written to the cache.
  assert.deepEqual(usageOf(result), { input: 1310, cached: 1000, output: 55, cost: 0.42 });
  assert.deepEqual(addUsage(usageOf(result), usageOf(result)), { input: 2620, cached: 2000, output: 110, cost: 0.84 });
});
