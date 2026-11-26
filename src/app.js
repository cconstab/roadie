// Roadie's own web server: the interface and its API, on 127.0.0.1 only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiStatus, createChat, draftPullRequest } from './agent.js';
import { cleanAi, cleanSettings } from './config.js';
import { detect } from './detect.js';
import { createFlow } from './flow.js';
import { checkSitePath, isSecretPath } from './guards.js';
import { guideText, hostingGuide } from './guide.js';
import { applyTextEdit, cleanPick, editRequest, linkRequest, locateImage, newPage, pickContext, pickLabel, sitePages } from './pageedit.js';
import { createPreviewProxy } from './proxy.js';
import { Runner } from './runner.js';
import { openSite, parseRepo } from './sites.js';
import { blankKind, starterFileList, writeStarter } from './starter.js';
import { capturePage } from './screenshot.js';
import { runTests } from './tests.js';
import { MAX_UPLOAD_BYTES, addFile, browseFiles, cleanChatImages, cleanUploadPath, imageType, removeFile, uploadFolders } from './uploads.js';
import { protectRoadie, sandboxAvailable } from './sandbox.js';
import { createRestartGuard, needsRestart, watchSite } from './watcher.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const MAX_LOG_LINES = 500;
const MAX_DIFF_CHARS = 200_000;
const MAX_JSON_BYTES = 1_000_000;
// Routes that carry files, and how much they may carry.
const MAX_KEPT_ITEMS = 300; // chat lines kept per site
const BIG_JSON = { 'POST /api/chat/send': 36_000_000 };          // up to five 5 MB images, in base64
const RAW_BODY = { 'POST /api/files/add': MAX_UPLOAD_BYTES };    // the file's own bytes

// The Agent SDK is loaded on first use, so Roadie starts quickly and tests can pass a fake.
async function loadSdk() {
  try {
    const [sdk, { z }] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
    return { sdk, z };
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error("The AI's software is not installed. Run \"npm install\" in Roadie's folder, then start Roadie again.");
    }
    throw err;
  }
}

// updater: { check(), apply(tag), stop() } from main.js; left out in tests, so they never go looking for releases.
export async function createApp({ home, gitops, config, agentSdk = loadSdk, flowOptions = {}, updater = null }) {
  const token = crypto.randomBytes(24).toString('base64url'); // per run; proves a request came from Roadie's own page
  // The page (and so the token) is only given to a browser that arrived with this
  // key, which is in the link Roadie prints and opens at start. That browser gets a
  // cookie; nothing else on the machine can ask for the page and read the token.
  const launchKey = crypto.randomBytes(24).toString('base64url');
  // The cookie has its own secret, separate from the token, and its name carries
  // the port so that two Roadies running side by side do not log each other out.
  const session = crypto.randomBytes(24).toString('base64url');
  const cookieName = () => `roadie_session_${port}`;
  const hasSession = (req) => String(req.headers.cookie || '').split(';').some((c) => c.trim() === `${cookieName()}=${session}`);
  const runner = new Runner();
  const proxy = createPreviewProxy({
    getTarget: () => (runner.status.state === 'running' ? { host: runner.status.host, port: runner.status.port } : null),
  });
  const proxyPort = await proxy.listen(0);

  let port = null;
  let checks = [];
  let update = null; // a newer release, when there is one: see update.js
  let updateTimer = null;
  let site = null; // { key, owner, repo, dir, branch, defaultBranch, note, settings, notes, saved }
  let watcher = null;
  let busy = null; // short text while a long step runs
  const restartGuard = createRestartGuard();
  let restartsPaused = false;
  let chat = null; // the conversation with the AI about the open site
  let viewing = '/';       // the page the owner has in the preview, as the browser last said
  let beforeReply = null;  // { dir, tree }: the files as they were before the AI's last reply
  let undone = false;      // the owner undid a reply the AI still believes it made
  let history = [];        // the chat about the open site so far, kept across restarts

  // Each site's chat is kept in Roadie's own folder, never in the site's repo.
  const chatFile = (s) => path.join(home, 'chats', `${s.owner}__${s.repo}.json`.replace(/[^A-Za-z0-9._-]/g, '_'));
  function loadHistory(s) {
    try {
      const saved = JSON.parse(fs.readFileSync(chatFile(s), 'utf8'));
      return Array.isArray(saved.items) ? saved.items.filter((i) => i && typeof i.text === 'string' && typeof i.role === 'string').slice(-MAX_KEPT_ITEMS) : [];
    } catch { return []; }
  }
  function saveHistory() {
    if (!site) return;
    const items = (chat ? chat.items : history).slice(-MAX_KEPT_ITEMS);
    try {
      if (!items.length) return fs.rmSync(chatFile(site), { force: true });
      fs.mkdirSync(path.dirname(chatFile(site)), { recursive: true });
      fs.writeFileSync(chatFile(site), JSON.stringify({ site: site.key, items }), { mode: 0o600 });
    } catch { /* the chat still works; it is just not kept */ }
  }
  let ai = config.getAi();
  const logs = [];
  const clients = new Set();

  function send(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  }

  function snapshot() {
    const s = runner.status;
    const running = s.state === 'running';
    return {
      checks,
      update,
      busy,
      site: site && { ...site },
      starterFiles: starterFileList(),
      knownSites: config.siteKeys(),
      ai: { ...ai, status: aiStatus(ai), keyFound: aiStatus({ ...ai, provider: 'anthropic' }).ready },
      chat: { canUndo: !!(beforeReply && site && beforeReply.dir === site.dir), items: chat ? chat.items : history, busy: chat ? chat.busy : false, info: chat ? chat.info : null, usage: chat ? chat.usage : null },
      preview: {
        state: s.state,
        mode: s.mode,
        error: s.error,
        url: running ? `http://127.0.0.1:${proxyPort}` : null,
        directUrl: running ? `http://${s.host === '::1' ? '[::1]' : '127.0.0.1'}:${s.port}` : null,
      },
    };
  }
  const pushState = () => send('state', snapshot());

  // The change bar: branch, tests, pull request, CI, merge, staging, release, production.
  const flow = createFlow({
    gitops, config, runTests,
    getSite: () => site,
    emit: (update) => send('change', update),
    draftPr: async (input) => {
      const { sdk } = await agentSdk();
      return draftPullRequest({ sdk, ai, ...input });
    },
    ...flowOptions,
  });

  runner.on('status', pushState);
  runner.on('log', (entry) => {
    logs.push(entry);
    if (logs.length > MAX_LOG_LINES) logs.shift();
    send('log', entry);
  });

  // One preview operation at a time.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function startPreview() {
    if (!site) throw new Error('Open a site first.');
    const { start, install, port: portHint } = site.settings;
    await runner.start({ dir: site.dir, command: start, install, portHint, openNetwork: site.settings.previewInternet });
    restartGuard.started();
    proxy.reload();
  }

  function watch() {
    watcher?.close();
    watcher = watchSite({
      dir: site.dir,
      gitops,
      onChange(files) {
        send('changed', { files });
        flow.notify();
        const state = runner.status.state;
        if (runner.status.mode === 'command' && (state === 'running' || state === 'failed') && needsRestart(files)) {
          // A site that writes into its own folder as it starts would restart itself for ever.
          if (!restartGuard.allow(files)) {
            if (!restartsPaused) runner.log(`The site changes these files itself each time it starts (${files.join(', ')}), so Roadie is not restarting it for them. Add them to the site's .gitignore. Restart still works.`);
            restartsPaused = true;
            return proxy.reload();
          }
          restartsPaused = false;
          runner.log(`Changed: ${files.join(', ')}. Restarting the site.`);
          serial(startPreview).catch((err) => runner.log(err.message));
        } else {
          proxy.reload();
        }
      },
    });
  }

  // `forget` is New chat: the list is cleared. Otherwise what was said stays on
  // screen, and the next AI process is told about it in brief.
  function endChat({ forget = false } = {}) {
    if (forget) history = [];
    else if (chat) history = chat.items.slice();
    chat?.close();
    chat = null;
    if (forget) saveHistory();
  }

  async function ensureChat() {
    if (!site) throw new Error('Open a site first.');
    if (!chat) {
      const status = aiStatus(ai);
      if (!status.ready) throw new Error(status.problem);
      const { sdk, z } = await agentSdk();
      const runAndRecord = async (options) => {
        const started = await flow.beginTests();
        const result = await runTests({ ...options, tracked: await gitops.trackedFiles(options.dir).catch(() => null) });
        await flow.recordTests(started, result).catch(() => {});
        return result;
      };
      // The AI's eyes: a picture of a page of the running site, taken on this machine.
      const lookAtPage = async ({ page, size }) => {
        const base = snapshot().preview.directUrl;
        const shown = page || viewing || '/';
        const shot = await capturePage({ base, page: shown, size });
        return { ...shot, page: shown };
      };
      chat = createChat({
        sdk, z, gitops, site, ai, runTests: runAndRecord, lookAtPage, history,
        emit: (update) => {
          send('chat', update);
          if (update.op === 'busy' && !update.busy) saveHistory(); // a reply has finished
        },
      });
    }
    return chat;
  }

  async function open(repoInput) {
    const { owner, repo, key } = parseRepo(repoInput);
    if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish before opening another site.`);
    if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before opening another site.');
    busy = `Opening ${key}…`;
    pushState();
    try {
      await serial(() => runner.stop());
      endChat();
      watcher?.close();
      watcher = null;
      logs.length = 0;
      const opened = await openSite({ gitops, home, owner, repo });
      const found = detect(opened.dir);
      // 'empty' or 'bare' when there is no site in the repo yet
      const blank = blankKind(await gitops.listFiles(opened.dir));
      const saved = config.getSite(key);
      site = {
        key, owner, repo,
        dir: opened.dir,
        branch: opened.branch,
        defaultBranch: opened.defaultBranch,
        note: opened.note,
        detected: found.settings,
        notes: found.notes,
        settings: saved || cleanSettings(found.settings),
        saved: !!saved,
        blank,
      };
      history = loadHistory(site);
      beforeReply = null;
      watch();
      flow.refresh().then(() => flow.notify(), () => flow.notify());
    } finally {
      busy = null;
      pushState();
    }
  }

  const routes = {
    'GET /api/state': async () => ({ ...snapshot(), logs }),
    'POST /api/open': async (body) => { await open(body.repo); return snapshot(); },
    'POST /api/settings': async (body) => {
      if (!site) throw new Error('Open a site first.');
      site.settings = config.saveSite(site.key, body.settings);
      site.saved = true;
      pushState();
      return snapshot();
    },
    'POST /api/preview/start': async () => { await serial(startPreview); return snapshot(); },
    'POST /api/preview/stop': async () => { await serial(() => runner.stop()); return snapshot(); },

    // Put the starter site into a repo that has nothing in it yet.
    'POST /api/starter': async (body) => {
      if (!site) throw new Error('Open a site first.');
      if (!site.blank) throw new Error('This repo already has files in it, so Roadie will not add the starter site.');
      const result = writeStarter(site.dir, { owner: site.owner, repo: site.repo, title: body.title, domain: body.domain });
      const found = detect(site.dir);
      site.detected = found.settings;
      site.notes = found.notes;
      if (!site.saved) site.settings = cleanSettings(found.settings);
      site.blank = null;
      site.starter = { written: result.written, skipped: result.skipped };
      pushState();
      return snapshot();
    },

    'GET /api/guide': async () => {
      if (!site) throw new Error('Open a site first.');
      return { guide: hostingGuide(site), done: config.getGuideDone(site.key) };
    },
    'POST /api/guide/done': async (body) => {
      if (!site) throw new Error('Open a site first.');
      return { done: config.setGuideDone(site.key, body.id, !!body.done) };
    },
    // Ask the AI to talk the person through the guide, or one step of it.
    'POST /api/guide/ask': async (body) => {
      if (!site) throw new Error('Open a site first.');
      const guide = hostingGuide(site);
      const done = new Set(config.getGuideDone(site.key));
      const step = guide.steps.find((s) => s.id === body.id) || guide.steps.find((s) => !done.has(s.id)) || guide.steps[0];
      const finished = guide.steps.filter((s) => done.has(s.id)).map((s) => s.number);
      const text = body.id
        ? `Help me with step ${step.number} of the hosting guide: ${step.title}.`
        : `Talk me through putting this site on a server, one step at a time. Start at step ${step.number}: ${step.title}.`;
      const context = `This is Roadie's hosting guide for this site. Steps already ticked off: ${finished.length ? finished.join(', ') : 'none'}.\n\n${guideText(guide)}`;
      (await ensureChat()).send(text, { context });
      return { ok: true };
    },

    'POST /api/chat/send': async (body) => {
      const images = cleanChatImages(body.images);
      // What the owner clicked in the preview goes along as background for the AI.
      const pick = cleanPick(body.pick);
      if (typeof body.page === 'string' && body.page.startsWith('/')) viewing = body.page.slice(0, 500);
      const ready = await ensureChat();
      if (ready.busy) throw new Error('The AI is still working. Wait for it to finish, or press Stop.');
      // Remember the files as they are now, so this reply can be undone as a whole.
      beforeReply = null;
      try {
        if (site && await gitops.hasCommits(site.dir)) beforeReply = { dir: site.dir, tree: await gitops.treeId(site.dir) };
      } catch { beforeReply = null; /* no snapshot: the reply cannot be undone as a whole, and the button stays off */ }
      const context = [
        undone ? 'The owner has undone the file changes from your last reply: the files are as they were before it. Read a file again before you rely on what you remember of it.' : '',
        pick ? pickContext(pick) : '',
      ].filter(Boolean).join('\n\n');
      ready.send(body.text, { images, ...(context ? { context } : {}), ...(pick ? { note: pickLabel(pick) } : {}) });
      undone = false;
      pushState();
      return { ok: true };
    },

    // Put the files back as they were before the AI's last reply. The edits are kept in the stash.
    'POST /api/chat/undo': async () => {
      if (!site) throw new Error('Open a site first.');
      if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before undoing.');
      if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish.`);
      if (!beforeReply || beforeReply.dir !== site.dir) throw new Error('There is no reply to undo.');
      if (await gitops.treeId(site.dir) === beforeReply.tree) { beforeReply = null; pushState(); throw new Error('The last reply did not change any file, so there is nothing to undo.'); }
      const result = await gitops.restoreTree(site.dir, beforeReply.tree);
      beforeReply = null;
      undone = true;
      if (chat) chat.note('You undid the changes from the last reply. The files are as they were before it; the undone edits are kept in the stash.');
      saveHistory();
      flow.notify();
      pushState();
      return result;
    },

    // --- Edit on page: what the owner clicked or typed in the preview ---
    // The words to send the AI for a link chosen from the page's toolbar.
    'POST /api/edit/link': async (body) => {
      if (!site) throw new Error('Open a site first.');
      const where = cleanPick(body.where);
      if (!where) throw new Error('Malformed request.');
      return { text: linkRequest(where, body.to) };
    },
    // Which file is the picture they clicked?
    'POST /api/edit/locate': async (body) => {
      if (!site) throw new Error('Open a site first.');
      return { file: locateImage(await gitops.listFiles(site.dir), body.path) };
    },
    // Text reworded on the page. It is written to a file only when the old text
    // is found in exactly one place; otherwise the answer is a request for the AI.
    'POST /api/edit/text': async (body) => {
      if (!site) throw new Error('Open a site first.');
      if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before editing on the page.');
      if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish.`);
      const where = cleanPick(body.where);
      if (!where) throw new Error('Malformed request.');
      const result = Array.isArray(body.changes)
        ? await applyTextEdit({ gitops, dir: site.dir, page: where.page, changes: body.changes })
        : { ok: false, reason: 'unclear', files: [] };
      if (result.ok) { flow.notify(); return result; }
      return { ok: false, ask: editRequest({ where, beforeText: body.beforeText, afterText: body.afterText, result }) };
    },

    // --- files the owner adds by hand: images, fonts, documents ---
    // The site's pages, for the address box above the preview.
    'GET /api/pages': async () => {
      if (!site) throw new Error('Open a site first.');
      return { pages: sitePages(await gitops.listFiles(site.dir)) };
    },
    // A new page, as a copy of an existing one. Written on this machine only.
    'POST /api/pages/new': async (body) => {
      if (!site) throw new Error('Open a site first.');
      if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before adding a page.');
      if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish.`);
      const made = newPage({ dir: site.dir, files: await gitops.listFiles(site.dir), from: String(body.from || ''), name: body.name, title: body.title });
      flow.notify();
      return made;
    },
    // Every file in the site, for the owner to look through.
    'GET /api/files': async () => {
      if (!site) throw new Error('Open a site first.');
      return { files: browseFiles(site.dir, await gitops.listFiles(site.dir)) };
    },
    // The owner deletes one file by hand. It shows under Changed files, where Undo brings it back.
    'POST /api/files/delete': async (body) => {
      if (!site) throw new Error('Open a site first.');
      if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before deleting a file.');
      if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish.`);
      const removed = removeFile(site.dir, String(body.path || ''));
      flow.notify();
      return removed;
    },
    'GET /api/files/folders': async () => {
      if (!site) throw new Error('Open a site first.');
      return uploadFolders(await gitops.listFiles(site.dir));
    },
    // One file per request: the body is the file, the address says where it goes.
    'POST /api/files/add': async (data, { url }) => {
      if (!site) throw new Error('Open a site first.');
      const rel = cleanUploadPath(url.searchParams.get('folder'), url.searchParams.get('name'));
      const added = addFile(site.dir, rel, data, { replace: url.searchParams.get('replace') === '1' });
      const ignored = await gitops.ignored(site.dir, [added.path]).catch(() => new Set());
      return { ...added, ignored: ignored.has(added.path) };
    },
    'POST /api/chat/stop': async () => { await chat?.stop(); return { ok: true }; },
    'POST /api/chat/new': async () => { endChat({ forget: true }); beforeReply = null; pushState(); return snapshot(); },

    'GET /api/changes': async () => {
      if (!site) return { files: [] };
      const files = (await gitops.changes(site.dir, flow.base())).map((f) => {
        if (isSecretPath(f.path)) return { ...f, diff: '', hidden: 'Not shown: this looks like a secrets file.' };
        if (f.diff.length > MAX_DIFF_CHARS) return { ...f, diff: f.diff.slice(0, MAX_DIFF_CHARS), hidden: 'This diff is long, so only the start is shown.' };
        return f;
      });
      // Undo keeps the edits in git stash, which a repo with no commits does not have.
      return { files, undoKeeps: await gitops.hasCommits(site.dir) };
    },

    // Put one changed file back as it was. The edits go into git stash, so they can be recovered.
    'POST /api/changes/undo': async (body) => {
      if (!site) throw new Error('Open a site first.');
      if (chat && chat.busy) throw new Error('The AI is still working. Stop it, or wait, before undoing a file.');
      if (flow.busy) throw new Error(`Roadie is in the middle of a step (${flow.busy}). Wait for it to finish.`);
      const base = flow.base();
      const change = (await gitops.changes(site.dir, base)).find((f) => f.path === body.path);
      if (!change) throw new Error(`${body.path} has no changes to undo.`);
      const result = await gitops.restoreFile(site.dir, base, change);
      flow.notify();
      return { ok: true, ...result };
    },

    // --- the change bar ---
    'GET /api/change': async () => flow.view(),
    'POST /api/change/refresh': async () => flow.refresh(),
    'POST /api/change/start': async (body) => { const v = await flow.start(body); pushState(); return v; },
    'POST /api/change/tests': async () => flow.tests(),
    // An outward step is shown first (prepare) and only then carried out (confirm).
    'POST /api/change/prepare': async (body) => flow.prepare(String(body.action || ''), body.input || {}),
    'POST /api/change/confirm': async (body) => {
      const v = await flow.confirm(String(body.token || ''), String(body.action || ''), body.edits || {});
      pushState();
      return v;
    },
    'POST /api/change/health': async (body) => { flow.health(body.which, { stop: !!body.stop }); return flow.view(); },
    'POST /api/change/finish': async () => { const v = await flow.finish(); pushState(); return v; },
    'POST /api/change/ask-ai': async (body) => {
      const { text, context } = await flow.aiRequest(body.kind);
      (await ensureChat()).send(text, { context });
      return { ok: true };
    },

    'POST /api/ai': async (body) => {
      ai = config.saveAi(body.ai);
      endChat(); // a different AI starts a fresh conversation
      pushState();
      return snapshot();
    },
    // Install the newer release the interface is showing. Only ever started by this button.
    'POST /api/update': async () => {
      if (!updater || !update) throw new Error('There is no update to install.');
      if (!update.installed) throw new Error(update.how);
      const result = await updater.apply(update.latest);
      update = null;
      pushState();
      setTimeout(() => updater.stop?.(), 800).unref(); // after this answer has gone out
      return result;
    },
    // Ask a local Ollama which models it has.
    'POST /api/ai/models': async (body) => {
      const { ollamaUrl } = cleanAi({ ollamaUrl: body.ollamaUrl });
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`it answered ${res.status}`);
        const data = await res.json();
        return { models: (data.models || []).map((m) => m.name).sort() };
      } catch (err) {
        throw new Error(`Could not reach Ollama at ${ollamaUrl} (${err.message}). Is it running?`);
      }
    },
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let over = false;
      req.on('data', (c) => {
        size += c.length;
        // Keep reading (and dropping) so the answer can still be sent; then refuse.
        if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
      });
      req.on('end', () => (over
        ? reject(new Error(`That is too large to send: the limit here is ${Math.floor(limit / 1_000_000)} MB.`))
        : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  async function readJson(req, limit) {
    const raw = await readBody(req, limit);
    try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
    catch { throw new Error('Malformed request.'); }
  }

  // A picture from the site's folder, for the changed-files pane. Pictures only,
  // through the same gate as every other file, and marked so that a browser
  // will never run one (an SVG can hold script) as part of Roadie's page.
  function sendSiteImage(res, rel) {
    const type = imageType(rel);
    const checked = site && type ? checkSitePath(site.dir, rel) : { ok: false };
    let data = null;
    if (checked.ok) {
      try { if (fs.statSync(checked.abs).size <= MAX_UPLOAD_BYTES) data = fs.readFileSync(checked.abs); } catch { /* not there */ }
    }
    if (!data) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // Only answer requests addressed to this machine, and only from Roadie's own page.
    // This keeps other websites, and the previewed site itself, away from the API.
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return json(403, { error: 'Wrong host.' });
    const origin = req.headers.origin;
    if (origin && !hosts.some((h) => origin === `http://${h}`)) return json(403, { error: 'Wrong origin.' });

    const url = new URL(req.url, 'http://local');

    // Arriving with the launch key earns the session cookie.
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) {
      const given = Buffer.from(String(url.searchParams.get('key')));
      const wanted = Buffer.from(launchKey);
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return json(403, { error: 'That link is not valid for this run of Roadie.' });
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!hasSession(req)) {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><title>Roadie</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.3rem">Open Roadie from its own link</h1><p>For safety, Roadie only opens from the link it prints in the terminal when it starts. Use that link, or stop Roadie and run <code>npm start</code> again.</p>');
      }
      return json(403, { error: 'This request did not come from the Roadie window. Open Roadie from the link it printed when it started.' });
    }

    if (req.method === 'GET' && PUBLIC_FILES[url.pathname]) {
      const [name, type] = PUBLIC_FILES[url.pathname];
      let body = fs.readFileSync(path.join(PUBLIC_DIR, name));
      if (name === 'index.html') body = body.toString('utf8').replace('__ROADIE_TOKEN__', token);
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; " +
          "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // An <img> cannot send the token, so pictures are let through on the session cookie alone.
    // Browsers say where a request came from: only Roadie's own page may ask, not the previewed site.
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const from = req.headers['sec-fetch-site'];
      if (from && from !== 'same-origin') return json(403, { error: 'Wrong origin.' });
      return sendSiteImage(res, url.searchParams.get('path') || '');
    }

    const route = `${req.method} ${url.pathname}`;
    const handler = routes[route];
    if (!handler) return json(404, { error: 'No such route.' });
    if (req.headers['x-roadie-token'] !== token) return json(403, { error: 'This request did not come from the Roadie window. Reload the page.' });
    try {
      const body = req.method !== 'POST' ? {}
        : RAW_BODY[route] ? await readBody(req, RAW_BODY[route])
        : await readJson(req, BIG_JSON[route] || MAX_JSON_BYTES);
      json(200, await handler(body, { url }));
    } catch (err) {
      json(400, { error: err.message, ...(err.data || {}) });
    }
  });

  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
  ping.unref();

  return {
    token,
    get cookie() { return `${cookieName()}=${session}`; },
    launchKey,
    proxyPort,
    async listen(wanted) {
      const tryListen = (p) => new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(p, '127.0.0.1', () => { server.off('error', onError); resolve(); });
      });
      try { await tryListen(wanted); } catch (err) {
        if (err.code !== 'EADDRINUSE' || wanted === 0) throw err;
        await tryListen(0);
      }
      port = server.address().port;
      // Site code (tests, the preview server, install scripts) is kept away from Roadie itself.
      protectRoadie({ ports: [port, proxyPort], files: [config.file] });
      checks = await gitops.checkTools();
      // Look for a newer release now and twice a day, without holding up the start.
      if (updater) {
        const look = () => updater.check().then((found) => { update = found; pushState(); }).catch(() => {});
        look();
        updateTimer = setInterval(look, 12 * 60 * 60_000);
        updateTimer.unref();
      }
      if (!sandboxAvailable()) {
        checks.push({
          id: 'sandbox', ok: false,
          detail: `${process.platform === 'win32' ? 'Windows has' : 'This system has'} no sandbox for site code yet (Roadie has one on macOS only).`,
          fix: "Here a site's tests, its preview server and its install scripts run with your account's full access, including your GitHub sign-in. Read the AI's changes in the right-hand pane before running tests or the preview.",
        });
      }
      return port;
    },
    address() { return server.address(); },
    async close() {
      clearInterval(ping);
      clearInterval(updateTimer);
      flow.stop();
      endChat();
      watcher?.close();
      await runner.stop();
      await proxy.close();
      for (const c of clients) c.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
