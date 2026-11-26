// A picture of a page of the running site, so the AI can see what it is editing.
//
// Roadie adds no browser of its own: it uses Chrome, Edge, Chromium or Brave if
// one is installed, run headless for one page and then closed. That browser is
// told to resolve no host but this machine, so the tool cannot be used to fetch
// anything from the internet: it shows the local site and nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';

export const SIZES = { desktop: { width: 1280, height: 1600 }, tablet: { width: 820, height: 1400 }, phone: { width: 390, height: 1400 } };

// Where a usable browser may be, most common first.
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].flatMap((app) => [
      `/Applications/${app}.app/Contents/MacOS/${app}`,
      path.posix.join(env.HOME || '', `Applications/${app}.app/Contents/MacOS/${app}`),
    ]);
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
      .flatMap((exe) => roots.map((root) => path.win32.join(root, exe)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  return String(env.PATH || '').split(':').filter(Boolean).flatMap((dir) => names.map((name) => path.posix.join(dir, name)));
}

// The browser to use, or null. ROADIE_BROWSER names one outright.
export function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.ROADIE_BROWSER) return exists(env.ROADIE_BROWSER) ? env.ROADIE_BROWSER : null;
  return browserCandidates(platform, env).find((file) => exists(file)) || null;
}

// The page inside the site to show: a path only, never another website.
export function cleanPagePath(given) {
  let p = String(given ?? '/').trim() || '/';
  try { const u = new URL(p); p = u.pathname + u.search; } catch { /* not a full address */ }
  p = '/' + p.replace(/^\/+/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \\]/.test(p) || p.length > 500) throw new Error('That is not a usable page address. Give a path such as /about.html.');
  return p;
}

export function browserArgs({ url, out, profile, width, height }) {
  return [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--mute-audio', '--hide-scrollbars',
    // No host but this machine resolves, so nothing is fetched from the internet.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE [::1]',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--virtual-time-budget=5000', // let the page's own script and fonts settle
    `--screenshot=${out}`, url,
  ];
}

// Take the picture. Resolves to { png: Buffer, width, height }, or throws in plain words.
export async function capturePage({ base, page = '/', size = 'desktop', browser = findBrowser(), runImpl = run, timeoutMs = 30_000 }) {
  if (!base) throw new Error('The site is not running, so there is no page to look at. The owner can press Run.');
  if (!browser) throw new Error('No Chrome, Edge, Chromium or Brave was found on this machine, so Roadie cannot take a picture of the page. Describe what to check and ask the owner to look.');
  const { width, height } = SIZES[size] || SIZES.desktop;
  const url = base + cleanPagePath(page);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-look-'));
  const out = path.join(work, 'page.png');
  try {
    const result = await runImpl(browser, browserArgs({ url, out, profile: path.join(work, 'profile'), width, height }), { timeout: timeoutMs });
    if (!fs.existsSync(out)) throw new Error(`The browser did not produce a picture of ${cleanPagePath(page)}${result.stderr ? `: ${result.stderr.trim().split('\n').slice(-2).join(' ')}` : '.'}`);
    return { png: fs.readFileSync(out), width, height };
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
