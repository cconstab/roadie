'use strict';

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="roadie-token"]').content;

let state = { checks: [], site: null, preview: { state: 'stopped' }, busy: null };
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
  state = next;
  render();
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
events.addEventListener('changed', () => {
  // Pages normally reload themselves. If the site's policy blocked the reload
  // script, reload the frame from here instead.
  if (frameUrl && !frameSpoke && state.preview.state === 'running') $('frame').src = frameUrl + framePath;
});

api('GET', '/api/state').then((s) => {
  for (const entry of s.logs || []) appendLog(entry);
  setState(s);
  if (s.site) $('repo').value = s.site.key;
}, (err) => showProblem(err.message));
