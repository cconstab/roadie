#!/usr/bin/env node
// npm start: run Roadie on 127.0.0.1 and open it in the browser.
import { spawn } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`Roadie needs Node 24 or newer. This is Node ${process.versions.node}. Install a newer Node from https://nodejs.org and try again.`);
  process.exit(1);
}
import { createApp } from './app.js';
import { createConfig, roadieHome } from './config.js';
import { createGitOps } from './gitops.js';
import { stopRunningCommands } from './exec.js';
import { browserOpener } from './proc.js';
import { killAllChildren } from './runner.js';

const home = roadieHome();
const app = await createApp({ home, gitops: createGitOps(), config: createConfig(home) });
const port = await app.listen(Number(process.env.ROADIE_PORT) || 4747);
// The key in the link is what lets this browser, and nothing else, open Roadie.
const url = `http://127.0.0.1:${port}/?key=${app.launchKey}`;
console.log(`Roadie is running. Open it with this link:\n\n  ${url}\n\n(sites and settings: ${home})`);
console.log('Press Ctrl+C to stop.');

if (!process.env.ROADIE_NO_OPEN) {
  const opener = browserOpener(url);
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true }).on('error', () => {
    console.log(`Could not open a browser. Go to ${url} yourself.`);
  }).unref();
}

// Stop every child process when Roadie exits, however it exits.
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  stopRunningCommands();
  setTimeout(() => { killAllChildren('SIGKILL'); process.exit(code); }, 5000).unref();
  try { await app.close(); } catch { /* still exit */ }
  killAllChildren('SIGKILL');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));   // also: the console window was closed (Windows)
process.on('SIGBREAK', () => shutdown(0)); // Ctrl+Break (Windows)
process.on('uncaughtException', (err) => { console.error(err); shutdown(1); });
process.on('exit', () => killAllChildren('SIGKILL'));
