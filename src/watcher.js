// Watches the site folder and reports changed files, skipping .git,
// node_modules and anything the site's .gitignore covers.
import fs from 'node:fs';

const STATIC_EXT = /\.(html?|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|md|txt|map|mp3|mp4|webm|pdf)$/i;

// A change to anything that is not a plain static asset may be server code,
// so the site's process is restarted for it.
export function needsRestart(files) {
  return files.some((f) => !STATIC_EXT.test(f));
}

export function watchSite({ dir, gitops, onChange, debounceMs = 150 }) {
  const pending = new Set();
  let timer = null;
  let closed = false;

  async function flush() {
    timer = null;
    const files = [...pending];
    pending.clear();
    let ignored = new Set();
    try { ignored = await gitops.ignored(dir, files); } catch { /* treat as not ignored */ }
    const changed = files.filter((f) => !ignored.has(f));
    if (changed.length && !closed) onChange(changed);
  }

  const watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
    if (!name) return;
    const rel = String(name).split('\\').join('/');
    if (rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('node_modules')) return;
    pending.add(rel);
    if (!timer) timer = setTimeout(flush, debounceMs);
  });
  watcher.on('error', () => {});

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}

// A site that writes into its own folder as it starts would be restarted for
// ever. The sign of that is the very same files changing again just after each
// restart. Someone (or the AI) editing quickly changes different files, or the
// same file with pauses, and is never held back.
export function createRestartGuard({ windowMs = 3000, limit = 3, now = () => Date.now() } = {}) {
  let lastStart = 0;
  let lastKey = '';
  let repeats = 0;
  return {
    // Call when a restart has finished.
    started() { lastStart = now(); },
    // Should this change restart the site?
    allow(files) {
      const key = [...files].sort().join('\n');
      const soon = lastStart > 0 && now() - lastStart < windowMs;
      repeats = soon && key === lastKey ? repeats + 1 : (soon ? 1 : 0);
      lastKey = key;
      return repeats < limit;
    },
  };
}
