// The only module that runs git or gh. Tests pass a fake `run`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as realRun } from './exec.js';

const SCAN_DIFF = ['--text', '--no-textconv', '--no-color', '--no-ext-diff', '-U0'];

// Added lines from a unified diff. Only lines inside a hunk count, so an added
// line that itself starts with "++" is not mistaken for a file header.
export function parseAdditions(diff) {
  const out = [];
  let file = null;
  let inHunk = false;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; file = null; }
    else if (!inHunk && line.startsWith('+++ ')) file = line.slice(4).replace(/^"?b\//, '').replace(/"$/, '');
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+') && file && file !== '/dev/null') out.push({ path: file, line: line.slice(1) });
  }
  return out;
}

export const WORKFLOW_FIX = 'In a terminal run "gh auth refresh -h github.com -s workflow", follow its instructions, then try again.';

export function createGitOps({ run = realRun } = {}) {
  // Never let git or gh stop to ask a question in a terminal nobody is watching.
  const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
  const baseEnv = env;
  // Hooks in a site's clone are never run: Roadie's git commands must do exactly
  // what the interface says and nothing more.
  // Nor a file-system-monitor program named in a clone's config.
  // And on Windows, paths longer than 260 characters (deep node_modules) are allowed.
  const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
  const git = (cwd, args, opts = {}) => run('git', [...SAFE, ...args], { cwd, env: env(), ...opts });
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
    if (/without `?workflow`? scope/i.test(detail)) {
      return ` GitHub refused because this change adds or edits a workflow file (under .github/workflows), and your gh sign-in is not allowed to do that. ${WORKFLOW_FIX}`;
    }
    if (/GH013|push declined due to repository rule violations|secret-scanning/i.test(detail)) {
      return ' GitHub refused the push under one of the repo\'s rules. If it names a secret, remove that secret from the files and try again; the details are below.';
    }
    if (/protected branch|GH006/i.test(detail)) {
      return ' GitHub refused because that branch is protected.';
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
        : { id: 'git', ok: false, detail: 'git is not installed.', fix: process.platform === 'win32' ? 'Install Git for Windows from https://git-scm.com/download/win (or: winget install Git.Git), then open a new terminal and restart Roadie.' : 'Install git (on a Mac: xcode-select --install), then restart Roadie.' });

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
        checks.push({ id: 'gh', ok: false, detail: 'The GitHub command-line tool (gh) is not installed.', fix: `Install it from https://cli.github.com${process.platform === 'win32' ? ' (or: winget install GitHub.cli), open a new terminal' : ''}, run "gh auth login", then restart Roadie.` });
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

    // The permissions gh's sign-in has, or null when gh does not say (some token kinds do not).
    async ghScopes() {
      const r = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
      const m = `${r.stdout}\n${r.stderr}`.match(/Token scopes:\s*(.+)/);
      return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
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
      // Windows: git answers with forward slashes and its own letter case for the same folder.
      const same = (p) => { const real = fs.realpathSync.native(p); return process.platform === 'win32' ? real.toLowerCase() : real; };
      try { return same(r.stdout.trim()) === same(dir); } catch { return false; }
    },

    originUrl(dir) {
      return must(git(dir, ['remote', 'get-url', 'origin']), 'Reading the origin remote');
    },

    async defaultBranch(dir) {
      const r = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
      return 'main';
    },

    // Works in a repo with no commits yet, too.
    async currentBranch(dir) {
      const r = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
      return must(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'Reading the current branch');
    },

    async hasCommits(dir) {
      return (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
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

    // Files that are committed in the repo (so not private to this machine).
    async trackedFiles(dir) {
      const r = await git(dir, ['ls-files', '-z', '--cached']);
      if (r.code !== 0) throw new Error(`Listing files failed: ${r.stderr.trim()}`);
      return r.stdout.split('\0').filter(Boolean);
    },

    // Every file in the working tree that is tracked or new, minus ignored ones.
    async listFiles(dir) {
      const r = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
      if (r.code !== 0) throw new Error(`Listing files failed: ${r.stderr.trim()}`);
      return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
    },

    // What differs from a commit (by default the last one), counting files not
    // yet committed: [{ path, from, status, diff }]. During a change the base is
    // where the branch left main, so the whole change shows, committed or not.
    async changes(dir, base = 'HEAD') {
      const out = [];
      const seen = new Set();
      if (await this.hasCommits(dir)) {
        const names = await git(dir, ['diff', '--name-status', '-z', '-M', base, '--']);
        if (names.code !== 0) throw new Error(`git diff failed: ${names.stderr.trim()}`);
        const fields = names.stdout.split('\0').filter((f) => f !== '');
        for (let i = 0; i < fields.length; i++) {
          const code = fields[i][0];
          let from = null;
          let file = fields[++i];
          if (code === 'R' || code === 'C') { from = file; file = fields[++i]; }
          const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
          const d = await git(dir, ['diff', '--no-color', '--no-ext-diff', '-M', base, '--', ...(from ? [from, file] : [file])]);
          out.push({ path: file, from, status, diff: d.stdout });
          seen.add(file);
        }
      }
      const untracked = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        if (seen.has(file)) continue;
        const d = await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file]);
        out.push({ path: file, from: null, status: 'added', diff: d.stdout });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },

    // --- facts the change bar needs -----------------------------------------

    async headSha(dir) {
      const r = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      return r.code === 0 ? r.stdout.trim() : null;
    },

    async remoteSha(dir, branch) {
      const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      return r.code === 0 ? r.stdout.trim() : null;
    },

    async mergeBase(dir, branch) {
      const r = await git(dir, ['merge-base', 'HEAD', `origin/${branch}`]);
      return r.code === 0 ? r.stdout.trim() : null;
    },

    // An id for exactly what is in the working tree now, committed or not.
    // Uses a throwaway index, so the real index and files are untouched.
    async treeId(dir) {
      const index = path.join(os.tmpdir(), `roadie-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const env = { ...baseEnv(), GIT_INDEX_FILE: index };
      try {
        const add = await run('git', [...SAFE, 'add', '-A', '--', '.'], { cwd: dir, env });
        if (add.code !== 0) throw new Error(`Reading the working tree failed: ${add.stderr.trim()}`);
        const tree = await run('git', [...SAFE, 'write-tree'], { cwd: dir, env });
        if (tree.code !== 0) throw new Error(`Reading the working tree failed: ${tree.stderr.trim()}`);
        return tree.stdout.trim();
      } finally {
        fs.rmSync(index, { force: true });
      }
    },

    // Does GitHub have any commits for this repo at all?
    async remoteIsEmpty(dir) {
      const r = await git(dir, [...VIA_GH, 'ls-remote', '--heads', 'origin'], { timeout: 60_000 });
      if (r.code !== 0) throw new Error(`Could not reach GitHub: ${r.stderr.trim()}`);
      return r.stdout.trim() === '';
    },

    async tags(dir) {
      const r = await git(dir, ['tag', '--list']);
      return r.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
    },

    async log(dir, range) {
      const r = await git(dir, ['log', '--format=%h %s', range]);
      return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    },

    // The commits `to` has that `from` does not, newest first, each with the
    // files it changed: [{ sha, subject, files: [{ path, from, status, diff }] }].
    // With no `from`, everything up to `to`. Merges count as one commit, compared
    // with the main line before them. Reads only what is already fetched.
    async commitsBetween(dir, from, to, { limit = 30 } = {}) {
      for (const ref of [from, to]) {
        if (ref && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref)) throw new Error(`"${ref}" is not a usable commit name.`);
      }
      const range = from ? `${from}..${to}` : to;
      const log = await git(dir, ['log', '--first-parent', '--format=%H%x00%s', '-z', range, '--']);
      if (log.code !== 0) throw new Error(`Reading the commits failed: ${log.stderr.trim()}`);
      const fields = log.stdout.split('\0');
      const all = [];
      for (let i = 0; i + 1 < fields.length; i += 2) all.push({ sha: fields[i].trim(), subject: fields[i + 1] });
      const commits = [];
      for (const c of all.slice(0, limit)) {
        const parent = await git(dir, ['rev-parse', '--verify', '--quiet', `${c.sha}^1`]);
        const before = parent.code === 0 ? parent.stdout.trim() : null;
        const names = before
          ? await git(dir, ['diff', '--name-status', '-z', '-M', before, c.sha, '--'])
          : await git(dir, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', c.sha]);
        const parts = names.stdout.split('\0').filter((f) => f !== '');
        const files = [];
        for (let i = 0; i < parts.length; i++) {
          const code = parts[i][0];
          let old = null;
          let file = parts[++i];
          if (code === 'R' || code === 'C') { old = file; file = parts[++i]; }
          const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
          const d = before
            ? await git(dir, ['diff', '--no-color', '--no-ext-diff', '-M', before, c.sha, '--', ...(old ? [old, file] : [file])])
            : await git(dir, ['show', '--format=', '--no-color', '--no-ext-diff', c.sha, '--', file]);
          files.push({ path: file, from: old, status, diff: d.stdout });
        }
        commits.push({ ...c, files: files.sort((x, y) => x.path.localeCompare(y.path)) });
      }
      return { commits, more: Math.max(0, all.length - limit) };
    },

    // --- local steps of a change ----------------------------------------------

    // New branch from the newest main. Uncommitted edits come along.
    async startBranch(dir, name, defaultBranch) {
      await this.fetch(dir);
      return must(git(dir, ['switch', '--no-track', '-c', name, `origin/${defaultBranch}`]),
        `Starting the branch ${name}`);
    },

    async branchExists(dir, name) {
      return (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
    },

    switchTo(dir, branch) {
      return must(git(dir, ['switch', branch]), `Switching to ${branch}`);
    },

    async stagedFiles(dir) {
      const r = await git(dir, ['diff', '--cached', '--name-only', '-z']);
      return r.stdout.split('\0').filter(Boolean);
    },

    // Lines a commit would add, for the secret scan: [{ path, line }].
    // --text and --no-textconv make git show every file's real content, whatever
    // the repo's .gitattributes says about binary files or converters.
    async stagedAdditions(dir) {
      const r = await git(dir, ['-c', 'core.quotePath=false', 'diff', '--cached', ...SCAN_DIFF]);
      return parseAdditions(r.stdout);
    },

    // The same, for everything that differs from a commit and is not staged yet.
    async additions(dir, base = 'HEAD') {
      const out = [];
      if (await this.hasCommits(dir)) {
        const r = await git(dir, ['-c', 'core.quotePath=false', 'diff', ...SCAN_DIFF, base, '--']);
        out.push(...parseAdditions(r.stdout));
      }
      const untracked = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
      for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        const r = await git(dir, ['-c', 'core.quotePath=false', 'diff', ...SCAN_DIFF, '--no-index', '--', '/dev/null', file]);
        out.push(...parseAdditions(r.stdout).map((a) => ({ ...a, path: file })));
      }
      return out;
    },

    stageAll(dir) {
      return must(git(dir, ['add', '-A', '--', '.']), 'Staging the changes');
    },

    unstageAll(dir) {
      return git(dir, ['reset', '-q']);
    },

    // Commits what is staged. Refuses on the default branch unless this is the
    // one-time first commit of an empty repo.
    async commit(dir, message, { defaultBranch, firstCommit = false } = {}) {
      const branch = await this.currentBranch(dir);
      if (branch === defaultBranch && !firstCommit) {
        throw new Error(`Roadie never commits to ${defaultBranch} directly. Start a change first.`);
      }
      if (firstCommit && (await this.hasCommits(dir))) {
        throw new Error('A first commit is only possible in a repo with no commits.');
      }
      await must(git(dir, ['commit', '-m', message]), 'Committing');
      return this.headSha(dir);
    },

    // Pushes one branch. Never forces, and refuses the default branch unless
    // this is the first commit of an empty repo.
    async push(dir, branch, { defaultBranch, firstCommit = false } = {}) {
      if (!branch || branch.startsWith('-')) throw new Error('No branch to push.');
      if (branch === defaultBranch) {
        if (!firstCommit) throw new Error(`Roadie never pushes to ${defaultBranch} directly.`);
        if (!(await this.remoteIsEmpty(dir))) throw new Error(`GitHub already has commits, so Roadie will not push to ${defaultBranch}.`);
      }
      return must(
        git(dir, [...VIA_GH, 'push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeout: 300_000 }),
        `Pushing ${branch}`,
      );
    },

    // After a merge: back to the default branch, brought up to date.
    async returnToDefault(dir, defaultBranch) {
      await this.fetch(dir);
      await must(git(dir, ['switch', defaultBranch]), `Switching to ${defaultBranch}`);
      await must(git(dir, ['merge', '--ff-only', `origin/${defaultBranch}`]), `Updating ${defaultBranch}`);
    },

    async deleteLocalBranch(dir, branch, defaultBranch) {
      if (branch === defaultBranch) return;
      await git(dir, ['branch', '-D', branch]);
    },

    // Set aside everything uncommitted, recoverably (git stash).
    async stashAll(dir, label) {
      const r = await git(dir, ['stash', 'push', '--include-untracked', '-m', label]);
      if (r.code !== 0) throw new Error(`Setting the changes aside failed: ${r.stderr.trim()}`);
      return !/No local changes/i.test(r.stdout);
    },

    // Put one changed file back as it was at `base`, recoverably. What was not
    // yet committed goes into git stash; anything the change's branch had
    // already committed for it is then taken back to `base` in the working tree.
    // change: one entry from changes() ({ path, from, status }).
    async restoreFile(dir, base, change) {
      const paths = [change.from, change.path].filter(Boolean);
      // A repo with no commits yet has nothing to go back to and no stash: the
      // file is simply taken out. The interface says so before it asks.
      if (!(await this.hasCommits(dir))) {
        for (const file of paths) {
          await git(dir, ['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', `:(literal)${file}`]);
          fs.rmSync(path.join(dir, file), { force: true });
        }
        return { stashed: false };
      }
      let stashed = false;
      for (const file of paths) {
        // ":(literal)" so a name with * or [ in it means that one file only.
        const stash = await git(dir, ['stash', 'push', '--include-untracked', '-m', `roadie: undo ${file}`, '--', `:(literal)${file}`]);
        const said = stash.stdout + stash.stderr;
        // A file the branch has already committed away is not there to set aside.
        if (stash.code !== 0 && !/did not match any file/i.test(said)) throw new Error(`Setting ${file} aside failed: ${said.trim()}`);
        if (stash.code === 0 && !/No local changes/i.test(said)) stashed = true;
      }
      for (const file of paths) {
        const inBase = (await git(dir, ['cat-file', '-e', `${base}:${file}`])).code === 0;
        if (inBase) await must(git(dir, ['checkout', base, '--', `:(literal)${file}`]), `Restoring ${file}`);
        else await must(git(dir, ['rm', '-q', '-f', '--ignore-unmatch', '--', `:(literal)${file}`]), `Removing ${file}`);
      }
      return { stashed };
    },

    // Put every file back as it was when `tree` was taken with treeId(): used to
    // undo what one AI reply did. What is there now is set aside in the stash
    // first, so nothing is lost. No commit is made and no branch moves.
    async restoreTree(dir, tree) {
      if (!/^[0-9a-f]{40,64}$/.test(String(tree))) throw new Error('That is not a snapshot Roadie took.');
      if (!(await this.hasCommits(dir))) throw new Error('This repo has no commits yet, so there is nowhere to keep the edits being undone. Make the first commit, then this works.');
      const stash = await git(dir, ['stash', 'push', '--include-untracked', '-m', 'roadie: undo AI reply']);
      const said = stash.stdout + stash.stderr;
      if (stash.code !== 0) throw new Error(`Setting the edits aside failed: ${said.trim()}`);
      const stashed = !/No local changes/i.test(said);
      await must(git(dir, ['restore', `--source=${tree}`, '--worktree', '--', ':/']), 'Putting the files back');
      return { stashed };
    },

    // --- GitHub, through gh. Every call names the repo, so it cannot act on another. ---

    async repoInfo(slug) {
      const out = await must(gh(undefined, ['repo', 'view', slug, '--json',
        'nameWithOwner,defaultBranchRef,viewerPermission,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,isEmpty,visibility']),
        `Reading ${slug} on GitHub`);
      return JSON.parse(out);
    },

    async prForBranch(slug, branch) {
      const out = await must(gh(undefined, ['pr', 'list', '-R', slug, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state']),
        'Looking for a pull request');
      return JSON.parse(out)[0] || null;
    },

    async prCreate(slug, { title, body, base, head }) {
      const out = await must(gh(undefined, ['pr', 'create', '-R', slug, '--base', base, '--head', head, '--title', title, '--body', body]),
        'Opening the pull request');
      const url = (out.match(/https:\/\/\S+\/pull\/(\d+)/) || [])[0];
      if (!url) throw new Error(`gh did not report the pull request's address: ${out}`);
      return { url, number: Number(url.split('/').pop()) };
    },

    async prView(slug, number) {
      const out = await must(gh(undefined, ['pr', 'view', String(number), '-R', slug, '--json',
        'number,url,state,title,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt']),
        'Reading the pull request');
      return JSON.parse(out);
    },

    // [] when the repo has no checks at all.
    async prChecks(slug, number) {
      const r = await gh(undefined, ['pr', 'checks', String(number), '-R', slug, '--json', 'name,state,bucket,link,workflow']);
      const text = r.stdout.trim();
      if (text.startsWith('[')) return JSON.parse(text); // gh exits non-zero while checks are pending or failing
      if (/no checks reported/i.test(r.stderr + r.stdout)) return [];
      throw new Error(`Reading the checks failed: ${(r.stderr || r.stdout).trim()}`);
    },

    // Merges only if the pull request still points at the commit that was reviewed.
    async prMerge(slug, number, { method = 'squash', sha, deleteBranch = true }) {
      const flag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[method];
      if (!flag) throw new Error(`Unknown merge method: ${method}`);
      const args = ['pr', 'merge', String(number), '-R', slug, flag, '--match-head-commit', sha];
      if (deleteBranch) args.push('--delete-branch');
      return must(gh(undefined, args, { timeout: 120_000 }), 'Merging the pull request');
    },

    async releases(slug) {
      const out = await must(gh(undefined, ['release', 'list', '-R', slug, '--limit', '30', '--json', 'tagName,isLatest,isPrerelease,isDraft,publishedAt']),
        'Reading the releases');
      return JSON.parse(out);
    },

    // Asks GitHub to draft release notes. Nothing is created.
    async releaseNotes(slug, { tag, target, previousTag }) {
      const args = ['api', '-X', 'POST', `repos/${slug}/releases/generate-notes`, '-f', `tag_name=${tag}`, '-f', `target_commitish=${target}`];
      if (previousTag) args.push('-f', `previous_tag_name=${previousTag}`);
      const out = await must(gh(undefined, args), 'Drafting the release notes');
      const data = JSON.parse(out);
      return { name: data.name || tag, body: data.body || '' };
    },

    async releaseCreate(slug, { tag, target, title, notes }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new Error(`"${tag}" is not a usable version tag.`);
      const out = await must(gh(undefined, ['release', 'create', tag, '-R', slug, '--target', target, '--title', title, '--notes', notes]),
        'Publishing the release');
      return { tag, url: (out.match(/https:\/\/\S+/) || [''])[0] };
    },

    // Which of these paths does the repo's .gitignore cover?
    async ignored(dir, paths) {
      if (!paths.length) return new Set();
      const r = await git(dir, ['check-ignore', '--stdin'], { input: paths.join('\n') + '\n' });
      return new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    },
  };
}
