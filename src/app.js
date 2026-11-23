// Roadie's own web server: the interface and its API, on 127.0.0.1 only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiStatus, createChat } from './agent.js';
import { cleanAi, cleanSettings } from './config.js';
import { detect } from './detect.js';
import { isSecretPath } from './guards.js';
import { guideText, hostingGuide } from './guide.js';
import { createPreviewProxy } from './proxy.js';
import { Runner } from './runner.js';
import { openSite, parseRepo } from './sites.js';
import { blankKind, starterFileList, writeStarter } from './starter.js';
import { runTests } from './tests.js';
import { needsRestart, watchSite } from './watcher.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const MAX_LOG_LINES = 500;
const MAX_DIFF_CHARS = 200_000;

// The Agent SDK is loaded on first use, so Roadie starts quickly and tests can pass a fake.
async function loadSdk() {
  const [sdk, { z }] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
  return { sdk, z };
}

export async function createApp({ home, gitops, config, agentSdk = loadSdk }) {
  const token = crypto.randomBytes(24).toString('base64url'); // per run; proves a request came from Roadie's own page
  const runner = new Runner();
  const proxy = createPreviewProxy({
    getTarget: () => (runner.status.state === 'running' ? { host: runner.status.host, port: runner.status.port } : null),
  });
  const proxyPort = await proxy.listen(0);

  let port = null;
  let checks = [];
  let site = null; // { key, owner, repo, dir, branch, defaultBranch, note, settings, notes, saved }
  let watcher = null;
  let busy = null; // short text while a long step runs
  let chat = null; // the conversation with the AI about the open site
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
      busy,
      site: site && { ...site },
      starterFiles: starterFileList(),
      ai: { ...ai, status: aiStatus(ai), keyFound: aiStatus({ ...ai, provider: 'anthropic' }).ready },
      chat: { items: chat ? chat.items : [], busy: chat ? chat.busy : false, info: chat ? chat.info : null },
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
    await runner.start({ dir: site.dir, command: start, install, portHint });
    proxy.reload();
  }

  function watch() {
    watcher?.close();
    watcher = watchSite({
      dir: site.dir,
      gitops,
      onChange(files) {
        send('changed', { files });
        const state = runner.status.state;
        if (runner.status.mode === 'command' && (state === 'running' || state === 'failed') && needsRestart(files)) {
          runner.log(`Changed: ${files.join(', ')}. Restarting the site.`);
          serial(startPreview).catch((err) => runner.log(err.message));
        } else {
          proxy.reload();
        }
      },
    });
  }

  function endChat() {
    chat?.close();
    chat = null;
  }

  async function ensureChat() {
    if (!site) throw new Error('Open a site first.');
    if (!chat) {
      const status = aiStatus(ai);
      if (!status.ready) throw new Error(status.problem);
      const { sdk, z } = await agentSdk();
      chat = createChat({ sdk, z, gitops, site, ai, runTests, emit: (update) => send('chat', update) });
    }
    return chat;
  }

  async function open(repoInput) {
    const { owner, repo, key } = parseRepo(repoInput);
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
      watch();
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
      (await ensureChat()).send(body.text);
      return { ok: true };
    },
    'POST /api/chat/stop': async () => { await chat?.stop(); return { ok: true }; },
    'POST /api/chat/new': async () => { endChat(); pushState(); return snapshot(); },

    'GET /api/changes': async () => {
      if (!site) return { files: [] };
      const files = (await gitops.changes(site.dir)).map((f) => {
        if (isSecretPath(f.path)) return { ...f, diff: '', hidden: 'Not shown: this looks like a secrets file.' };
        if (f.diff.length > MAX_DIFF_CHARS) return { ...f, diff: f.diff.slice(0, MAX_DIFF_CHARS), hidden: 'This diff is long, so only the start is shown.' };
        return f;
      });
      return { files };
    },

    'POST /api/ai': async (body) => {
      ai = config.saveAi(body.ai);
      endChat(); // a different AI starts a fresh conversation
      pushState();
      return snapshot();
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

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1_000_000) { reject(new Error('Request too large.')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(new Error('Malformed request.')); }
      });
      req.on('error', reject);
    });
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

    if (req.method === 'GET' && PUBLIC_FILES[url.pathname]) {
      const [name, type] = PUBLIC_FILES[url.pathname];
      let body = fs.readFileSync(path.join(PUBLIC_DIR, name));
      if (name === 'index.html') body = body.toString('utf8').replace('__ROADIE_TOKEN__', token);
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; img-src 'self' data:; " +
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

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return json(404, { error: 'No such route.' });
    if (req.headers['x-roadie-token'] !== token) return json(403, { error: 'This request did not come from the Roadie window. Reload the page.' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      json(200, await handler(body));
    } catch (err) {
      json(400, { error: err.message });
    }
  });

  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
  ping.unref();

  return {
    token,
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
      checks = await gitops.checkTools();
      return port;
    },
    async close() {
      clearInterval(ping);
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
