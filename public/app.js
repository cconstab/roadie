'use strict';

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="roadie-token"]').content;

let state = { checks: [], site: null, preview: { state: 'stopped' }, busy: null, ai: null, chat: { items: [], busy: false } };
let frameUrl = null;       // proxy URL currently loaded in the preview
let framePath = '/';       // path the previewed page last reported
let frameSpoke = false;    // has the page's reload script announced itself?
let settingsShownFor = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Roadie-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function appendLog({ stream, line }) {
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.append((stream === 'roadie' ? '› ' : '') + line + '\n');
  if (stick) log.scrollTop = log.scrollHeight;
}

function showProblem(message) {
  const box = $('problems');
  box.hidden = false;
  const p = document.createElement('p');
  p.textContent = message;
  box.replaceChildren(p);
}

function renderProblems() {
  const bad = state.checks.filter((c) => !c.ok);
  const box = $('problems');
  if (!bad.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(...bad.flatMap((c) => {
    const p = document.createElement('p');
    p.textContent = c.detail;
    const fix = document.createElement('p');
    fix.className = 'fix';
    fix.textContent = c.fix || '';
    return [p, fix];
  }));
}

const STATUS_TEXT = { stopped: 'stopped', starting: 'starting…', running: 'running', failed: 'failed' };

function render() {
  const { site, preview, busy } = state;
  renderProblems();

  $('open-btn').disabled = !!busy;
  $('open-btn').textContent = busy ? 'Opening…' : 'Open site';
  $('settings-btn').hidden = !site;

  const info = $('site-info');
  if (site) {
    const strong = document.createElement('strong');
    strong.textContent = site.key;
    info.replaceChildren(strong, ` on ${site.branch}. ${site.note}`);
    info.title = site.dir;
  } else {
    info.textContent = busy || '';
  }

  const pill = $('preview-status');
  pill.className = 'pill ' + (site ? preview.state : '');
  pill.textContent = !site ? 'no site'
    : preview.state === 'running' && preview.mode === 'static' ? 'running (static files)'
    : STATUS_TEXT[preview.state];

  const running = preview.state === 'running';
  $('run-btn').disabled = !site || preview.state === 'starting';
  $('run-btn').textContent = running ? 'Restart' : 'Run';
  $('stop-btn').disabled = !site || preview.state === 'stopped';
  $('reload-btn').disabled = !running;
  const newtab = $('newtab');
  newtab.classList.toggle('disabled', !running);
  if (running) newtab.href = preview.directUrl + framePath; else newtab.removeAttribute('href');

  const frame = $('frame');
  const empty = $('preview-empty');
  if (running) {
    if (frameUrl !== preview.url) {
      frameUrl = preview.url;
      frameSpoke = false;
      frame.src = preview.url + framePath;
    }
    frame.hidden = false;
    empty.hidden = true;
  } else {
    frame.hidden = true;
    empty.hidden = false;
    empty.textContent = !site ? 'Enter a GitHub owner/repo above and choose Open site.'
      : preview.state === 'starting' ? 'Starting the site…'
      : preview.state === 'failed' ? preview.error
      : 'The site is stopped. Choose Run to start it.';
    if (preview.state === 'failed') setLogOpen(true);
  }
  $('preview-path').textContent = running ? framePath : '';
  renderChatControls();
}

// --- chat -------------------------------------------------------------------

const chatItems = new Map(); // id -> { item, el }
let chatBusy = false;

// Just enough markdown for AI replies: code blocks, `code` and **bold**.
// Everything is added as text nodes, so nothing in a reply can become markup.
function richText(text) {
  const frag = document.createDocumentFragment();
  text.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/\n$/, '');
      return frag.append(pre);
    }
    const token = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
    let last = 0;
    for (let m; (m = token.exec(part));) {
      frag.append(part.slice(last, m.index));
      const code = m[0][0] === '`';
      const node = document.createElement(code ? 'code' : 'strong');
      node.textContent = code ? m[0].slice(1, -1) : m[0].slice(2, -2);
      frag.append(node);
      last = token.lastIndex;
    }
    frag.append(part.slice(last));
  });
  return frag;
}

function paintItem(el, item) {
  el.className = `msg ${item.role} ${item.status || ''}`.trim();
  if (item.role === 'assistant') el.replaceChildren(richText(item.text));
  else el.textContent = item.text;
  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = item.detail;
    el.append(detail);
  }
}

function scrollChat(fn) {
  const box = $('messages');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  fn();
  if (stick) box.scrollTop = box.scrollHeight;
}

function addChatItem(item) {
  const el = document.createElement('div');
  paintItem(el, item);
  chatItems.set(item.id, { item: { ...item }, el });
  scrollChat(() => $('messages').append(el));
}

// Bring the message list in line with a full snapshot from Roadie.
function syncChat(chat) {
  const ids = new Set(chat.items.map((i) => i.id));
  for (const [id, entry] of chatItems) {
    if (!ids.has(id)) { entry.el.remove(); chatItems.delete(id); }
  }
  for (const item of chat.items) {
    const entry = chatItems.get(item.id);
    if (!entry) addChatItem(item);
    else { entry.item = { ...item }; scrollChat(() => paintItem(entry.el, item)); }
  }
  setChatBusy(chat.busy);
}

function applyChat(update) {
  if (update.op === 'add') {
    if (!chatItems.has(update.item.id)) addChatItem(update.item);
  } else if (update.op === 'append' || update.op === 'update') {
    const entry = chatItems.get(update.id);
    if (!entry) return;
    if (update.op === 'append') entry.item.text += update.text; else Object.assign(entry.item, update.patch);
    scrollChat(() => paintItem(entry.el, entry.item));
  } else if (update.op === 'busy') {
    setChatBusy(update.busy);
  }
}

function setChatBusy(busy) {
  const was = chatBusy;
  chatBusy = busy;
  renderChatControls();
  if (was && !busy) refreshChanges();
}

function renderChatControls() {
  const { site, ai } = state;
  const ready = !!(site && ai && ai.status.ready);
  $('ai-label').textContent = ai ? ai.status.label : '';
  $('ai-label').className = 'pill' + (ai && !ai.status.ready ? ' failed' : '');
  $('chat-input').disabled = !ready;
  $('send-btn').disabled = !ready || chatBusy;
  $('stop-chat').hidden = !chatBusy;
  $('new-chat-btn').disabled = chatBusy || chatItems.size === 0;
  $('chat-hint').textContent = !site ? 'Open a site to start.'
    : ai && !ai.status.ready ? ai.status.problem
    : chatBusy ? 'Working…' : '';
}

// --- changed files ------------------------------------------------------------

const openDiffs = new Map(); // path -> was the diff left open?
let changesTimer = null;

// Bursts of file changes are gathered into one refresh; pass 0 to refresh at once.
function refreshChanges(delay = 250) {
  clearTimeout(changesTimer);
  changesTimer = setTimeout(async () => {
    try { renderChanges((await api('GET', '/api/changes')).files); }
    catch (err) { console.error('Could not load changes:', err); }
  }, delay);
}

function diffLines(diff) {
  const pre = document.createElement('pre');
  pre.className = 'diff';
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (!inHunk) continue; // skip the file header lines
    const span = document.createElement('span');
    span.className = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    span.textContent = line || ' ';
    pre.append(span);
  }
  return pre;
}

function renderChanges(files) {
  const box = $('changes');
  const count = $('changes-count');
  count.hidden = !files.length;
  count.textContent = String(files.length);
  if (!files.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.site ? 'No changes yet. The site matches its last commit.' : 'Open a site to see its changes.';
    return box.replaceChildren(p);
  }
  box.replaceChildren(...files.map((f) => {
    const details = document.createElement('details');
    details.open = openDiffs.has(f.path) ? openDiffs.get(f.path) : true;
    details.addEventListener('toggle', () => openDiffs.set(f.path, details.open));
    const summary = document.createElement('summary');
    const status = document.createElement('span');
    status.className = 'status ' + f.status;
    status.textContent = f.status;
    summary.append(f.from ? `${f.from} → ${f.path}` : f.path, status);
    details.append(summary);
    if (f.hidden) {
      const note = document.createElement('p');
      note.className = 'diff-note';
      note.textContent = f.hidden;
      details.append(note);
    }
    if (f.diff) {
      const pre = diffLines(f.diff);
      if (pre.children.length) details.append(pre);
      else if (!f.hidden) {
        const note = document.createElement('p');
        note.className = 'diff-note';
        note.textContent = 'Binary file, or nothing to show as text.';
        details.append(note);
      }
    }
    return details;
  }));
}

// --- AI settings --------------------------------------------------------------

function showAiProvider() {
  const form = $('ai-form');
  const provider = form.elements.provider.value;
  for (const sub of form.querySelectorAll('.sub')) sub.hidden = sub.dataset.for !== provider;
}

async function loadOllamaModels() {
  const form = $('ai-form');
  const select = form.elements.ollamaModel;
  const wanted = select.value || (state.ai && state.ai.ollamaModel) || '';
  const note = $('ollama-note');
  try {
    const { models } = await api('POST', '/api/ai/models', { ollamaUrl: form.elements.ollamaUrl.value });
    select.replaceChildren(...(models.length ? models : ['']).map((name) => new Option(name || 'no models installed', name)));
    if (models.includes(wanted)) select.value = wanted;
    note.textContent = 'Pick a model that supports tools, and give it a context window of 64k or more.';
  } catch (err) {
    select.replaceChildren(new Option(wanted || 'not available', wanted));
    note.textContent = err.message;
  }
}

function showAiSettings() {
  const { ai } = state;
  if (!ai) return;
  const form = $('ai-form');
  form.elements.provider.value = ai.provider;
  form.elements.model.value = ai.model;
  form.elements.ollamaUrl.value = ai.ollamaUrl;
  form.elements.ollamaModel.replaceChildren(new Option(ai.ollamaModel || 'loading…', ai.ollamaModel));
  $('key-status').textContent = ai.keyFound
    ? 'Roadie found an API key in its environment.'
    : 'No ANTHROPIC_API_KEY was set when Roadie started. Set it in your shell and restart Roadie.';
  showAiProvider();
  $('ai-dialog').showModal();
  if (ai.provider === 'ollama') loadOllamaModels();
}

function setLogOpen(open) {
  $('log').hidden = !open;
  $('log-btn').setAttribute('aria-expanded', String(open));
  if (open) $('log').scrollTop = $('log').scrollHeight;
}

function showSettings() {
  const { site } = state;
  if (!site) return;
  const form = $('settings-form');
  for (const [key, value] of Object.entries(site.settings)) {
    if (form.elements[key]) form.elements[key].value = value ?? '';
  }
  for (const small of form.querySelectorAll('[data-note]')) {
    small.textContent = site.notes[small.dataset.note] || '';
  }
  $('settings-intro').textContent = site.saved
    ? `Your saved settings for ${site.key}. The notes show what Roadie finds in the repo now.`
    : `This is what Roadie worked out from ${site.key}. Correct anything that is wrong.`;
  $('settings').showModal();
}

function setState(next) {
  const siteBefore = state.site && state.site.key;
  state = next;
  if (next.chat) syncChat(next.chat);
  render();
  if ((next.site && next.site.key) !== siteBefore) { openDiffs.clear(); refreshChanges(0); }
}

// --- events from the page -------------------------------------------------

$('open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    frameUrl = null;
    framePath = '/';
    $('log').textContent = '';
    setState(await api('POST', '/api/open', { repo: $('repo').value }));
    showSettings();
  } catch (err) {
    showProblem(err.message);
  }
});

$('settings-btn').addEventListener('click', showSettings);
$('settings-cancel').addEventListener('click', () => $('settings').close());
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = Object.fromEntries(new FormData(e.target));
  $('settings').close();
  try {
    setState(await api('POST', '/api/settings', { settings }));
    setState(await api('POST', '/api/preview/start'));
  } catch (err) {
    showProblem(err.message);
  }
});

$('run-btn').addEventListener('click', () => api('POST', '/api/preview/start').then(setState, (err) => showProblem(err.message)));
$('stop-btn').addEventListener('click', () => api('POST', '/api/preview/stop').then(setState, (err) => showProblem(err.message)));
$('reload-btn').addEventListener('click', () => { if (frameUrl) $('frame').src = frameUrl + framePath; });
$('log-btn').addEventListener('click', () => setLogOpen($('log').hidden));

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || chatBusy) return;
  try {
    await api('POST', '/api/chat/send', { text });
    input.value = '';
  } catch (err) {
    showProblem(err.message);
  }
});
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); }
});
$('stop-chat').addEventListener('click', () => api('POST', '/api/chat/stop').catch((err) => showProblem(err.message)));
$('new-chat-btn').addEventListener('click', () => api('POST', '/api/chat/new').then(setState, (err) => showProblem(err.message)));

$('ai-btn').addEventListener('click', showAiSettings);
$('ai-cancel').addEventListener('click', () => $('ai-dialog').close());
$('ai-form').addEventListener('change', (e) => { if (e.target.name === 'provider') { showAiProvider(); if (e.target.value === 'ollama') loadOllamaModels(); } });
$('ollama-refresh').addEventListener('click', loadOllamaModels);
$('ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ai = Object.fromEntries(new FormData(e.target));
  $('ai-dialog').close();
  try { setState(await api('POST', '/api/ai', { ai })); } catch (err) { showProblem(err.message); }
});

// The previewed page reports where it is, so the path and "open in new tab" follow it.
window.addEventListener('message', (e) => {
  if (!frameUrl || e.origin !== frameUrl || !e.data || e.data.roadie !== 'page') return;
  frameSpoke = true;
  framePath = typeof e.data.path === 'string' && e.data.path.startsWith('/') ? e.data.path : '/';
  render();
});

// --- events from Roadie ---------------------------------------------------

const events = new EventSource('/api/events');
events.addEventListener('state', (e) => setState(JSON.parse(e.data)));
events.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
events.addEventListener('chat', (e) => applyChat(JSON.parse(e.data)));
events.addEventListener('changed', () => {
  refreshChanges();
  // Pages normally reload themselves. If the site's policy blocked the reload
  // script, reload the frame from here instead.
  if (frameUrl && !frameSpoke && state.preview.state === 'running') $('frame').src = frameUrl + framePath;
});

api('GET', '/api/state').then((s) => {
  for (const entry of s.logs || []) appendLog(entry);
  setState(s);
  if (s.site) $('repo').value = s.site.key;
}, (err) => showProblem(err.message));

renderChanges([]);
