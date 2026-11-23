// Telling the person when a newer Roadie has been released, and installing it
// when they ask. Only an installed copy (from a release download) can update
// itself; a copy run from source is updated with git.
//
// The check is one request to github.com for the newest release's address. It
// sends nothing about the person or their sites. ROADIE_NO_UPDATE_CHECK=1 turns it off.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from './change.js';

export const REPO = 'cconstab/roadie';
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Which Roadie this is. A release download has a VERSION file beside its app folder.
export function installInfo(appDir = APP_DIR) {
  try {
    const first = fs.readFileSync(path.join(appDir, '..', 'VERSION'), 'utf8').split('\n')[0];
    const version = first.replace(/^roadie\s+/, '').trim();
    if (version) return { installed: true, dir: path.resolve(appDir, '..'), appDir, version };
  } catch { /* not a release download */ }
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
  return { installed: false, dir: null, appDir, version };
}

// Is release tag `latest` a later version than `current`? Unknown shapes are never "newer".
export function isNewer(latest, current) {
  const a = parseVersion(String(latest).trim());
  const b = parseVersion(String(current).trim());
  if (!a || !b) return false;
  return a.major - b.major > 0 || (a.major === b.major && (a.minor - b.minor > 0 || (a.minor === b.minor && a.patch > b.patch)));
}

// The newest release's tag, or null when there is none or GitHub cannot be reached.
// (GitHub answers /releases/latest by pointing at /releases/tag/<tag>; no sign-in is involved.)
export async function latestRelease({ fetchImpl = fetch, repo = REPO } = {}) {
  try {
    const res = await fetchImpl(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const m = String(res.headers.get('location') || '').match(/\/releases\/tag\/([^/?#]+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

// What the interface shows: null when there is nothing to offer.
export async function checkForUpdate({ info = installInfo(), fetchImpl = fetch, env = process.env } = {}) {
  if (env.ROADIE_NO_UPDATE_CHECK) return null;
  const latest = await latestRelease({ fetchImpl });
  if (!latest || !isNewer(latest, info.version)) return null;
  return {
    current: info.version, latest, installed: info.installed, dir: info.dir,
    url: `https://github.com/${REPO}/releases/tag/${encodeURIComponent(latest)}`,
    how: info.installed
      ? `Roadie will download ${latest} from GitHub, check it against the release's checksums, replace the copy in ${info.dir}, and stop. Your sites and settings are not touched. Start Roadie again afterwards.`
      : 'This copy runs from source. Update it with "git pull" and "npm install" in its folder, then start it again.',
  };
}

// The installer run that carries out an update. It is the same script a person
// runs to install Roadie, told which release to fetch and where this copy lives.
export function updatePlan({ info, tag, platform = process.platform, pid = process.pid, tmp = os.tmpdir() }) {
  if (!info.installed) throw new Error('This copy of Roadie runs from source. Update it with git pull.');
  if (!parseVersion(tag)) throw new Error('That does not look like a release version.');
  const env = { ROADIE_VERSION: tag, ROADIE_INSTALL_DIR: info.dir, ROADIE_INSTALL_DEPS: 'no', ROADIE_NO_LINK: '1' };
  if (platform === 'win32') {
    // Windows cannot replace a program that is running, so the installer waits
    // in its own window until Roadie has stopped. It runs from a copy, because
    // the folder it came from is the one being replaced.
    const script = path.join(tmp, `roadie-update-${pid}.ps1`);
    const command = `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; & '${script.replace(/'/g, "''")}'; Remove-Item -Force '${script.replace(/'/g, "''")}'; Read-Host 'Press Enter to close this window'`;
    return { afterExit: true, copy: { from: path.join(info.appDir, 'scripts', 'install.ps1'), to: script }, cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], env };
  }
  return { afterExit: false, copy: null, cmd: '/bin/sh', args: [path.join(info.appDir, 'scripts', 'install.sh')], env };
}

// Carries out the plan. Resolves with what to tell the person; Roadie should stop afterwards.
export function applyUpdate({ info = installInfo(), tag, spawnImpl = spawn, platform = process.platform }) {
  const plan = updatePlan({ info, tag, platform });
  const env = { ...process.env, ...plan.env };
  if (plan.afterExit) {
    fs.copyFileSync(plan.copy.from, plan.copy.to);
    spawnImpl(plan.cmd, plan.args, { env, detached: true, stdio: 'ignore' }).unref(); // its own window
    return Promise.resolve({ message: `Roadie is stopping so that ${tag} can be installed. A PowerShell window shows the progress. When it says "Installed", start Roadie again.` });
  }
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawnImpl(plan.cmd, plan.args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (err) => reject(new Error(`The update could not start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ message: `Roadie ${tag} is installed. Roadie has stopped; start it again to use the new version.` });
      else reject(new Error(`The update failed, and the installed copy was left as it was.\n${output.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}
