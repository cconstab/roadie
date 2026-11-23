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
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => { problemShown = false; renderProblems(); });
  problemShown = true;
  box.replaceChildren(p, close);
}

let problemShown = false; // a message from showProblem stays until dismissed

function renderProblems() {
  if (problemShown) return;
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

// A newer Roadie has been released: say so, and install it only when asked.
let updateDone = '';       // what the update said when it finished
let updateDismissed = '';  // a version the person chose not to hear about again this session
function renderUpdate() {
  const box = $('update');
  const text = document.createElement('p');
  if (updateDone) {
    text.textContent = updateDone;
    box.hidden = false;
    return box.replaceChildren(text);
  }
  const u = state.update;
  if (!u || u.latest === updateDismissed) { box.hidden = true; return box.replaceChildren(); }
  box.hidden = false;
  text.textContent = `Roadie ${u.latest} is available. You have ${u.current}.`;
  const notes = document.createElement('a');
  notes.href = u.url; notes.target = '_blank'; notes.rel = 'noopener'; notes.textContent = 'What is new';
  const later = document.createElement('button');
  later.type = 'button'; later.textContent = 'Not now';
  later.addEventListener('click', () => { updateDismissed = u.latest; renderUpdate(); });
  if (!u.installed) {
    const how = document.createElement('p');
    how.textContent = u.how;
    return box.replaceChildren(text, notes, how, later);
  }
  const go = document.createElement('button');
  go.type = 'button'; go.textContent = `Update to ${u.latest}`;
  go.addEventListener('click', async () => {
    if (!window.confirm(`${u.how}\n\nUpdate now?`)) return;
    go.disabled = true; later.disabled = true; go.textContent = 'Updating…';
    try { updateDone = (await api('POST', '/api/update')).message; }
    catch (err) { updateDone = ''; showProblem(err.message); }
    renderUpdate();
  });
  box.replaceChildren(text, notes, go, later);
}

const STATUS_TEXT = { stopped: 'stopped', starting: 'starting…', running: 'running', failed: 'failed' };

function render() {
  const { site, preview, busy } = state;
  renderProblems();
  renderUpdate();

  $('known-sites').replaceChildren(...(state.knownSites || []).map((key) => new Option(key, key)));
  $('open-btn').disabled = !!busy;
  $('open-btn').textContent = busy ? 'Opening…' : 'Open site';
  $('settings-btn').hidden = !site;
  $('guide-btn').hidden = !site;
  $('starter-btn').hidden = !(site && site.blank);

  const info = $('site-info');
  if (site) {
    const strong = document.createElement('strong');
    strong.textContent = site.key;
    info.replaceChildren(strong, ` in ${site.dir}`);
    info.title = site.note;
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
    const control = form.elements[key];
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = !!value; else control.value = value ?? '';
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
  if ((next.site && next.site.key) !== siteBefore) { openDiffs.clear(); refreshChanges(0); loadChange(); }
}

// --- events from the page -------------------------------------------------

$('open-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const opened = await api('POST', '/api/open', { repo: $('repo').value });
    // Only once the new site is open: a refused Open leaves the current one as it was.
    frameUrl = null;
    framePath = '/';
    $('log').textContent = '';
    setState(opened);
    if (state.site.blank) showStarter(); else showSettings();
  } catch (err) {
    showProblem(err.message);
  }
});

// --- starter site for a blank repo -------------------------------------------

function showStarter() {
  const { site } = state;
  if (!site || !site.blank) return;
  const form = $('starter-form');
  if (!form.elements.title.value) form.elements.title.value = site.repo;
  $('starter-intro').textContent = site.blank === 'empty'
    ? `${site.key} is empty. Roadie can put a starter site in it, ready to run, test and deploy.`
    : `${site.key} only has its README or licence. Roadie can add a starter site around them, ready to run, test and deploy.`;
  $('starter-files').replaceChildren(...(state.starterFiles || []).map((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    return li;
  }));
  $('starter-dialog').showModal();
}

$('starter-btn').addEventListener('click', showStarter);
$('starter-cancel').addEventListener('click', () => $('starter-dialog').close());
$('starter-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('starter-dialog').close();
  try {
    setState(await api('POST', '/api/starter', body));
    refreshChanges(0);
    showSettings();
  } catch (err) {
    showProblem(err.message);
  }
});

// --- hosting guide -------------------------------------------------------------

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy by hand';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
}

function guideStep(step, done, firstOpen) {
  const details = document.createElement('details');
  details.className = 'step';
  details.open = step.id === firstOpen;
  const summary = document.createElement('summary');
  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.checked = done.has(step.id);
  tick.title = 'Mark this step as done';
  tick.addEventListener('click', (e) => e.stopPropagation());
  tick.addEventListener('change', async () => {
    try {
      const result = await api('POST', '/api/guide/done', { id: step.id, done: tick.checked });
      $('guide-progress').textContent = `${result.done.length} of ${$('guide-steps').children.length} done`;
    } catch (err) { showProblem(err.message); }
  });
  const title = document.createElement('span');
  title.textContent = `${step.number}. ${step.title}`;
  summary.append(tick, title);

  const text = document.createElement('p');
  text.textContent = step.text;
  details.append(summary, text);

  for (const command of step.commands) {
    const label = document.createElement('div');
    label.className = 'cmd-label';
    const where = document.createElement('span');
    where.textContent = command.label ? `${command.label} (${command.where})` : command.where;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(copy, command.code));
    label.append(where, copy);
    const pre = document.createElement('pre');
    pre.textContent = command.code;
    details.append(label, pre);
  }

  const check = document.createElement('p');
  check.className = 'check';
  check.textContent = `Done when: ${step.check}`;
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.textContent = 'Ask the AI about this step';
  ask.addEventListener('click', () => askGuide(step.id));
  details.append(check, ask);
  return details;
}

async function showGuide() {
  try {
    const { guide, done } = await api('GET', '/api/guide');
    const doneSet = new Set(done);
    const first = (guide.steps.find((s) => !doneSet.has(s.id)) || guide.steps[0]).id;
    $('guide-intro').textContent = 'How to put this site on a server of your own, with HTTPS, a staging copy and automatic deploys. '
      + 'Roadie never connects to your server: you run each command yourself, and tick steps off as you go. '
      + 'The commands are for Ubuntu or Debian.'
      + (guide.hasDomain ? '' : ' No domain is set for this site yet, so the guide uses example.com.');
    $('guide-steps').replaceChildren(...guide.steps.map((s) => guideStep(s, doneSet, first)));
    $('guide-progress').textContent = `${done.filter((id) => guide.steps.some((s) => s.id === id)).length} of ${guide.steps.length} done`;
    $('guide-dialog').showModal();
  } catch (err) {
    showProblem(err.message);
  }
}

async function askGuide(id) {
  try {
    await api('POST', '/api/guide/ask', id ? { id } : {});
    $('guide-dialog').close();
  } catch (err) {
    $('guide-dialog').close();
    showProblem(err.message);
  }
}

$('guide-btn').addEventListener('click', showGuide);
$('guide-close').addEventListener('click', () => $('guide-dialog').close());
$('guide-talk').addEventListener('click', () => askGuide(null));

// --- the change bar --------------------------------------------------------------

let change = { open: false };
let changeWorking = null; // text shown on the button while a click is being handled

const CONFIRM_LABELS = {
  'first-commit': 'Commit and push to main',
  pr: 'Push and open the pull request',
  'update-pr': 'Push the update',
  merge: 'Merge',
  release: 'Publish the release',
  discard: 'Abandon the change',
};

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function span(text, className) {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function renderChange() {
  const steps = $('steps');
  const next = $('next-btn');
  const also = $('change-also');
  const detail = $('change-detail');

  if (!change.open) {
    steps.replaceChildren(...['Start change', 'Run tests', 'Open PR', 'CI', 'Merge', 'Staging', 'Release', 'Production'].map((label) => {
      const li = document.createElement('li');
      li.textContent = label;
      return li;
    }));
    next.textContent = 'Start change';
    next.disabled = true;
    next.title = 'Open a site first.';
    also.replaceChildren();
    detail.hidden = true;
    return;
  }

  steps.replaceChildren(...change.steps.map((step) => {
    const li = document.createElement('li');
    li.className = step.status;
    li.title = step.detail || '';
    const href = step.id === 'pr' && change.pr ? change.pr.url
      : step.id === 'release' && change.release && change.release.url ? change.release.url
      : step.id === 'staging' && step.status === 'done' ? change.links.staging
      : step.id === 'production' && step.status === 'done' ? change.links.production
      : null;
    const label = step.id === 'pr' && change.pr ? `PR #${change.pr.number}`
      : step.id === 'release' && change.release ? `Release ${change.release.tag}`
      : step.label;
    li.append(href ? link(href, label) : label);
    return li;
  }));

  const busy = change.busy || changeWorking;
  next.textContent = busy || (change.next ? change.next.label : 'Done');
  next.disabled = !!busy || !change.next || !change.next.enabled;
  next.title = change.next && change.next.why ? change.next.why : '';
  next.dataset.action = change.next ? change.next.id : '';

  also.replaceChildren(...(busy ? [] : change.also || []).map((item) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.addEventListener('click', () => changeAction(item.id));
    return b;
  }));
  if (change.testOutput && !busy) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Test output';
    b.addEventListener('click', () => showTests());
    also.prepend(b);
  }

  // The line under the bar: where things stand, in words.
  const parts = [];
  if (change.stage !== 'idle' && change.stage !== 'first-commit') {
    const b = document.createElement('span');
    b.append('Branch ', Object.assign(document.createElement('strong'), { textContent: change.branch }));
    parts.push(b);
  }
  if (change.note) parts.push(span(change.note));
  if (change.next && !change.next.enabled && change.next.why) parts.push(span(change.next.why));
  if (change.stage === 'pr-open' && change.checks.length) {
    const box = document.createElement('span');
    box.append('Checks: ');
    change.checks.forEach((check, i) => {
      if (i) box.append(', ');
      const mark = check.bucket === 'pass' || check.bucket === 'skipping' ? '✓ ' : check.bucket === 'pending' ? '… ' : '✕ ';
      const a = check.link ? link(check.link, mark + check.name) : span(mark + check.name);
      if (check.bucket === 'fail' || check.bucket === 'cancel') a.className = 'bad';
      box.append(a);
    });
    parts.push(box);
  }
  for (const which of ['staging', 'production']) {
    const h = change[which];
    if (!h || !(h.live || h.polling || h.timedOut)) continue;
    const box = document.createElement('span');
    if (h.live) box.append(span(`${which === 'staging' ? 'Staging' : 'Production'} is live on ${h.seen || h.waitingFor}. `, 'ok'), link(h.url.replace(/\/[^/]*$/, '') || h.url, 'Open it'));
    else if (h.polling) box.append(`Waiting for ${which} to report ${h.waitingFor}. `, h.error ? span(h.error, 'bad') : (h.seen ? `It is on ${h.seen} now.` : ''), ' Deploys usually take a few minutes.');
    else if (h.timedOut) box.append(span(`${which} never reported ${h.waitingFor}. It is on ${h.seen || 'an unknown build'}. Check the deploy on the server.`, 'bad'));
    if (box.childNodes.length) parts.push(box);
  }
  if (change.remoteError) parts.push(span(`Could not reach GitHub: ${change.remoteError}`, 'bad'));
  detail.replaceChildren(...parts);
  detail.hidden = !parts.length;
}

function setChange(next) {
  if (!next || next.testChunk !== undefined) return;
  change = next;
  renderChange();
}

async function loadChange() {
  try { setChange(await api('GET', '/api/change')); } catch (err) { showProblem(err.message); }
}

async function working(text, fn) {
  changeWorking = text;
  renderChange();
  try { return await fn(); }
  catch (err) { showProblem(err.message); }
  finally { changeWorking = null; renderChange(); refreshChanges(0); }
}

function showTests(result) {
  const out = $('tests-output');
  out.textContent = result ? result.output : change.testOutput || '';
  out.scrollTop = out.scrollHeight;
  const passed = result ? result.passed : change.tests && change.tests.passed;
  const pill = $('tests-status');
  pill.textContent = result === null ? 'running…' : passed ? 'passed' : 'failed';
  pill.className = 'pill ' + (result === null ? 'starting' : passed ? 'running' : 'failed');
  $('tests-ask').hidden = result === null || passed;
  const sandboxed = result ? result.sandboxed : change.tests && change.tests.sandboxed;
  $('tests-note').textContent = result === null ? '' : sandboxed
    ? 'Run in a sandbox: no network beyond this machine, and no writing to the site\'s .git folder.'
    : 'Run without a sandbox (Roadie has one on macOS only, for now).';
  if (!$('tests-dialog').open) $('tests-dialog').showModal();
}

async function runTestsNow() {
  $('tests-output').textContent = '';
  showTests(null);
  await working('Running tests…', async () => {
    try {
      const result = await api('POST', '/api/change/tests');
      showTests(result);
    } catch (err) {
      $('tests-status').textContent = 'not run';
      $('tests-status').className = 'pill failed';
      $('tests-note').textContent = err.message;
      throw err;
    } finally {
      await loadChange();
    }
  });
}

let pending = null; // the plan on screen: { token, action, plan }

function field(labelText, control, hint) {
  const label = document.createElement('label');
  label.append(labelText, control);
  if (hint) label.append(Object.assign(document.createElement('small'), { textContent: hint }));
  return label;
}

function showPlan(prepared) {
  pending = prepared;
  const { plan, action } = prepared;
  $('confirm-title').textContent = plan.title;
  $('confirm-summary').textContent = plan.summary;
  $('confirm-warning').textContent = plan.warning || '';
  $('confirm-warning').hidden = !plan.warning;
  $('confirm-error').hidden = true;

  const fields = [];
  if (action === 'release') {
    const row = document.createElement('div');
    row.className = 'versions';
    for (const [kind, tag] of [['patch', plan.versions.patch], ['minor', plan.versions.minor], ['major', plan.versions.major]]) {
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'tag', value: tag, checked: tag === plan.tag });
      // A different version means different notes, so the step is prepared again.
      radio.addEventListener('change', () => prepareStep('release', { tag }));
      const label = document.createElement('label');
      label.append(radio, `${tag} (${kind})`);
      row.append(label);
    }
    const wrap = document.createElement('div');
    wrap.append(Object.assign(document.createElement('strong'), { textContent: plan.versions.latest ? `Version (the latest is ${plan.versions.latest})` : 'Version (this is the first release)' }), row);
    fields.push(wrap);
  }
  if (plan.editable && plan.editable.title !== undefined) {
    const input = Object.assign(document.createElement('input'), { name: 'title', value: plan.editable.title, maxLength: 200, required: true });
    fields.push(field(action === 'pr' ? 'Pull request title' : 'Commit message', input,
      plan.drafted === 'ai' ? 'Drafted by the AI. Edit it if you like.' : plan.drafted === 'fallback' ? 'The AI was not available, so this is a plain draft. Edit it if you like.' : ''));
  }
  if (plan.editable && plan.editable.body !== undefined) {
    fields.push(field('Description', Object.assign(document.createElement('textarea'), { name: 'body', value: plan.editable.body })));
  }
  if (plan.editable && plan.editable.notes !== undefined) {
    fields.push(field('Release notes', Object.assign(document.createElement('textarea'), { name: 'notes', value: plan.editable.notes }),
      plan.notesFrom === 'github' ? 'Drafted by GitHub from the merged pull requests. Edit them if you like.' : 'Drafted from the commit list. Edit them if you like.'));
  }
  $('confirm-fields').replaceChildren(...fields);

  const files = plan.files || [];
  $('confirm-files-box').hidden = !files.length;
  $('confirm-files-summary').textContent = `${files.length} file${files.length === 1 ? '' : 's'} in this change`;
  $('confirm-files').replaceChildren(...files.map((f) => Object.assign(document.createElement('li'), { textContent: `${f.path} (${f.status})` })));

  $('confirm-commands').textContent = plan.commands.join('\n');
  $('confirm-sends').textContent = plan.local
    ? 'This stays on your machine. Nothing is sent anywhere.'
    : `Sends ${plan.sends}. Nothing is sent until you choose the button below.`;
  $('confirm-go').textContent = CONFIRM_LABELS[action] || 'Go ahead';
  $('confirm-go').disabled = false;
  if (!$('confirm-dialog').open) $('confirm-dialog').showModal();
}

async function prepareStep(action, input) {
  const text = action === 'pr' ? 'Drafting the pull request…' : action === 'release' ? 'Drafting the release…' : 'Checking…';
  await working(text, async () => showPlan(await api('POST', '/api/change/prepare', { action, input })));
}

async function changeAction(id) {
  if (!id) return;
  if (id === 'start') {
    $('start-intro').textContent = `Makes a new branch from the newest ${change.defaultBranch}. `
      + (change.filesChanged ? `Your ${change.filesChanged} changed file${change.filesChanged === 1 ? '' : 's'} come along.` : 'Then ask the AI for what you want changed.');
    $('start-form').reset();
    return $('start-dialog').showModal();
  }
  if (id === 'tests') return runTestsNow();
  if (id === 'override') return prepareStep(change.pr ? 'update-pr' : 'pr', { override: true });
  if (['first-commit', 'pr', 'update-pr', 'merge', 'release', 'discard'].includes(id)) return prepareStep(id);
  if (id === 'ask-ai' || id === 'ask-ai-ci') {
    return working('Asking the AI…', () => api('POST', '/api/change/ask-ai', { kind: id === 'ask-ai-ci' ? 'ci' : 'tests' }));
  }
  if (id === 'staging' || id === 'production') return working('Checking…', async () => setChange(await api('POST', '/api/change/health', { which: id })));
  if (id === 'staging-stop' || id === 'production-stop') {
    return working('Stopping…', async () => setChange(await api('POST', '/api/change/health', { which: id.replace('-stop', ''), stop: true })));
  }
  if (id === 'finish') return working('Finishing…', async () => setChange(await api('POST', '/api/change/finish')));
  if (id === 'refresh') return working('Checking…', async () => setChange(await api('POST', '/api/change/refresh')));
}

$('next-btn').addEventListener('click', () => changeAction($('next-btn').dataset.action));

$('start-cancel').addEventListener('click', () => $('start-dialog').close());
$('start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = e.target.elements.description.value;
  $('start-dialog').close();
  await working('Starting…', async () => setChange(await api('POST', '/api/change/start', { description })));
});

$('tests-close').addEventListener('click', () => $('tests-dialog').close());
$('tests-ask').addEventListener('click', () => { $('tests-dialog').close(); changeAction('ask-ai'); });

$('confirm-cancel').addEventListener('click', () => { pending = null; $('confirm-dialog').close(); });
$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;
  const { token, action } = pending;
  const edits = Object.fromEntries(new FormData(e.target));
  pending = null;
  $('confirm-go').disabled = true;
  $('confirm-go').textContent = 'Working…';
  try {
    setChange(await api('POST', '/api/change/confirm', { token, action, edits }));
    $('confirm-dialog').close();
  } catch (err) {
    // The plan was used up or refused: show why, and let them start the step again.
    $('confirm-error').textContent = err.message;
    $('confirm-error').hidden = false;
    $('confirm-go').textContent = 'Not done. Close and try the step again';
  }
  refreshChanges(0);
  loadChange();
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
events.addEventListener('change', (e) => {
  const update = JSON.parse(e.data);
  if (update.testChunk !== undefined) {
    const out = $('tests-output');
    out.append(update.testChunk);
    out.scrollTop = out.scrollHeight;
  } else {
    setChange(update);
  }
});
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
renderChange();
