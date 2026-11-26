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
  const bad = state.checks.filter((c) => !c.ok && !hiddenAdvice.has(c.id));
  const box = $('problems');
  if (!bad.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(...bad.flatMap((c) => {
    const p = document.createElement('p');
    p.textContent = c.detail;
    const fix = document.createElement('p');
    fix.className = 'fix';
    fix.textContent = c.fix || '';
    if (!ADVICE.has(c.id)) return [p, fix];
    // Advice, not a fault: it can be closed, and stays closed in this browser.
    const row = document.createElement('div');
    row.className = 'row';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Got it';
    close.addEventListener('click', () => { hideAdvice(c.id); renderProblems(); });
    row.append(p, close);
    return [row, fix];
  }));
}

// Notices that are advice about this system (no sandbox here) and not something to fix.
const ADVICE = new Set(['sandbox']);
const hiddenAdvice = new Set();
try { for (const id of JSON.parse(localStorage.getItem('roadie.hiddenAdvice') || '[]')) hiddenAdvice.add(id); } catch { /* no storage: shown each time */ }
function hideAdvice(id) {
  hiddenAdvice.add(id);
  try { localStorage.setItem('roadie.hiddenAdvice', JSON.stringify([...hiddenAdvice])); } catch { /* hidden until the page is reloaded */ }
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
  // Needs Roadie's script in the page. A site whose policy blocks it cannot be edited this way.
  $('edit-btn').disabled = !running || !frameSpoke;
  if ((!running || !site) && editMode) setEditMode(false);
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
  const address = $('preview-path');
  address.disabled = !running;
  $('new-page-btn').disabled = !site;
  // Leave the box alone while the owner is typing in it.
  if (document.activeElement !== address) address.value = running ? framePath : '';
  if (running && site && pagesFor !== site.dir) loadPages(site.dir);
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
    // Roadie's own notes ("local-…") are not in the server's list; they stay until the chat is cleared.
    const local = String(id).startsWith('local-') && chat.items.length > 0;
    if (!ids.has(id) && !local) { entry.el.remove(); chatItems.delete(id); }
  }
  for (const item of chat.items) {
    const entry = chatItems.get(item.id);
    if (!entry) addChatItem(item);
    else { entry.item = { ...item }; scrollChat(() => paintItem(entry.el, item)); }
  }
  setChatBusy(chat.busy);
  renderUsage(chat.usage);
}

const compact = (n) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// What this chat has used so far. The cost is an estimate at list prices.
function renderUsage(usage) {
  const el = $('chat-usage');
  if (!usage || !(usage.input + usage.output)) { el.hidden = true; return; }
  const local = state.ai && state.ai.provider === 'ollama';
  el.hidden = false;
  el.textContent = `This chat: ${compact(usage.input)} tokens in${usage.cached ? ` (${compact(usage.cached)} from cache)` : ''}, ${compact(usage.output)} out`
    + (local || !usage.cost ? '' : ` · about ${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`);
  el.title = local ? 'Tokens used by the local model.' : 'Estimated from Anthropic list prices. Your bill may differ.';
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
  } else if (update.op === 'usage') {
    renderUsage(update.usage);
  }
}

// A line from Roadie in the chat list that the AI never sees.
let localNotes = 0;
function addLocalNote(text) { scrollChat(() => addChatItem({ id: `local-${++localNotes}`, role: 'note', text })); }

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
  $('add-files-btn').disabled = !site;
  $('browse-btn').disabled = !site;
  $('send-btn').disabled = !ready || chatBusy;
  $('stop-chat').hidden = !chatBusy;
  $('new-chat-btn').disabled = chatBusy || chatItems.size === 0;
  $('undo-reply-btn').disabled = chatBusy || !(state.chat && state.chat.canUndo);
  $('chat-hint').textContent = !site ? 'Open a site to start.'
    : ai && !ai.status.ready ? ai.status.problem
    : chatBusy ? 'Working…' : '';
}

// --- changed files ------------------------------------------------------------

const openDiffs = new Map(); // path -> was the diff left open?
let changesTimer = null;
let undoKeeps = true; // does Undo keep the edits (git stash), or is the repo too new for that?

// Bursts of file changes are gathered into one refresh; pass 0 to refresh at once.
function refreshChanges(delay = 250) {
  clearTimeout(changesTimer);
  changesTimer = setTimeout(async () => {
    try { const data = await api('GET', '/api/changes'); undoKeeps = data.undoKeeps !== false; renderChanges(data.files); }
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
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'undo';
    undo.textContent = 'Undo';
    undo.title = 'Put this file back as it was before the change';
    undo.disabled = chatBusy;
    undo.addEventListener('click', (e) => { e.preventDefault(); undoFile(f); });
    summary.append(f.from ? `${f.from} → ${f.path}` : f.path, status, span('', 'spacer'), undo);
    details.append(summary);
    if (isPicture(f.path) && f.status !== 'deleted' && !f.hidden) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = `${f.path} as it is now`;
      img.src = `/api/file?path=${encodeURIComponent(f.path)}`;
      img.addEventListener('error', () => img.remove());
      details.append(img);
    }
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
        note.textContent = isPicture(f.path) ? (f.status === 'deleted' ? 'This picture is deleted.' : '') : 'Binary file, or nothing to show as text.';
        if (note.textContent) details.append(note);
      }
    }
    return details;
  }));
}

// The deployed site itself, not the address Roadie asks for its version.
function deployedSite(h) {
  if (h.site) return h.site;
  try { return new URL(h.url).origin + '/'; } catch { return h.url; }
}

const isPicture = (name) => /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(name);

async function undoFile(f) {
  const what = f.status === 'added' ? 'The file is taken out of the site.'
    : f.status === 'deleted' ? 'The file comes back.'
    : 'The file goes back to how it was before this change.';
  const kept = undoKeeps ? 'Roadie sets the edits aside with "git stash", so they can be recovered.'
    : 'This repo has no commits yet, so there is nowhere to keep the file: it is deleted for good.';
  if (!window.confirm(`Undo the changes to ${f.path}?\n\n${what} ${kept} Nothing is sent anywhere.`)) return;
  try { await api('POST', '/api/changes/undo', { path: f.path }); }
  catch (err) { showProblem(err.message); }
  refreshChanges(0);
  loadChange();
}

// --- adding files, and showing the AI a picture --------------------------------

const AI_IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_ADD_BYTES = 25 * 1024 * 1024;
const MAX_AI_IMAGES = 5;
let picked = [];            // files chosen in the dialog: { file, name, url }
const attachments = [];     // pictures waiting to go to the AI with the next message: { name, blob, url }
const lastFolder = new Map(); // site -> the folder chosen last time

const SHRINKABLE = /^image\/(png|jpeg|webp)$/; // kinds the browser can save again
const HEAVY_BYTES = 500 * 1024;               // above this a picture slows a page down
const fileSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// A file name that is safe in a web address: lower case, no spaces or accents.
function tidyName(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').toLowerCase();
  return (stem || 'file') + ext;
}

function renderPicked() {
  const form = $('files-form');
  const allPictures = picked.length > 0 && picked.every((p) => AI_IMAGE.test(p.file.type));
  form.elements.mode[1].disabled = !allPictures;
  if (!allPictures) form.elements.mode.value = 'site';
  const mode = form.elements.mode.value;
  $('files-site').hidden = mode !== 'site';
  $('files-ai').hidden = mode !== 'ai';
  $('files-ai-note').textContent = 'For a screenshot or a design to work from. Sent to the AI with your next message, and not saved in the site.'
    + (state.ai && state.ai.provider === 'ollama' ? ' Many local models cannot see images.' : '');
  $('files-shrink-row').hidden = !picked.some((p) => SHRINKABLE.test(p.file.type) && p.file.size > HEAVY_BYTES);
  $('files-list').replaceChildren(...picked.map((p) => {
    const li = document.createElement('li');
    let thumb;
    if (p.url) { thumb = document.createElement('img'); thumb.src = p.url; thumb.alt = ''; }
    else { thumb = span((p.name.split('.').pop() || 'file').slice(0, 5), 'no-thumb'); }
    const box = document.createElement('div');
    const name = Object.assign(document.createElement('input'), { value: p.name, spellcheck: false, required: true, disabled: mode !== 'site' });
    name.setAttribute('aria-label', `Name for ${p.file.name}`);
    name.addEventListener('input', () => { p.name = name.value; });
    const tooBig = mode === 'site' && p.file.size > MAX_ADD_BYTES;
    const shrinking = form.elements.shrink.checked;
    const heavy = mode === 'site' && p.url && p.file.size > HEAVY_BYTES;
    const note = Object.assign(document.createElement('small'), {
      className: tooBig || heavy ? 'warn' : '',
      textContent: fileSize(p.file.size) + (tooBig && !(shrinking && SHRINKABLE.test(p.file.type)) ? '. Too large to add: the limit is 25 MB.'
        : heavy && shrinking && SHRINKABLE.test(p.file.type) ? '. Large for a web page: Roadie will make it smaller.'
          : heavy ? '. Large for a web page: consider making it smaller first.' : ''),
    });
    box.append(name, note);
    const drop = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
    drop.addEventListener('click', () => { forget(p); picked = picked.filter((x) => x !== p); if (picked.length) renderPicked(); else $('files-dialog').close(); });
    li.append(thumb, box, drop);
    return li;
  }));
  $('files-go').textContent = mode === 'ai' ? 'Show the AI' : picked.length === 1 ? 'Add to the site' : `Add ${picked.length} files to the site`;
  $('files-go').disabled = picked.some((p) => mode === 'site' && p.file.size > MAX_ADD_BYTES && !(form.elements.shrink.checked && SHRINKABLE.test(p.file.type)));
}

const forget = (p) => { if (p.url) URL.revokeObjectURL(p.url); };

async function chooseFiles(files, { pasted = false } = {}) {
  if (!state.site) return showProblem('Open a site first.');
  files = [...files].filter((f) => f.size > 0 || f.type); // a dropped folder has neither
  if (!files.length) return;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  picked.forEach(forget);
  picked = files.map((file, i) => ({
    file,
    name: pasted && /^image\.\w+$/.test(file.name) ? `pasted-${stamp}${files.length > 1 ? '-' + (i + 1) : ''}.${file.name.split('.').pop()}` : tidyName(file.name),
    url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  }));
  const form = $('files-form');
  $('files-error').hidden = true;
  // A pasted picture is most often a screenshot for the AI to look at.
  form.elements.mode.value = pasted && picked.every((p) => AI_IMAGE.test(p.file.type)) ? 'ai' : 'site';
  form.elements.folder.value = lastFolder.get(state.site.key) || '';
  // Replacing a picture clicked on the page: same folder, and the same name when the kind of file matches.
  const replacing = replaceTarget && picked.length === 1 ? replaceTarget : null;
  replaceTarget = null;
  form.dataset.replacing = replacing ? JSON.stringify(replacing) : '';
  if (replacing) {
    const slash = replacing.file.lastIndexOf('/');
    const oldName = replacing.file.slice(slash + 1);
    const ext = (n) => (n.includes('.') ? n.slice(n.lastIndexOf('.')).toLowerCase() : '');
    form.elements.mode.value = 'site';
    form.elements.folder.value = slash < 0 ? '' : replacing.file.slice(0, slash);
    picked[0].name = ext(oldName) === ext(picked[0].name) ? oldName : oldName.slice(0, oldName.length - ext(oldName).length) + ext(picked[0].name);
  }
  renderPicked();
  if (!$('files-dialog').open) $('files-dialog').showModal();
  try {
    const { folders, suggested } = await api('GET', '/api/files/folders');
    $('site-folders').replaceChildren(...folders.map((f) => new Option(f, f)));
    if (!form.elements.folder.value && !replacing) form.elements.folder.value = suggested;
  } catch { /* the folder can still be typed */ }
}

async function sendFile(p, folder, replace = false) {
  const query = new URLSearchParams({ folder, name: p.name, ...(replace ? { replace: '1' } : {}) });
  const res = await fetch(`/api/files/add?${query}`, {
    method: 'POST',
    headers: { 'X-Roadie-Token': token, 'Content-Type': 'application/octet-stream' },
    body: p.file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (data.exists && !replace) {
    return window.confirm(`${data.path} already exists in the site.\n\nReplace it with this file?`) ? sendFile(p, folder, true) : null;
  }
  throw new Error(data.error || `Request failed (${res.status})`);
}

// Make a picture for the site lighter: at most 2000 pixels on its longer side,
// saved again as the same kind of file. The original is kept when that would
// not make it smaller, or when the browser cannot read it.
async function shrinkForSite(file) {
  if (!SHRINKABLE.test(file.type) || file.size <= HEAVY_BYTES) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.type === 'image/png') { bitmap.close(); return file; } // saving a PNG again gains nothing
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type, 0.85));
  return blob && blob.type === file.type && blob.size < file.size ? blob : file;
}

// Shrink a picture that is too big for the AI to take: at most 2000 pixels on its
// longer side. Small ones, and animated GIFs, go as they are.
async function fitForAi(file) {
  if (file.type === 'image/gif') return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= 2000 && file.size <= 3.5 * 1024 * 1024) { bitmap.close(); return file; }
  const scale = Math.min(1, 2000 / longest);
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return (await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))) || file;
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(blob);
});

function renderAttachments() {
  const box = $('attachments');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a) => {
    const li = document.createElement('li');
    const img = Object.assign(document.createElement('img'), { src: a.url, alt: '' });
    const drop = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: `Do not send ${a.name}` });
    drop.setAttribute('aria-label', `Do not send ${a.name}`);
    drop.addEventListener('click', () => { URL.revokeObjectURL(a.url); attachments.splice(attachments.indexOf(a), 1); renderAttachments(); });
    li.append(img, a.name, drop);
    return li;
  }));
  renderChatControls();
}

$('add-files-btn').addEventListener('click', () => { replaceTarget = null; $('file-picker').click(); });
$('file-picker').addEventListener('change', (e) => { chooseFiles(e.target.files); e.target.value = ''; });
$('files-cancel').addEventListener('click', () => $('files-dialog').close());
$('files-dialog').addEventListener('close', () => { picked.forEach(forget); picked = []; });
$('files-form').addEventListener('change', (e) => { if (e.target.name === 'mode' || e.target.name === 'shrink') renderPicked(); });
$('files-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const problem = $('files-error');
  problem.hidden = true;
  $('files-go').disabled = true;
  try {
    if (form.elements.mode.value === 'ai') {
      if (attachments.length + picked.length > MAX_AI_IMAGES) throw new Error(`Show the AI at most ${MAX_AI_IMAGES} images with one message.`);
      for (const p of picked) {
        const blob = await fitForAi(p.file);
        attachments.push({ name: p.file.name === 'image.png' ? p.name : p.file.name, blob, url: URL.createObjectURL(blob) });
      }
      $('files-dialog').close();
      renderAttachments();
      return $('chat-input').focus();
    }
    const folder = form.elements.folder.value.trim();
    const replacing = form.dataset.replacing ? JSON.parse(form.dataset.replacing) : null;
    if (!replacing) lastFolder.set(state.site.key, folder);
    const added = [];
    const ignored = [];
    // One at a time, so a file that fails leaves the rest still listed.
    const saved = [];
    while (picked.length) {
      if (form.elements.shrink.checked) {
        const before = picked[0].file.size;
        picked[0].file = await shrinkForSite(picked[0].file);
        if (picked[0].file.size < before) saved.push(`${picked[0].name}: ${fileSize(before)} to ${fileSize(picked[0].file.size)}`);
      }
      const done = await sendFile(picked[0], folder);
      if (done) { added.push(done.path); if (done.ignored) ignored.push(done.path); }
      forget(picked.shift());
      renderPicked();
    }
    $('files-dialog').close();
    refreshChanges(0);
    if (saved.length) addLocalNote(`Made smaller on the way in. ${saved.join('; ')}.`);
    if (ignored.length) showProblem(`${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} in a folder the site's .gitignore leaves out, so ${ignored.length === 1 ? 'it' : 'they'} will not be part of a change. Choose another folder if ${ignored.length === 1 ? 'it belongs' : 'they belong'} in the site.`);
    const input = $('chat-input');
    if (replacing && added.length) {
      // Same name: the page already shows the new picture. A new name: the AI must swap the link.
      if (added[0] !== replacing.file && !input.value.trim()) {
        input.value = `I added ${added[0]}. Use it in place of ${replacing.file} on ${replacing.page}, and delete ${replacing.file} if nothing else uses it.`;
        input.focus();
      }
      pick = null;
      renderPointing();
    } else if (added.length && !input.value.trim()) {
      input.value = `I added ${added.join(', ')}. `;
      input.focus();
    }
  } catch (err) {
    problem.textContent = err.message;
    problem.hidden = false;
    refreshChanges(0);
    if (picked.length) renderPicked();
  }
});

// Files can be dropped on the chat, and a copied picture pasted into the message.
const chatPane = document.querySelector('.pane.chat');
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
chatPane.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); chatPane.classList.add('dropping'); } });
chatPane.addEventListener('dragleave', (e) => { if (!chatPane.contains(e.relatedTarget)) chatPane.classList.remove('dropping'); });
chatPane.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  chatPane.classList.remove('dropping');
  chooseFiles(e.dataTransfer.files);
});
// Dropped anywhere else, a file would replace Roadie's page with itself.
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
$('chat-input').addEventListener('paste', (e) => {
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  if (!files.length) return;
  e.preventDefault();
  chooseFiles(files, { pasted: true });
});

// --- all the site's files ---------------------------------------------------------

let browseFilesList = [];

function renderBrowse() {
  const want = $('browse-filter').value.trim().toLowerCase();
  const shown = browseFilesList.filter((f) => f.path.toLowerCase().includes(want));
  $('browse-count').textContent = `${shown.length} of ${browseFilesList.length} files. Ignored files and secrets are not listed.`;
  $('browse-list').replaceChildren(...shown.slice(0, 400).map((f) => {
    const li = document.createElement('li');
    let thumb;
    if (f.image) { thumb = Object.assign(document.createElement('img'), { src: `/api/file?path=${encodeURIComponent(f.path)}`, alt: '', loading: 'lazy' }); }
    else thumb = span((f.path.includes('.') ? f.path.split('.').pop() : 'file').slice(0, 5), 'no-thumb');
    const box = document.createElement('div');
    box.append(span(f.path, 'name'), Object.assign(document.createElement('small'), { textContent: fileSize(f.size) }));
    const page = sitePageList.find((p) => p.file === f.path);
    const show = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Show', hidden: !page || !frameUrl, title: 'Show this page in the preview' });
    show.addEventListener('click', () => { $('browse-dialog').close(); goToPage(page.path); });
    const drop = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete' });
    drop.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.path} from the site?\n\nA file that was already part of the site then shows under Changed files, where Undo brings it back. A file you added since the last change is gone for good.`)) return;
      $('browse-error').hidden = true;
      try {
        await api('POST', '/api/files/delete', { path: f.path });
        browseFilesList = browseFilesList.filter((x) => x !== f);
        renderBrowse();
        refreshChanges(0);
      } catch (err) { $('browse-error').textContent = err.message; $('browse-error').hidden = false; }
    });
    li.append(thumb, box, show, drop);
    return li;
  }));
}

$('browse-btn').addEventListener('click', async () => {
  try {
    [browseFilesList, sitePageList] = await Promise.all([api('GET', '/api/files').then((r) => r.files), api('GET', '/api/pages').then((r) => r.pages)]);
  } catch (err) { return showProblem(err.message); }
  $('browse-filter').value = '';
  $('browse-error').hidden = true;
  renderBrowse();
  $('browse-dialog').showModal();
});
$('browse-filter').addEventListener('input', renderBrowse);
$('browse-close').addEventListener('click', () => $('browse-dialog').close());

// --- the address box above the preview ------------------------------------------

let pagesFor = null; // the site whose pages are in the list

async function loadPages(slug) {
  pagesFor = slug;
  try {
    const { pages } = await api('GET', '/api/pages');
    $('page-list').replaceChildren(...pages.map((p) => Object.assign(document.createElement('option'), { value: p.path, label: p.file })));
  } catch { pagesFor = null; /* the box still takes a typed address */ }
}

let sitePageList = []; // [{ path, file }] as last loaded

// "Our Story" becomes our-story.html, the way the server will name it.
function pageNameFor(title) {
  const stem = String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return stem ? `${stem}.html` : '';
}

$('new-page-btn').addEventListener('click', async () => {
  const form = $('page-form');
  form.reset();
  $('page-error').hidden = true;
  form.dataset.typedName = '';
  try { sitePageList = (await api('GET', '/api/pages')).pages; } catch (err) { return showProblem(err.message); }
  if (!sitePageList.length) return showProblem('This site has no HTML page to copy yet. Ask the AI to make the first one.');
  form.elements.from.replaceChildren(...sitePageList.map((p) => Object.assign(document.createElement('option'), { value: p.file, textContent: `${p.path}  (${p.file})` })));
  // The page on screen is the likeliest one to copy.
  const showing = sitePageList.find((p) => p.path === framePath.split(/[?#]/)[0]);
  if (showing) form.elements.from.value = showing.file;
  $('page-address').textContent = 'Letters, numbers and dashes. This is the page\'s address.';
  $('page-dialog').showModal();
});
$('page-cancel').addEventListener('click', () => $('page-dialog').close());
$('page-form').addEventListener('input', (e) => {
  const form = $('page-form');
  if (e.target.name === 'name') form.dataset.typedName = '1';
  if (e.target.name === 'title' && !form.dataset.typedName) form.elements.name.value = pageNameFor(form.elements.title.value);
});
$('page-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = $('page-form');
  const problem = $('page-error');
  problem.hidden = true;
  try {
    const made = await api('POST', '/api/pages/new', { from: form.elements.from.value, name: form.elements.name.value, title: form.elements.title.value });
    $('page-dialog').close();
    refreshChanges(0);
    loadPages(pagesFor);
    if (frameUrl) setTimeout(() => goToPage(made.path), 300);
    const input = $('chat-input');
    if (!input.value.trim()) {
      input.value = `I made a new page, ${made.file}, as a copy of ${made.from}. Add a link to it in the menu on every page, and change its content to: `;
      if (!input.disabled) input.focus();
    }
  } catch (err) {
    problem.textContent = err.message;
    problem.hidden = false;
  }
});

// Show another page of the site in the preview. Edit on page stays as it is.
function goToPage(typed) {
  if (!frameUrl) return;
  let path = String(typed || '').trim();
  try { const u = new URL(path); path = u.pathname + u.search + u.hash; } catch { /* not a full address */ }
  if (!path.startsWith('/')) path = '/' + path;
  if (path.startsWith('//')) path = '/' + path.replace(/^\/+/, ''); // never another website
  framePath = path;
  pick = null;
  renderPointing();
  $('frame').src = frameUrl + path;
}

$('path-form').addEventListener('submit', (e) => { e.preventDefault(); goToPage($('preview-path').value); $('preview-path').blur(); });
// Choosing from the list goes there at once, without Enter.
$('preview-path').addEventListener('input', (e) => {
  if (e.inputType === 'insertReplacementText' || e.inputType === undefined) goToPage(e.target.value);
});
$('preview-path').addEventListener('focus', (e) => { e.target.select(); if (pagesFor) loadPages(pagesFor); });
$('preview-path').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = framePath; e.target.blur(); } });

// --- edit on page ---------------------------------------------------------------

let editMode = false;
let pick = null;           // what the owner is pointing at, sent with the next message
let replaceTarget = null;  // { file, page } while a clicked picture is being replaced
const EDIT_HINT = 'Click something on the page for its toolbar: replace a picture, change text, make a link, ask the AI, or delete. Double-click text to change it straight away. Links and buttons on the page do not work while this is on.';

function tellFrame(message) {
  const frame = $('frame');
  if (frameUrl && frame.contentWindow) frame.contentWindow.postMessage(message, frameUrl);
}

// Stop pointing: the chip under the message box goes, and so does the toolbar on the page.
function clearPick() {
  pick = null;
  renderPointing();
  tellFrame({ roadie: 'unpick' });
}

function sendEditMode() { tellFrame({ roadie: 'edit', on: editMode }); }

function setEditMode(next) {
  editMode = next;
  $('edit-btn').setAttribute('aria-pressed', String(editMode));
  $('edit-bar').hidden = !editMode;
  $('edit-status').textContent = EDIT_HINT;
  sendEditMode();
}

function renderPointing() {
  const box = $('pointing');
  box.hidden = !pick;
  if (!pick) return box.replaceChildren();
  const what = pick.image ? `the image ${pick.image.file || pick.image.attr}` : `<${pick.tag}>${pick.text ? ` “${pick.text.slice(0, 50)}${pick.text.length > 50 ? '…' : ''}”` : ''}`;
  const parts = [span(`Pointing at ${what} on ${pick.page}`)];
  parts[0].title = pick.selector;
  if (pick.image && pick.image.file) {
    const swap = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Replace image…' });
    swap.addEventListener('click', replacePicked);
    parts.push(swap);
  }
  const drop = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: 'Stop pointing at this' });
  drop.setAttribute('aria-label', 'Stop pointing at this');
  drop.addEventListener('click', clearPick);
  parts.push(drop);
  box.replaceChildren(...parts);
}

async function setPick(next) {
  pick = next;
  renderPointing();
  if (!$('chat-input').disabled) $('chat-input').focus();
  if (next.image && next.image.path) {
    try {
      const { file } = await api('POST', '/api/edit/locate', { path: next.image.path });
      if (pick === next && file) { next.image.file = file; renderPointing(); }
    } catch { /* pointing still works without the file name */ }
  }
}

function replacePicked() {
  replaceTarget = { file: pick.image.file, page: pick.page };
  $('file-picker').click();
}

// A button on the page's toolbar was pressed.
async function pageAction(action, next) {
  const status = $('edit-status');
  const input = $('chat-input');
  await setPick(next);
  if (pick !== next) return; // the owner has moved on
  if (action === 'replace') {
    if (next.image && next.image.file) return replacePicked();
    status.textContent = 'Roadie cannot tell which file in the site that picture is (it may come from another website). Tell the AI what to put there instead.';
    return;
  }
  if (action === 'ask') {
    status.textContent = 'Type what the AI should do with it in the message box.';
    input.classList.remove('nudge');
    void input.offsetWidth; // start the highlight again
    input.classList.add('nudge');
    return;
  }
  if (action === 'link') {
    const form = $('link-form');
    form.reset();
    $('link-error').hidden = true;
    $('link-title').textContent = next.link ? 'Change this link' : 'Link to';
    $('link-what').textContent = next.link ? `It goes to ${next.link} now.` : `${next.image ? 'This picture' : `“${(next.text || `<${next.tag}>`).slice(0, 60)}”`} will become a link.`;
    if (pagesFor) loadPages(pagesFor);
    linkFor = next;
    $('link-dialog').showModal();
    return;
  }
  if (action !== 'delete') return;
  askAboutPick(next, 'Remove this element from the page. Tidy up anything that is left empty or broken by taking it out.',
    'Asked the AI to remove it. Use Undo last reply if it takes out too much.', 'A request to remove it is in the message box: press Send when you are ready.');
}

// Send the AI a request about the element being pointed at, or, when the
// message box is in use or the AI is busy, leave the request there to send later.
async function askAboutPick(next, request, sentText, waitingText) {
  const status = $('edit-status');
  const input = $('chat-input');
  if (input.disabled || chatBusy || input.value.trim() || attachments.length) {
    input.value = (input.value.trim() ? input.value.trim() + '\n\n' : '') + request;
    status.textContent = waitingText;
    return;
  }
  try {
    await api('POST', '/api/chat/send', { text: request, images: [], page: framePath, pick: next });
    status.textContent = sentText;
    if (pick === next) clearPick();
  } catch (err) {
    showProblem(err.message);
  }
}

let linkFor = null; // the element the link dialog is about
$('link-cancel').addEventListener('click', () => $('link-dialog').close());
$('link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const problem = $('link-error');
  problem.hidden = true;
  try {
    const { text } = await api('POST', '/api/edit/link', { where: linkFor, to: $('link-form').elements.to.value });
    $('link-dialog').close();
    await askAboutPick(linkFor, text, 'Asked the AI to make the link. Use Undo last reply if it is not what you wanted.', 'A request to make the link is in the message box: press Send when you are ready.');
  } catch (err) {
    problem.textContent = err.message;
    problem.hidden = false;
  }
});

// Text was changed on the page: have Roadie write it to the site's file, or
// put a request for the AI in the message box when it cannot tell where.
async function applyPageText(edit) {
  const status = $('edit-status');
  status.textContent = 'Saving…';
  const reloadFrame = () => { if (frameUrl) $('frame').src = frameUrl + framePath; };
  try {
    const result = await api('POST', '/api/edit/text', { where: edit.where, changes: edit.changes, beforeText: edit.beforeText, afterText: edit.afterText });
    if (result.ok) {
      status.textContent = `Changed in ${result.files.join(', ')}.`
        + (result.alsoIn.length ? ` The same words are also in ${result.alsoIn.join(', ')}; ask the AI if ${result.alsoIn.length === 1 ? 'it' : 'they'} should change too.` : '');
      return refreshChanges(0);
    }
    const input = $('chat-input');
    input.value = (input.value.trim() ? input.value.trim() + '\n\n' : '') + result.ask.text;
    status.textContent = `${result.ask.why} A request for the AI is in the message box: check it and press Send.`;
    // The AI is told exactly which element this was.
    pick = edit.where;
    renderPointing();
    if (!input.disabled) input.focus();
    reloadFrame(); // the page goes back to what the files say
  } catch (err) {
    status.textContent = EDIT_HINT;
    showProblem(err.message);
    reloadFrame();
  }
}

$('edit-btn').addEventListener('click', () => setEditMode(!editMode));

// --- preview width --------------------------------------------------------------

function applyPreviewWidth() {
  const width = $('preview-width').value;
  $('frame').style.width = width ? `${width}px` : '';
  document.querySelector('.preview-body').classList.toggle('narrow', !!width);
}
try { $('preview-width').value = localStorage.getItem('roadie.previewWidth') || ''; } catch { /* full width */ }
$('preview-width').addEventListener('change', () => {
  applyPreviewWidth();
  try { localStorage.setItem('roadie.previewWidth', $('preview-width').value); } catch { /* not remembered */ }
});
applyPreviewWidth();

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

// The model name box is only for a model that is not in the list.
function showModelOther() {
  const form = $('ai-form');
  const other = form.elements.modelChoice.value === '';
  $('model-other').hidden = !other;
  if (!other) form.elements.model.value = form.elements.modelChoice.value;
}

function showAiSettings() {
  const { ai } = state;
  if (!ai) return;
  const form = $('ai-form');
  form.elements.provider.value = ai.provider;
  form.elements.model.value = ai.model;
  const listed = [...form.elements.modelChoice.options].some((o) => o.value && o.value === ai.model);
  form.elements.modelChoice.value = listed ? ai.model : '';
  showModelOther();
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
    if (h.live) box.append(span(`${which === 'staging' ? 'Staging' : 'Production'} is live on ${h.seen || h.waitingFor}. `, 'ok'), link(deployedSite(h), 'Open it'));
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
    // A first release has no earlier version to step up from: offer the two usual starting points.
    const choices = plan.versions.latest
      ? [['patch', plan.versions.patch], ['minor', plan.versions.minor], ['major', plan.versions.major]]
      : [['still taking shape', plan.versions.minor], ['ready for the public', plan.versions.major]];
    for (const [kind, tag] of choices) {
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
  if ((!text && !attachments.length) || chatBusy) return;
  if (!text && pick) return; // pointing needs words: what should happen to it?
  try {
    const images = await Promise.all(attachments.map(async (a) => ({ name: a.name, data: await toBase64(a.blob) })));
    await api('POST', '/api/chat/send', { text, images, page: framePath, ...(pick ? { pick } : {}) });
    input.value = '';
    clearPick();
    for (const a of attachments) URL.revokeObjectURL(a.url);
    attachments.length = 0;
    renderAttachments();
  } catch (err) {
    showProblem(err.message);
  }
});
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); }
});
$('stop-chat').addEventListener('click', () => api('POST', '/api/chat/stop').catch((err) => showProblem(err.message)));
$('undo-reply-btn').addEventListener('click', async () => {
  if (!confirm("Put every file back as it was before the AI's last reply?\n\nAnything changed since then, by the AI or by you, is set aside with \"git stash\", so it can be recovered.")) return;
  try {
    await api('POST', '/api/chat/undo');
    refreshChanges(0);
  } catch (err) { showProblem(err.message); }
});
$('new-chat-btn').addEventListener('click', () => api('POST', '/api/chat/new').then(setState, (err) => showProblem(err.message)));

$('ai-btn').addEventListener('click', showAiSettings);
$('ai-cancel').addEventListener('click', () => $('ai-dialog').close());
$('ai-form').addEventListener('change', (e) => { if (e.target.name === 'modelChoice') showModelOther(); if (e.target.name === 'provider') { showAiProvider(); if (e.target.value === 'ollama') loadOllamaModels(); } });
$('ollama-refresh').addEventListener('click', loadOllamaModels);
$('ai-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ai = Object.fromEntries(new FormData(e.target));
  delete ai.modelChoice; // the list only fills in "model"
  $('ai-dialog').close();
  try { setState(await api('POST', '/api/ai', { ai })); } catch (err) { showProblem(err.message); }
});

// The previewed page reports where it is, so the path and "open in new tab" follow it.
window.addEventListener('message', (e) => {
  if (!frameUrl || e.origin !== frameUrl || e.source !== $('frame').contentWindow || !e.data) return;
  const data = e.data;
  if (data.roadie === 'page') {
    frameSpoke = true;
    framePath = typeof data.path === 'string' && data.path.startsWith('/') ? data.path : '/';
    render();
    return sendEditMode(); // a page that has just loaded needs telling
  }
  // What was clicked or typed only counts while the owner has Edit on page switched on.
  if (!editMode) return;
  if (data.roadie === 'pick' && data.pick) setPick(data.pick);
  else if (data.roadie === 'unpick') { pick = null; renderPointing(); }
  else if (data.roadie === 'action' && data.pick && ['replace', 'ask', 'delete', 'link'].includes(data.action)) pageAction(data.action, data.pick);
  else if (data.roadie === 'text' && data.where) applyPageText(data);
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
