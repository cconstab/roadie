// Rules Roadie enforces no matter what the AI or the site asks for.
import fs from 'node:fs';
import path from 'node:path';

const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;

// Does this file name look like it holds secrets?
export function isSecretPath(rel) {
  const name = String(rel).split(/[\\/]/).pop();
  if (/^\.env($|\.)/i.test(name)) return !EXAMPLE.test(name);
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) return true;
  if (/^(\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/i.test(name)) return true;
  if (/^(secrets?|credentials?)(\.[a-z0-9]+)?$/i.test(name)) return !EXAMPLE.test(name);
  return false;
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
  if (rel.split('/').includes('.git')) {
    return { ok: false, reason: 'The .git folder is off limits. Roadie handles git itself.' };
  }
  if (isSecretPath(rel)) {
    return { ok: false, reason: `${rel} looks like a secrets file, so it is off limits.` };
  }
  return { ok: true, rel, abs: real };
}
