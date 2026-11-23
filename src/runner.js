// Runs the site: its own start command as a child process on a free port,
// or the built-in static server when there is no start command.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createStaticServer } from './static.js';

// Every child process group Roadie has started and not yet seen exit.
const live = new Set();

export function killAllChildren(signal = 'SIGTERM') {
  for (const child of live) {
    try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(400, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Which loopback address answers on this port, if any.
export async function listeningHost(port) {
  if (await canConnect('127.0.0.1', port)) return '127.0.0.1';
  if (await canConnect('::1', port)) return '::1';
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Site code must not inherit Roadie's AI credentials or any GitHub token.
export function childEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|AWS_BEARER_TOKEN_BEDROCK|GH_|GITHUB_TOKEN|SSH_AUTH_SOCK)/.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

// Register a child started elsewhere so it is stopped when Roadie exits.
export function trackChild(child) {
  live.add(child);
  return () => live.delete(child);
}

export class Runner extends EventEmitter {
  constructor({ startTimeoutMs = 60_000 } = {}) {
    super();
    this.startTimeoutMs = startTimeoutMs;
    this.child = null;
    this.staticServer = null;
    this.status = { state: 'stopped', mode: null, host: null, port: null, error: null };
    this.lastPort = null;
    this.generation = 0;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  log(line, stream = 'roadie') {
    this.emit('log', { stream, line });
  }

  // Run a one-off shell command in the site folder (used for install), streaming its output.
  runStep(command, dir) {
    return new Promise((resolve) => {
      this.log(`$ ${command}`);
      const child = spawn(command, { cwd: dir, shell: true, detached: true, env: childEnv({ FORCE_COLOR: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
      live.add(child);
      this.pipeLogs(child);
      child.on('error', (err) => { live.delete(child); this.log(err.message); resolve(1); });
      child.on('close', (code) => { live.delete(child); resolve(code ?? 1); });
    });
  }

  pipeLogs(child) {
    for (const stream of ['stdout', 'stderr']) {
      let rest = '';
      child[stream].on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) this.log(line, stream);
      });
      child[stream].on('end', () => { if (rest) this.log(rest, stream); });
    }
  }

  async start({ dir, command, install, portHint }) {
    await this.stop();
    const generation = ++this.generation;
    this.setStatus({ state: 'starting', mode: command ? 'command' : 'static', host: null, port: null, error: null });

    if (!command) {
      const port = await freePort();
      const server = createStaticServer(dir);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      this.staticServer = server;
      this.log(`Serving ${dir} as static files on http://127.0.0.1:${port}`);
      this.setStatus({ state: 'running', host: '127.0.0.1', port });
      return this.status;
    }

    if (install && !fs.existsSync(path.join(dir, 'node_modules'))) {
      const code = await this.runStep(install, dir);
      if (generation !== this.generation) return this.status;
      if (code !== 0) {
        this.setStatus({ state: 'failed', error: `The install command failed (exit ${code}). See the log.` });
        return this.status;
      }
    }

    // Reuse the last port across restarts when it is still free, so links keep working.
    let port = this.lastPort && !(await listeningHost(this.lastPort)) ? this.lastPort : await freePort();
    const hintBusyBefore = portHint && portHint !== port ? !!(await listeningHost(portHint)) : true;

    this.log(`$ ${command}   (PORT=${port} HOST=127.0.0.1)`);
    const child = spawn(command, {
      cwd: dir,
      shell: true,
      detached: true, // its own process group, so the whole tree can be stopped
      env: childEnv({ PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    live.add(child);
    this.pipeLogs(child);
    let exited = null;
    child.on('error', (err) => { exited = { code: 127 }; this.log(err.message); });
    child.on('close', (code, signal) => {
      exited = { code, signal };
      live.delete(child);
      if (this.child === child) {
        this.child = null;
        if (this.status.state === 'running') {
          this.log(`The site stopped (${signal || 'exit ' + code}).`);
          this.setStatus({ state: 'failed', host: null, port: null, error: `The site stopped by itself (${signal || 'exit ' + code}). See the log.` });
        }
      }
    });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (generation !== this.generation) return this.status; // stopped or restarted meanwhile
      if (exited) {
        this.setStatus({ state: 'failed', error: `The start command exited straight away (${exited.signal || 'exit ' + exited.code}). See the log.` });
        return this.status;
      }
      let host = await listeningHost(port);
      if (!host && !hintBusyBefore) {
        // The site ignored PORT and came up on its usual port instead.
        host = await listeningHost(portHint);
        if (host) {
          this.log(`The site ignored PORT and is listening on its own port ${portHint}.`);
          port = portHint;
        }
      }
      if (host) {
        if (generation !== this.generation) return this.status;
        this.lastPort = port;
        this.setStatus({ state: 'running', host, port });
        return this.status;
      }
      await sleep(120);
    }
    await this.stop();
    this.setStatus({ state: 'failed', error: `The site started but nothing answered on port ${port}${portHint ? ' or ' + portHint : ''}. Check the start command and port in the site settings.` });
    return this.status;
  }

  async stop() {
    this.generation++;
    if (this.staticServer) {
      const server = this.staticServer;
      this.staticServer = null;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once('close', resolve));
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000);
      await gone;
      clearTimeout(timer);
    }
    if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped', host: null, port: null, error: null });
  }
}
