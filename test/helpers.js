import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.setMaxListeners(0); // one exit listener per temporary folder

export function tmpDir(t, prefix = 'roadie-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  // Removed when the test file's process ends, not in t.after(): hooks run in the
  // order they were added, and Windows will not delete a folder that a site
  // process (stopped by a later hook) is still running in.
  process.once('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the system's temp cleanup */ }
  });
  return dir;
}

export function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

// A stand-in for gitops that records what was asked of it.
export function fakeGitOps(overrides = {}) {
  const calls = [];
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return typeof value === 'function' ? value(...args) : value;
  };
  const ops = {
    calls,
    checkTools: record('checkTools', [{ id: 'git', ok: true, detail: 'git' }]),
    clone: record('clone', (slug, dir) => { fs.mkdirSync(dir, { recursive: true }); }),
    isRepo: record('isRepo', true),
    originUrl: record('originUrl', 'git@github.com:acme/site.git'),
    defaultBranch: record('defaultBranch', 'main'),
    currentBranch: record('currentBranch', 'main'),
    isClean: record('isClean', true),
    hasCommits: record('hasCommits', true),
    ghScopes: record('ghScopes', ['repo', 'workflow']),
    listFiles: record('listFiles', ['index.html']),
    changes: record('changes', []),
    fetch: record('fetch'),
    pullFastForward: record('pullFastForward'),
    ignored: record('ignored', new Set()),
  };
  for (const [name, value] of Object.entries(overrides)) ops[name] = record(name, value);
  return ops;
}
