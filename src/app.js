// Roadie's own web server: the interface and its API, on 127.0.0.1 only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSettings } from './config.js';
import { detect } from './detect.js';
import { createPreviewProxy } from './proxy.js';
import { Runner } from './runner.js';
import { openSite, parseRepo } from './sites.js';
import { needsRestart, watchSite } from './watcher.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const MAX_LOG_LINES = 500;

export async function createApp({ home, gitops, config }) {
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

  async function open(repoInput) {
    const { owner, repo, key } = parseRepo(repoInput);
    busy = `Opening ${key}…`;
    pushState();
    try {
      await serial(() => runner.stop());
      watcher?.close();
      watcher = null;
      logs.length = 0;
      const opened = await openSite({ gitops, home, owner, repo });
      const found = detect(opened.dir);
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
      watcher?.close();
      await runner.stop();
      await proxy.close();
      for (const c of clients) c.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
