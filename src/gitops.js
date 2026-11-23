// The only module that runs git or gh. Tests pass a fake `run`.
import fs from 'node:fs';
import { run as realRun } from './exec.js';

export function createGitOps({ run = realRun } = {}) {
  // Never let git or gh stop to ask a question in a terminal nobody is watching.
  const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
  // Hooks in a site's clone are never run: Roadie's git commands must do exactly
  // what the interface says and nothing more.
  const git = (cwd, args, opts = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: env(), ...opts });
  const gh = (cwd, args, opts = {}) => run('gh', args, { cwd, env: env(), ...opts });

  // Git commands that talk to GitHub over HTTPS sign in through gh, for this one
  // command only. Nothing is written to git config and Roadie never sees a token.
  const VIA_GH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

  function explain(detail) {
    if (/Host key verification failed/i.test(detail)) {
      return ' This clone talks to GitHub over SSH, and SSH does not yet trust github.com on this machine. Run "ssh -T git@github.com" in a terminal once and accept the key, then try again.';
    }
    if (/Permission denied \(publickey\)/i.test(detail)) {
      return ' This clone talks to GitHub over SSH, and GitHub did not accept your SSH key. Check "ssh -T git@github.com" in a terminal.';
    }
    if (/Repository not found|Could not resolve to a Repository/i.test(detail)) {
      return ' Check the owner/repo spelling, and that the account gh is signed in to can see it.';
    }
    return '';
  }

  async function must(promise, what) {
    const r = await promise;
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || '').trim();
      throw new Error(`${what} failed.${explain(detail)}${detail ? '\n' + detail : ''}`);
    }
    return r.stdout.trim();
  }

  return {
    // Startup check: are git and gh installed and signed in?
    async checkTools() {
      const checks = [];
      const g = await run('git', ['--version']);
      checks.push(g.code === 0
        ? { id: 'git', ok: true, detail: g.stdout.trim() }
        : { id: 'git', ok: false, detail: 'git is not installed.', fix: 'Install git (on a Mac: xcode-select --install), then restart Roadie.' });

      if (g.code === 0) {
        const name = await run('git', ['config', 'user.name']);
        const email = await run('git', ['config', 'user.email']);
        const ok = name.code === 0 && email.code === 0 && !!name.stdout.trim() && !!email.stdout.trim();
        checks.push(ok
          ? { id: 'git-identity', ok: true, detail: `commits as ${name.stdout.trim()} <${email.stdout.trim()}>` }
          : { id: 'git-identity', ok: false, detail: 'git does not know your name and email.', fix: 'Run: git config --global user.name "Your Name" and git config --global user.email you@example.com' });
      }

      const h = await run('gh', ['--version']);
      if (h.code !== 0) {
        checks.push({ id: 'gh', ok: false, detail: 'The GitHub command-line tool (gh) is not installed.', fix: 'Install it from https://cli.github.com, run "gh auth login", then restart Roadie.' });
        return checks;
      }
      checks.push({ id: 'gh', ok: true, detail: h.stdout.split('\n')[0].trim() });

      const a = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
      const text = `${a.stdout}\n${a.stderr}`;
      const account = (text.match(/account\s+(\S+)/) || text.match(/as\s+(\S+)/) || [])[1];
      checks.push(a.code === 0
        ? { id: 'gh-auth', ok: true, detail: account ? `signed in to GitHub as ${account}` : 'signed in to GitHub' }
        : { id: 'gh-auth', ok: false, detail: 'gh is not signed in to GitHub.', fix: 'Run "gh auth login" in a terminal, then restart Roadie.' });
      return checks;
    },

    clone(slug, dir) {
      return must(
        git(undefined, [...VIA_GH, 'clone', `https://github.com/${slug}.git`, dir], { timeout: 600_000 }),
        `Cloning ${slug}`,
      );
    },

    async isRepo(dir) {
      const r = await git(dir, ['rev-parse', '--show-toplevel']);
      if (r.code !== 0) return false;
      try { return fs.realpathSync(r.stdout.trim()) === fs.realpathSync(dir); } catch { return false; }
    },

    originUrl(dir) {
      return must(git(dir, ['remote', 'get-url', 'origin']), 'Reading the origin remote');
    },

    async defaultBranch(dir) {
      const r = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
      return 'main';
    },

    currentBranch(dir) {
      return must(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'Reading the current branch');
    },

    async isClean(dir) {
      return (await must(git(dir, ['status', '--porcelain']), 'git status')) === '';
    },

    fetch(dir) {
      return must(git(dir, [...VIA_GH, 'fetch', '--prune', 'origin'], { timeout: 300_000 }), 'Fetching from GitHub');
    },

    pullFastForward(dir, branch) {
      return must(git(dir, ['merge', '--ff-only', `origin/${branch}`]), `Updating ${branch}`);
    },

    // Every file in the working tree that is tracked or new, minus ignored ones.
    async listFiles(dir) {
      const r = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
      if (r.code !== 0) throw new Error(`Listing files failed: ${r.stderr.trim()}`);
      return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
    },

    // What differs from the last commit: [{ path, status, diff }].
    async changes(dir) {
      const st = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (st.code !== 0) throw new Error(`git status failed: ${st.stderr.trim()}`);
      const fields = st.stdout.split('\0');
      const out = [];
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (field.length < 4) continue;
        const xy = field.slice(0, 2);
        const file = field.slice(3);
        let from = null;
        if (xy.includes('R') || xy.includes('C')) from = fields[++i]; // the old name follows
        const status = xy === '??' ? 'added'
          : xy.includes('D') ? 'deleted'
          : xy.includes('R') ? 'renamed'
          : xy.includes('A') ? 'added'
          : 'modified';
        const d = xy === '??'
          ? await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file])
          : await git(dir, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ...(from ? [from, file] : [file])]);
        out.push({ path: file, from, status, diff: d.stdout });
      }
      return out;
    },

    // Which of these paths does the repo's .gitignore cover?
    async ignored(dir, paths) {
      if (!paths.length) return new Set();
      const r = await git(dir, ['check-ignore', '--stdin'], { input: paths.join('\n') + '\n' });
      return new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    },
  };
}
