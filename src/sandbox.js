// The box that site code runs in.
//
// A site's tests, its server and its install scripts are all code the AI may
// have edited. Roadie's promise is that the AI can never push, merge, release
// or read secrets, so that code must not be able to do those things either.
// On macOS every such process runs under sandbox-exec with this profile:
//
//   network   tests and preview: this machine only. install: the internet, but
//             no local sockets (so no ssh-agent). Never Roadie's own ports.
//   secrets   no keychain, and nothing in the home folder can be read except
//             the site itself, language toolchains and package caches. That
//             leaves out gh's and git's sign-in, ssh keys and cloud credentials.
//   writes    only the site (never its .git), temp folders and package caches.
//
// On other systems there is no sandbox yet, and Roadie says so plainly.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSecretPath } from './guards.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function sandboxAvailable() {
  return process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const q = (p) => JSON.stringify(p);

// Folders in the home directory that hold tools and caches, not secrets.
const HOME_TOOLS = [
  '.nvm', '.volta', '.asdf', '.fnm', '.n', '.nodenv', '.nodebrew', '.bun', '.deno', '.local', '.cargo', '.rustup',
  '.pyenv', '.rbenv', '.rvm', '.gem', '.sdkman', '.mise', '.proto', 'go', 'bin', '.pnpm', '.yarn',
  '.homebrew', 'homebrew', '.linuxbrew', 'Library/pnpm', 'Library/Application Support/fnm', 'Library/Application Support/mise',
];
const HOME_CACHES = ['.npm', '.cache', '.pnpm-store', '.yarn', '.node-gyp', '.config/yarn', '.config/pnpm', 'Library/Caches', 'Library/pnpm'];
const HOME_FILES = ['.gitconfig', '.config/git/config', '.config/git/ignore', '.gitignore', '.gitignore_global', '.editorconfig', '.tool-versions', '.nvmrc', '.node-version'];
// Top-level home folders that must never be opened up wholesale because a PATH entry lives inside them.
const NEVER_WHOLE = new Set(['.config', 'Library', '.ssh', '.aws', '.gnupg', '.docker', '.kube', 'Documents', 'Desktop', 'Downloads', '.claude']);

// Tool folders in the home directory that this machine actually uses (from PATH and node's own location).
function toolFolders(home, env) {
  const out = new Set();
  const consider = (dir) => {
    const resolved = real(dir);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) return;
    const parts = path.relative(home, resolved).split(path.sep);
    if (!parts[0] || parts[0] === '..') return;
    // ~/.foo/... opens ~/.foo; inside a sensitive folder only the tool's own subfolder is opened.
    out.add(NEVER_WHOLE.has(parts[0]) ? (parts.length > 1 ? path.join(home, parts[0], parts[1]) : null) : path.join(home, parts[0]));
  };
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) consider(dir);
  consider(path.dirname(process.execPath));
  out.delete(null);
  return [...out];
}

// Files in the site that look like secrets. Tests may not read them: their output goes to the AI.
function siteSecrets(siteDir, limit = 2000) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length > 200) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (--limit < 0) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (isSecretPath(entry.name)) found.push(full);
    }
  };
  walk(siteDir, 0);
  return found;
}

// mode: 'tests' | 'preview' | 'install'
// blockPorts: Roadie's own ports, which site code must never reach.
// openNetwork: let a running site reach the internet (a per-site choice).
// protect: extra files that must be neither read nor written (Roadie's config).
export function sandboxProfile({ siteDir, mode, blockPorts = [], openNetwork = false, protect = [], home = os.homedir(), env = process.env }) {
  const site = real(siteDir);
  const h = real(home);
  const internet = mode === 'install' || (mode === 'preview' && openNetwork);
  const lines = ['(version 1)', '(allow default)'];

  // --- network
  if (internet) {
    // The internet, but no local sockets: that is where ssh-agent and Docker live.
    lines.push('(deny network-outbound (remote unix-socket))');
  } else {
    lines.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))');
  }
  lines.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))'); // name lookups
  // Named as network-outbound on purpose: a rule for the exact operation beats a broader one.
  for (const port of blockPorts.filter(Boolean)) lines.push(`(deny network-outbound (remote ip "localhost:${Number(port)}"))`);

  // --- secrets: no keychain, and the home folder is closed except for tools and caches
  lines.push(
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd") (global-name "com.apple.security.agent") (global-name "com.apple.authd") (global-name "com.apple.ctkd"))',
    `(deny file-read-data (subpath ${q(h)}))`,
  );
  const readable = [
    site,
    ...HOME_TOOLS.map((d) => path.join(h, d)),
    ...HOME_CACHES.map((d) => path.join(h, d)),
    ...toolFolders(h, env),
  ];
  lines.push(`(allow file-read-data ${[...new Set(readable)].map((d) => `(subpath ${q(d)})`).join(' ')})`);
  // Dotfiles are often links into another folder, so allow both the name and where it leads.
  const files = HOME_FILES.flatMap((f) => [path.join(h, f), real(path.join(h, f))]);
  lines.push(`(allow file-read-data ${[...new Set(files)].map((f) => `(literal ${q(f)})`).join(' ')})`);
  if (mode === 'install') lines.push(`(allow file-read-data (literal ${q(path.join(h, '.npmrc'))}) (literal ${q(path.join(h, '.yarnrc'))}) (literal ${q(path.join(h, '.yarnrc.yml'))}))`);
  // Even inside tool folders, never these.
  lines.push(`(deny file-read-data (regex #"/\\.(ssh|aws|gnupg|docker|kube|azure)(/|$)") (regex #"/\\.config/(gh|gcloud|op|hub)(/|$)") (regex #"/(\\.git-credentials|\\.netrc|\\.pgpass|hosts\\.yml)$"))`);
  if (mode === 'tests') {
    const secrets = siteSecrets(site);
    if (secrets.length) lines.push(`(deny file-read-data ${secrets.map((f) => `(literal ${q(f)})`).join(' ')})`);
  }

  // --- writes: the site, temp folders and package caches only
  const writable = [
    site, '/private/tmp', '/private/var/folders', '/private/var/tmp', '/tmp', '/var/folders', real(os.tmpdir()),
    ...HOME_CACHES.map((d) => path.join(h, d)),
  ];
  lines.push(
    '(deny file-write*)',
    `(allow file-write* ${[...new Set(writable)].map((d) => `(subpath ${q(d)})`).join(' ')})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(ttys|pts/|fd/)"))',
    `(deny file-write* (subpath ${q(path.join(site, '.git'))}))`, // no rewriting git config, no planting hooks
  );
  for (const file of protect.filter(Boolean)) {
    lines.push(`(deny file-read-data (literal ${q(real(file))}))`, `(deny file-write* (literal ${q(real(file))}))`);
  }
  return lines.join('\n');
}

// Starts a shell command inside the sandbox. Without a sandbox it starts it plainly
// and says so in the returned object, so callers can tell the person.
export function spawnBoxed(command, { cwd, env, mode, blockPorts, openNetwork, protect, sandbox = sandboxAvailable(), stdio = ['ignore', 'pipe', 'pipe'] }) {
  const options = { cwd, env, detached: true, stdio }; // its own process group, so the whole tree can be stopped
  const child = sandbox
    ? spawn(SANDBOX_EXEC, ['-p', sandboxProfile({ siteDir: cwd, mode, blockPorts, openNetwork, protect, env }), '/bin/sh', '-c', command], options)
    : spawn(command, { ...options, shell: true });
  child.sandboxed = !!sandbox;
  return child;
}

// Roadie's own ports and files, set once at start so every boxed process is kept away from them.
const own = { ports: [], files: [] };
export function protectRoadie({ ports = [], files = [] }) {
  own.ports = [...new Set([...own.ports, ...ports])];
  own.files = [...new Set([...own.files, ...files])];
}
export const roadiePorts = () => own.ports;
export const roadieFiles = () => own.files;
