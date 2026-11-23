// Rules Roadie enforces no matter what the AI or the site asks for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;

// Does this file name look like it holds secrets?
export function isSecretPath(rel) {
  const name = foldName(String(rel).split(/[\\/]/).pop());
  if (/^\.env($|\.)/i.test(name)) return !EXAMPLE.test(name);
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) return true;
  if (/^(\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/i.test(name)) return true;
  if (/^(secrets?|credentials?)(\.[a-z0-9]+)?$/i.test(name)) return !EXAMPLE.test(name);
  return false;
}

// File systems on macOS and Windows treat ".GIT", ".git." and ".g\u200Bit" as the
// same folder as ".git". Fold a name the way they do before comparing it.
function foldName(name) {
  return String(name).normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .toLowerCase()
    .replace(/[. ]+$/, '');
}

export function isGitFolderName(name) {
  const folded = foldName(name);
  return folded === '.git' || /^git~\d+$/.test(folded);
}

// Resolve a path the AI gave and say whether it may touch it.
// Allowed: files inside the site folder, except .git and secret files.
// Symlinks are followed first, so a link cannot lead outside.
export function checkSitePath(root, given) {
  if (typeof given !== 'string' || !given) return { ok: false, reason: 'No file path was given.' };
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, given);

  // Walk up to the deepest part of the path that exists, resolve that, then
  // add back the parts that do not exist yet.
  let probe = abs;
  const tail = [];
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  while (!exists(probe)) {
    tail.unshift(path.basename(probe));
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try { real = path.join(fs.realpathSync(probe), ...tail); }
  catch { return { ok: false, reason: `${given} is a broken link, so Roadie cannot tell where it leads.` }; }

  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return { ok: false, reason: `${given} is outside the site folder. You can only work inside ${realRoot}.` };
  }
  const rel = path.relative(realRoot, real).split(path.sep).join('/');
  if (rel.split('/').some(isGitFolderName)) {
    return { ok: false, reason: 'The .git folder is off limits. Roadie handles git itself.' };
  }
  if (isSecretPath(rel)) {
    return { ok: false, reason: `${rel} looks like a secrets file, so it is off limits.` };
  }
  return { ok: true, rel, abs: real };
}

// --- secrets in what is about to be committed ---------------------------------

const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style API key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a password in a URL', /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@[^\s/]+/i],
];

// name = "value" where the name says secret and the value looks real rather than a placeholder
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:secret|passw(?:or)?d|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|admin[_-]?token)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"'`,;]{12,})/i;
const PLACEHOLDER = /^(\$|<|\{|%|process\.env|os\.environ|env\.|your[-_]|change[-_]?me|example|xxx+|\*+|\.\.\.|none|null|undefined|true|false)/i;

function looksRandom(value) {
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return new Set(value).size >= 8;
}

// files: paths about to be committed. additions: [{ path, line }] of added lines.
// Returns findings: [{ path, why }]. Any finding stops the commit.
export function scanForSecrets({ files = [], additions = [] }) {
  const findings = [];
  for (const file of files) {
    if (isSecretPath(file)) findings.push({ path: file, why: 'This file name is one that normally holds secrets.' });
  }
  const seen = new Set();
  for (const { path: file, line } of additions) {
    let why = null;
    for (const [what, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) { why = `A line looks like it contains ${what}.`; break; }
    }
    if (!why) {
      const m = line.match(ASSIGNMENT);
      if (m && !PLACEHOLDER.test(m[2]) && looksRandom(m[2])) why = `A line sets "${m[1]}" to what looks like a real secret.`;
    }
    if (why && !seen.has(file + why)) {
      seen.add(file + why);
      findings.push({ path: file, why });
    }
  }
  return findings;
}

// --- nothing leaves the machine without a click --------------------------------
//
// An outward step is two calls. prepare() records exactly what will happen and
// returns it with a one-time token. take() hands that plan back once, to be
// carried out. The interface shows the plan between the two; the AI has no way
// to call either.
export function createConfirmations({ ttlMs = 10 * 60_000, now = () => Date.now(), random = () => crypto.randomUUID() } = {}) {
  const pending = new Map();
  return {
    prepare(action, plan) {
      pending.clear(); // one plan at a time: preparing a new one cancels the last
      const token = random();
      pending.set(token, { action, plan, expires: now() + ttlMs });
      return { token, action, plan };
    },
    take(token, action) {
      const entry = pending.get(token);
      pending.delete(token);
      if (!entry) throw new Error('That confirmation is no longer valid. Review the step again.');
      if (entry.action !== action) throw new Error('That confirmation was for a different step.');
      if (entry.expires < now()) throw new Error('That confirmation has expired. Review the step again.');
      return entry.plan;
    },
    get size() { return pending.size; },
  };
}
