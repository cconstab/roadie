// The AI that edits the site, built on the Claude Agent SDK.
//
// What it can do is fixed here, not left to the model's good behaviour:
//   - Built-in tools: Read, Edit and Write only. No shell, no web, no subagents.
//   - Every file path is checked: inside the site folder, not .git, not a secrets file.
//   - Five Roadie tools: list files, search files, delete a file, move a file, and
//     run the site's saved test command (no arguments, so it cannot be turned into
//     a way to run anything else).
//   - Pictures the owner attaches to a message reach it as images, never as files.
//   - No settings, CLAUDE.md, MCP servers, skills or plugins from this machine are loaded.
// It has no way to reach git, gh or the network, so it can never push, merge or release.
import fs from 'node:fs';
import path from 'node:path';
import { checkSitePath, isSecretPath } from './guards.js';
import { moveFile, removeFile } from './uploads.js';

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
- Use delete_file to remove a file and move_file to rename or move one. Do not empty a file or copy its text by hand instead.
- The owner adds images and other files with Roadie's "Add files" button and tells you where they went. Look at an image with Read before you use it, link to it the way the site already links to its images, and give it alt text that says what it shows. You cannot make or change pictures yourself, except SVG, which is text.
- The owner may also attach a screenshot or a design to a message for you to work from. That picture is not a file in the site.
- The owner can click an element in the preview to point at it. Roadie then tells you the page, the element and its text as background. Find that element in the site's files and change that one, not others that look like it.
- You have no shell, no git and no network. Roadie's owner handles branches, commits, pull requests and releases with buttons in the interface. Do not ask them to run git commands for you.
- Files that hold secrets (such as .env) are off limits.
- When you finish, say briefly what you changed and whether the tests pass.

Helping with hosting:
- The owner may ask you to talk them through putting the site on a server: DNS, Docker, the web server, automatic deploys. Roadie gives you its hosting guide as background when they do.
- You cannot reach their server. They run every command themselves. Take it one step at a time: say what the step is for, give the exact command, say what they should see, then wait for them to report back before moving on.
- When something goes wrong, ask them to paste the output and work from that. Read the site's own README, compose.yaml and deploy files so your advice matches this site.
- Never ask for passwords, tokens or keys, and tell them not to paste any into the chat.`;

const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path' };
const SERVER = 'roadie';
const ROADIE_NAMES = ['list_files', 'search_files', 'delete_file', 'move_file', 'run_tests'];
const ROADIE_TOOLS = ROADIE_NAMES.map((t) => `mcp__${SERVER}__${t}`);
export const ALLOWED_TOOLS = [...Object.keys(FILE_TOOLS), ...ROADIE_TOOLS];
// Roadie tools that name files: which inputs hold the paths.
const PATH_INPUTS = { delete_file: ['path'], move_file: ['from', 'to'] };

// Returns null when the call may go ahead, or the reason it may not.
export function checkToolUse(siteDir, toolName, input) {
  if (FILE_TOOLS[toolName]) {
    const verdict = checkSitePath(siteDir, input && input[FILE_TOOLS[toolName]]);
    return verdict.ok ? null : verdict.reason;
  }
  const short = String(toolName).replace(`mcp__${SERVER}__`, ''); // short names are aliases
  if (ROADIE_NAMES.includes(short)) {
    for (const key of PATH_INPUTS[short] || []) {
      const verdict = checkSitePath(siteDir, input && input[key]);
      if (!verdict.ok) return verdict.reason;
    }
    return null;
  }
  return `${toolName} is not available here. Use Read, Edit, Write, list_files, search_files, delete_file, move_file or run_tests.`;
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
    problem: `No ANTHROPIC_API_KEY was set when Roadie started. Set it in your terminal (${process.platform === 'win32' ? '$env:ANTHROPIC_API_KEY = "..." in PowerShell' : 'export ANTHROPIC_API_KEY=...'}) and restart Roadie, or choose Ollama in AI settings.`,
  };
}

// The environment for the SDK's process. options.env replaces the environment, so start from ours.
export function agentEnv(ai, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(GH_|GITHUB_TOKEN|SSH_AUTH_SOCK)/i.test(key)) delete env[key];
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

// Plain-text search, ignoring case. (No regular expressions: one written badly,
// or on purpose, could tie up Roadie for minutes.)
export async function searchFiles({ gitops, dir, query, glob, limit = 200 }) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return 'Give some text to search for.';
  const hits = [];
  for (const file of await visibleFiles(gitops, dir, glob)) {
    let text;
    try {
      // The same check as Read: a link in the repo must not lead outside the site or to a secret.
      const checked = checkSitePath(dir, file);
      if (!checked.ok) continue;
      const stat = fs.statSync(checked.abs);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
      text = fs.readFileSync(checked.abs, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue; // binary
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
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
          query: z.string().describe('Text to look for (plain text, not a pattern)'),
          glob: z.string().optional().describe('Only search files matching this glob'),
        },
        async ({ query, glob }) => text(await searchFiles({ gitops, dir, query, glob })),
        { alwaysLoad: true }),
      sdk.tool('delete_file', 'Delete one file from the site. Folders left empty are removed too.',
        { path: z.string().describe('The file, as a path inside the site folder') },
        async ({ path: file }) => {
          try { return text(`Deleted ${removeFile(dir, file).path}.`); }
          catch (err) { return { ...text(err.message), isError: true }; }
        }, { alwaysLoad: true }),
      sdk.tool('move_file', 'Rename or move one file within the site, images included. It never replaces an existing file. Update every link to the file afterwards.',
        {
          from: z.string().describe('The file now, as a path inside the site folder'),
          to: z.string().describe('Its new path inside the site folder'),
        },
        async ({ from, to }) => {
          try { const moved = moveFile(dir, from, to); return text(`Moved ${moved.from} to ${moved.to}.`); }
          catch (err) { return { ...text(err.message), isError: true }; }
        }, { alwaysLoad: true }),
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
    // Some models call Roadie's tools by their short names; send those to the real ones.
    toolAliases: Object.fromEntries(ROADIE_NAMES.map((name) => [name, `mcp__${SERVER}__${name}`])),
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

// Token and cost totals from an SDK result message (all models it used, added up).
// The cost is the SDK's estimate at list prices, not a bill.
export function usageOf(result) {
  const total = { input: 0, cached: 0, output: 0, cost: 0 };
  if (!result) return total;
  for (const u of Object.values(result.modelUsage || {})) {
    total.cached += u.cacheReadInputTokens || 0;
    total.input += (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0);
    total.output += u.outputTokens || 0;
  }
  total.cost = Number(result.total_cost_usd) || 0;
  return total;
}

export function addUsage(a, b) {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, cost: a.cost + b.cost };
}

// Pull the title and body out of whatever the model replied with.
export function parseDraft(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const clean = (title) => String(title || '').replace(/\s+/g, ' ').replace(/^["'`#\s]+|["'`\s]+$/g, '').replace(/\.$/, '').slice(0, 120);
  const json = raw.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const data = JSON.parse(json[0]);
      if (data && typeof data.title === 'string' && clean(data.title)) {
        return { title: clean(data.title), body: typeof data.body === 'string' ? data.body.trim() : '' };
      }
    } catch { /* fall through to plain text */ }
  }
  const lines = raw.replace(/^```[a-z]*\n?|```$/g, '').split('\n');
  const title = clean(lines.shift().replace(/^title:\s*/i, ''));
  return title ? { title, body: lines.join('\n').trim() } : null;
}

// Ask the AI for a pull request title and description. It gets the diff as
// text and no tools at all. Returns null if the AI is unavailable or unhelpful.
export async function draftPullRequest({ sdk, ai, site, description, changes, timeoutMs = 45_000 }) {
  if (!aiStatus(ai).ready) return null;
  const diff = changes.map((c) => `### ${c.status}: ${c.path}\n${isSecretPath(c.path) ? '(contents not shown)' : (c.diff || '').slice(0, 6000)}`).join('\n\n').slice(0, 40_000);
  const prompt = `Write the title and description for a pull request to the website repository ${site.key}.

What the owner said this change is for: ${description || '(nothing given)'}

Rules:
- Title: one plain sentence, under 70 characters, no full stop, saying what the change does.
- Body: a short summary of what changed and why, in plain words, as a few bullet points. Mention tests that were added or changed. No headings, no praise.
- Describe only what is in the diff. Do not invent anything.

Reply with only a JSON object: {"title": "...", "body": "..."}

The diff:

${diff}`;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  let reply = '';
  try {
    const q = sdk.query({
      prompt,
      options: {
        cwd: site.dir,
        env: agentEnv(ai),
        model: ai.provider === 'ollama' ? ai.ollamaModel : (ai.model || undefined),
        tools: [],                 // writing only: no tools of any kind
        allowedTools: [],
        permissionMode: 'dontAsk',
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        plugins: [],
        persistSession: false,
        maxTurns: 1,
        abortController,
        systemPrompt: 'You write short, accurate pull request descriptions for a website. You reply with JSON only.',
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const block of m.message?.content || []) if (block.type === 'text') reply += block.text;
      } else if (m.type === 'result' && m.subtype === 'success' && m.result) {
        reply = m.result;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  return parseDraft(reply);
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
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p;
  };
  switch (name) {
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Edit': return `Edit ${rel(input.file_path)}`;
    case 'Write': return `Write ${rel(input.file_path)}`;
    case `mcp__${SERVER}__list_files`: return input.glob ? `List files matching ${input.glob}` : 'List files';
    case `mcp__${SERVER}__search_files`: return `Search for "${input.query ?? ''}"`;
    case `mcp__${SERVER}__run_tests`: return 'Run tests';
    case `mcp__${SERVER}__delete_file`: return `Delete ${rel(input.path)}`;
    case `mcp__${SERVER}__move_file`: return `Move ${rel(input.from)} to ${rel(input.to)}`;
    default: return name;
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function detailOf(note, images) {
  const parts = [note, images.length ? `Shown to the AI: ${images.map((i) => i.name).join(', ')}` : ''].filter(Boolean);
  return parts.length ? { detail: parts.join('\n') } : {};
}

// One conversation about one site. `emit` receives small updates for the interface:
//   { op: 'add', item }  { op: 'append', id, text }  { op: 'update', id, patch }  { op: 'busy', busy }
export function createChat({ sdk, z, gitops, site, ai, runTests, emit }) {
  const items = [];
  let nextId = 1;
  let busy = false;
  let query = null;
  let closed = false;

  // Per-reply stream state
  let textItem = null;      // the assistant text item being streamed
  let streamedText = false; // did the current text block arrive as deltas?
  const toolItems = new Map();
  let stderrTail = '';
  let info = null;          // what the SDK says it started with: { model, tools }
  // Tokens and estimated cost for this chat. Each result from the SDK carries
  // the running total for its AI process, so the latest replaces the last; the
  // totals of processes that have ended are kept in `spent`.
  let spent = usageOf(null);
  let running = usageOf(null);
  const usage = () => addUsage(spent, running);

  const add = (item) => {
    const full = { id: nextId++, ...item };
    items.push(full);
    emit({ op: 'add', item: full });
    return full;
  };
  const append = (item, more) => { item.text += more; emit({ op: 'append', id: item.id, text: more }); };
  const update = (item, patch) => { Object.assign(item, patch); emit({ op: 'update', id: item.id, patch }); };
  const setBusy = (value) => { if (busy !== value) { busy = value; emit({ op: 'busy', busy }); } };

  // Each AI process gets its own queue, so one that has died can never
  // swallow a message meant for its replacement.
  let feed = null; // { inbox, wake, done }
  function newFeed() {
    const f = { inbox: [], wake: null, done: false };
    f.messages = (async function* () {
      while (!f.done && !closed) {
        if (!f.inbox.length) await new Promise((resolve) => { f.wake = resolve; });
        while (f.inbox.length) yield f.inbox.shift();
      }
    })();
    return f;
  }
  const endFeed = (f) => { if (f) { f.done = true; f.wake?.(); } };

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
      running = usageOf(m);
      emit({ op: 'usage', usage: usage() });
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
      if (query === q) { query = null; endFeed(feed); feed = null; spent = usage(); running = usageOf(null); }
      interrupted = false;
      setBusy(false);
    }
  }

  function start() {
    endFeed(feed);
    feed = newFeed();
    query = sdk.query({
      prompt: feed.messages,
      options: agentOptions({ sdk, z, gitops, site, ai, runTests, onStderr: (d) => { stderrTail = (stderrTail + d).slice(-2000); } }),
    });
    pump(query);
  }

  return {
    get items() { return items; },
    get busy() { return busy; },
    get info() { return info; },
    get usage() { return usage(); },
    // `context` is background for the AI that is not shown in the chat.
    // `images` are pictures for it to look at: [{ name, mediaType, data }], data in base64.
    // `note` is a line shown under the message in the chat list.
    send(message, { context, images = [], note = '' } = {}) {
      const trimmed = String(message || '').trim() || (images.length ? 'Look at the attached image.' : '');
      if (!trimmed) throw new Error('Type a message first.');
      if (busy) throw new Error('The AI is still working. Wait for it to finish, or choose Stop.');
      const status = aiStatus(ai);
      if (!status.ready) throw new Error(status.problem);
      add({ role: 'user', text: trimmed, ...detailOf(note, images) });
      setBusy(true);
      if (!query) {
        try { start(); } catch (err) {
          query = null;
          setBusy(false);
          add({ role: 'error', text: `The AI could not be started: ${err.message}` });
          return;
        }
      }
      const words = context ? `${trimmed}\n\n<background from="Roadie">\n${context}\n</background>` : trimmed;
      const content = !images.length ? words : [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        { type: 'text', text: words },
      ];
      feed.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
      feed.wake?.();
    },
    async stop() {
      if (!busy || !query) return;
      interrupted = true;
      try { await query.interrupt(); } catch { /* it may already be finishing */ }
    },
    close() {
      closed = true;
      endFeed(feed);
      try { query?.close(); } catch { /* already closed */ }
      query = null;
    },
  };
}
