// The AI that edits the site, built on the Claude Agent SDK.
//
// What it can do is fixed here, not left to the model's good behaviour:
//   - Built-in tools: Read, Edit and Write only. No shell, no web, no subagents.
//   - Every file path is checked: inside the site folder, not .git, not a secrets file.
//   - Three Roadie tools: list files, search files, and run the site's saved test
//     command (no arguments, so it cannot be turned into a way to run anything else).
//   - No settings, CLAUDE.md, MCP servers, skills or plugins from this machine are loaded.
// It has no way to reach git, gh or the network, so it can never push, merge or release.
import fs from 'node:fs';
import path from 'node:path';
import { checkSitePath, isSecretPath } from './guards.js';

export const STANDING_INSTRUCTIONS = `You are working on a hand-coded website through Roadie, a tool its owner uses to edit the site by chatting with you. The owner sees a live preview that reloads when you change a file, and a list of your changes as diffs.

Standing instructions:
- The repository is the source of truth. Read the README and the tests before changing anything.
- Follow the site's existing structure and style.
- Add no frameworks, build steps or dependencies the site does not already have.
- Keep the site's security policy intact (for example its Content-Security-Policy and other headers).
- Change only what the task needs.
- Leave CI, Docker and deploy files alone unless you are asked to change them.
- Update the tests for what you change, and run them with the run_tests tool.

How you work here:
- You can only read and edit files inside the site's folder. Use list_files and search_files to find things.
- You have no shell, no git and no network. Roadie's owner handles branches, commits, pull requests and releases with buttons in the interface. Do not ask them to run git commands for you.
- Files that hold secrets (such as .env) are off limits.
- When you finish, say briefly what you changed and whether the tests pass.`;

const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path' };
const SERVER = 'roadie';
const ROADIE_TOOLS = ['list_files', 'search_files', 'run_tests'].map((t) => `mcp__${SERVER}__${t}`);
export const ALLOWED_TOOLS = [...Object.keys(FILE_TOOLS), ...ROADIE_TOOLS];

// Returns null when the call may go ahead, or the reason it may not.
export function checkToolUse(siteDir, toolName, input) {
  if (FILE_TOOLS[toolName]) {
    const verdict = checkSitePath(siteDir, input && input[FILE_TOOLS[toolName]]);
    return verdict.ok ? null : verdict.reason;
  }
  if (ROADIE_TOOLS.includes(toolName)) return null;
  return `${toolName} is not available here. Use Read, Edit, Write, list_files, search_files or run_tests.`;
}

// Is a way to reach the chosen AI in place?
export function aiStatus(ai, env = process.env) {
  if (ai.provider === 'ollama') {
    return ai.ollamaModel
      ? { ready: true, label: `Ollama: ${ai.ollamaModel}` }
      : { ready: false, label: 'Ollama', problem: 'Choose an Ollama model in AI settings.' };
  }
  const cloud = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'].some((k) => env[k]);
  if (env.ANTHROPIC_API_KEY || cloud) return { ready: true, label: `Claude: ${ai.model || 'default model'}` };
  return {
    ready: false,
    label: 'Claude',
    problem: 'No ANTHROPIC_API_KEY was set when Roadie started. Set it in your shell (export ANTHROPIC_API_KEY=...) and restart Roadie, or choose Ollama in AI settings.',
  };
}

// The environment for the SDK's process. options.env replaces the environment, so start from ours.
export function agentEnv(ai, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(GH_|GITHUB_TOKEN|SSH_AUTH_SOCK)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'roadie/0.1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  if (ai.provider === 'ollama') {
    // As documented by Ollama for Claude Code: its Anthropic-compatible endpoint.
    Object.assign(env, {
      ANTHROPIC_BASE_URL: ai.ollamaUrl,
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ai.ollamaModel, // background requests use the same local model
      ANTHROPIC_SMALL_FAST_MODEL: ai.ollamaModel,
      DISABLE_PROMPT_CACHING: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      API_FORCE_IDLE_TIMEOUT: '0', // local models can pause for a long time
    });
  }
  return env;
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

async function visibleFiles(gitops, dir, glob) {
  const match = glob ? globToRegExp(glob) : null;
  return (await gitops.listFiles(dir)).filter((f) =>
    !isSecretPath(f) && (!match || match.test(f) || match.test(f.split('/').pop())));
}

export async function searchFiles({ gitops, dir, query, glob, regex = false, limit = 200 }) {
  let pattern;
  try { pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  catch (err) { return `That is not a valid regular expression: ${err.message}`; }
  const hits = [];
  for (const file of await visibleFiles(gitops, dir, glob)) {
    let text;
    try {
      const full = path.join(dir, file);
      if (fs.statSync(full).size > 1_000_000) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue; // binary
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        if (hits.length >= limit) return hits.join('\n') + `\n(stopped at ${limit} matches; narrow the search)`;
      }
    }
  }
  return hits.length ? hits.join('\n') : 'No matches.';
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function roadieTools({ sdk, z, gitops, site, runTests }) {
  const { dir } = site;
  return sdk.createSdkMcpServer({
    name: SERVER,
    version: '1.0.0',
    tools: [
      sdk.tool('list_files', 'List the files in the site (ignored files and secrets are left out). Optionally filter with a glob such as "css/*.css" or "**/*.test.js".',
        { glob: z.string().optional().describe('Glob to filter by') },
        async ({ glob }) => {
          const files = await visibleFiles(gitops, dir, glob);
          const shown = files.slice(0, 800);
          return text((shown.join('\n') || 'No files match.') + (files.length > shown.length ? `\n(${files.length - shown.length} more; use a glob)` : ''));
        }, { alwaysLoad: true }),
      sdk.tool('search_files', 'Search the text of the site\'s files, ignoring case. Returns matching lines as path:line: text.',
        {
          query: z.string().describe('Text to look for'),
          glob: z.string().optional().describe('Only search files matching this glob'),
          regex: z.boolean().optional().describe('Treat the query as a regular expression'),
        },
        async ({ query, glob, regex }) => text(await searchFiles({ gitops, dir, query, glob, regex })),
        { alwaysLoad: true }),
      sdk.tool('run_tests', 'Run the site\'s test command and return its output. Takes no arguments.',
        {},
        async () => {
          const result = await runTests({ dir, command: site.settings.test });
          const verdict = result.passed ? 'PASSED' : result.code === null ? 'NOT RUN' : `FAILED (exit ${result.code})`;
          return { ...text(`Tests ${verdict}\n\n${result.output}`), isError: !result.passed };
        }, { alwaysLoad: true }),
    ],
  });
}

// The options Roadie hands to the SDK's query(). Kept separate so tests can inspect them.
export function agentOptions({ sdk, z, gitops, site, ai, runTests, onStderr }) {
  const deny = (hookEventName, reason) => ({
    hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason },
  });
  const options = {
    cwd: site.dir,
    env: agentEnv(ai),
    model: ai.provider === 'ollama' ? ai.ollamaModel : (ai.model || undefined),
    tools: Object.keys(FILE_TOOLS),          // the only built-in tools that exist for the model
    allowedTools: ALLOWED_TOOLS,             // approved without asking (after the hook below)
    permissionMode: 'dontAsk',               // anything else is refused, never prompted
    hooks: {
      PreToolUse: [{
        hooks: [async (input) => {
          const reason = checkToolUse(site.dir, input.tool_name, input.tool_input);
          return reason ? deny(input.hook_event_name, reason) : {};
        }],
      }],
    },
    mcpServers: { [SERVER]: roadieTools({ sdk, z, gitops, site, runTests }) },
    strictMcpConfig: true,                   // no MCP servers from this machine's config
    settingSources: [],                      // no user or project settings, hooks or CLAUDE.md
    skills: [],
    plugins: [],
    persistSession: false,
    includePartialMessages: true,
    systemPrompt: ai.provider === 'ollama'
      // Local models have small context windows, so they get the short prompt alone.
      ? `You are a careful web developer.\n\n${STANDING_INSTRUCTIONS}`
      : { type: 'preset', preset: 'claude_code', append: STANDING_INSTRUCTIONS },
    stderr: onStderr,
  };
  return options;
}

const ERROR_TEXT = {
  authentication_failed: 'The AI service rejected the sign-in. Check the API key Roadie was started with.',
  billing_error: 'The AI service reported a billing problem with this account.',
  rate_limit: 'The AI service is rate-limiting this account. Wait a little and try again.',
  overloaded: 'The AI service is overloaded. Try again in a moment.',
  model_not_found: 'The AI service does not know that model. Check the model name in AI settings.',
  invalid_request: 'The AI service rejected the request.',
  server_error: 'The AI service had an error. Try again.',
  max_output_tokens: 'The reply was cut off because it got too long.',
};

function toolLabel(siteDir, name, input = {}) {
  const rel = (p) => {
    if (typeof p !== 'string') return '';
    const r = path.relative(fs.realpathSync(siteDir), path.resolve(siteDir, p));
    return r && !r.startsWith('..') ? r : p;
  };
  switch (name) {
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Edit': return `Edit ${rel(input.file_path)}`;
    case 'Write': return `Write ${rel(input.file_path)}`;
    case `mcp__${SERVER}__list_files`: return input.glob ? `List files matching ${input.glob}` : 'List files';
    case `mcp__${SERVER}__search_files`: return `Search for "${input.query ?? ''}"`;
    case `mcp__${SERVER}__run_tests`: return 'Run tests';
    default: return name;
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

// One conversation about one site. `emit` receives small updates for the interface:
//   { op: 'add', item }  { op: 'append', id, text }  { op: 'update', id, patch }  { op: 'busy', busy }
export function createChat({ sdk, z, gitops, site, ai, runTests, emit }) {
  const items = [];
  let nextId = 1;
  let busy = false;
  let query = null;
  let closed = false;
  const inbox = [];
  let wake = null;

  // Per-reply stream state
  let textItem = null;      // the assistant text item being streamed
  let streamedText = false; // did the current text block arrive as deltas?
  const toolItems = new Map();
  let stderrTail = '';
  let info = null;          // what the SDK says it started with: { model, tools }

  const add = (item) => {
    const full = { id: nextId++, ...item };
    items.push(full);
    emit({ op: 'add', item: full });
    return full;
  };
  const append = (item, more) => { item.text += more; emit({ op: 'append', id: item.id, text: more }); };
  const update = (item, patch) => { Object.assign(item, patch); emit({ op: 'update', id: item.id, patch }); };
  const setBusy = (value) => { if (busy !== value) { busy = value; emit({ op: 'busy', busy }); } };

  async function* input() {
    while (!closed) {
      if (!inbox.length) await new Promise((resolve) => { wake = resolve; });
      while (inbox.length) yield inbox.shift();
    }
  }

  function handle(m) {
    if (m.type === 'system' && m.subtype === 'init') info = { model: m.model, tools: m.tools || [] };
    if (m.parent_tool_use_id) return; // only the main conversation is shown
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'content_block_start') {
        textItem = null;
        streamedText = false;
      } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text) {
        streamedText = true;
        if (!textItem) textItem = add({ role: 'assistant', text: '' });
        append(textItem, e.delta.text);
      }
    } else if (m.type === 'assistant') {
      if (m.error) add({ role: 'error', text: ERROR_TEXT[m.error] || `The AI service reported an error (${m.error}).` });
      for (const block of m.message?.content || []) {
        if (block.type === 'text' && block.text && !streamedText && !m.error) add({ role: 'assistant', text: block.text });
        if (block.type === 'tool_use') {
          toolItems.set(block.id, add({ role: 'tool', text: toolLabel(site.dir, block.name, block.input), status: 'running' }));
        }
      }
      textItem = null;
      streamedText = false;
    } else if (m.type === 'user') {
      const content = m.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result') continue;
        const item = toolItems.get(block.tool_use_id);
        if (!item) continue;
        update(item, block.is_error
          ? { status: 'failed', detail: resultText(block.content).slice(0, 600) }
          : { status: 'done' });
      }
    } else if (m.type === 'result') {
      for (const item of toolItems.values()) if (item.status === 'running') update(item, { status: 'stopped' });
      toolItems.clear();
      if (m.subtype !== 'success' && !interrupted) {
        const why = m.subtype === 'error_max_turns' ? 'The AI stopped because the task took too many steps.'
          : (m.errors && m.errors.length ? m.errors.join('\n') : 'The AI stopped with an error.');
        add({ role: 'error', text: why });
      }
      if (interrupted) add({ role: 'note', text: 'Stopped.' });
      interrupted = false;
      setBusy(false);
    }
  }

  let interrupted = false;

  async function pump(q) {
    try {
      for await (const m of q) handle(m);
    } catch (err) {
      if (!closed) {
        const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
        add({ role: 'error', text: `The AI process stopped: ${err.message}${tail ? '\n' + tail : ''}` });
      }
    } finally {
      if (query === q) query = null;
      setBusy(false);
    }
  }

  function start() {
    inbox.length = 0;
    query = sdk.query({
      prompt: input(),
      options: agentOptions({ sdk, z, gitops, site, ai, runTests, onStderr: (d) => { stderrTail = (stderrTail + d).slice(-2000); } }),
    });
    pump(query);
  }

  return {
    get items() { return items; },
    get busy() { return busy; },
    get info() { return info; },
    send(message) {
      const trimmed = String(message || '').trim();
      if (!trimmed) throw new Error('Type a message first.');
      if (busy) throw new Error('The AI is still working. Wait for it to finish, or choose Stop.');
      const status = aiStatus(ai);
      if (!status.ready) throw new Error(status.problem);
      add({ role: 'user', text: trimmed });
      setBusy(true);
      if (!query) start();
      inbox.push({ type: 'user', message: { role: 'user', content: trimmed }, parent_tool_use_id: null });
      wake?.();
    },
    async stop() {
      if (!busy || !query) return;
      interrupted = true;
      try { await query.interrupt(); } catch { /* it may already be finishing */ }
    },
    close() {
      closed = true;
      wake?.();
      try { query?.close(); } catch { /* already closed */ }
      query = null;
    },
  };
}
