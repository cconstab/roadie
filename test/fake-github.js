// A stand-in for GitHub, for tests and demos. git commands run for real against
// a local bare repository that plays the part of the GitHub remote; gh commands
// are answered here, and the ones that change things (merge, release) really
// change that bare repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as realRun } from '../src/exec.js';

const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function git(cwd, ...args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

// Creates <root>/origin.git (the "GitHub" side) and returns helpers.
// files: what the first commit on main holds. Pass null for an empty repo.
export function createRemote(root, files = { 'index.html': '<h1>hello</h1>\n', 'README.md': '# Site\n' }) {
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  if (files) {
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
      fs.writeFileSync(path.join(seed, name), content);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'first');
    git(seed, 'push', '-q', bare, 'main');
    fs.rmSync(seed, { recursive: true, force: true });
  }
  return {
    bare,
    clone(dir) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(path.dirname(dir), 'clone', '-q', bare, dir);
      git(dir, 'config', 'user.name', 'Test');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'commit.gpgsign', 'false');
      return dir;
    },
    sha: (ref) => { try { return git(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; } },
    log: (ref = 'main') => git(bare, 'log', '--format=%s', ref).split('\n').filter(Boolean),
    show: (ref, file) => git(bare, 'show', `${ref}:${file}`),
    branches: () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean),
    tags: () => git(bare, 'tag', '--list').split('\n').filter(Boolean),
  };
}

// Returns a `run` for createGitOps({ run }), plus the state it keeps.
export function fakeGitHub(remote, { slug = 'acme/site' } = {}) {
  const state = {
    slug,
    calls: [],            // every gh command asked for
    gitCalls: [],         // every git command asked for
    prs: [],
    releases: [],
    checks: () => [{ name: 'npm test', state: 'SUCCESS', bucket: 'pass', link: `https://github.com/${slug}/actions/runs/1`, workflow: 'tests' }],
    repo: { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true },
    scopes: ['gist', 'read:org', 'repo', 'workflow'],
    failNext: null,       // set to { match: /regex/, stderr: '...' } to make one gh command fail
  };
  const ok = (stdout = '') => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', missing: false });
  const bad = (stderr, code = 1) => ({ code, stdout: '', stderr, missing: false });
  const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const prJson = (pr) => ({
    number: pr.number, url: pr.url, state: pr.state, title: pr.title, isDraft: false,
    mergeable: pr.state === 'OPEN' ? (pr.mergeable || 'MERGEABLE') : 'UNKNOWN', mergeStateStatus: 'CLEAN',
    headRefName: pr.head, baseRefName: pr.base,
    headRefOid: pr.state === 'OPEN' ? remote.sha(`refs/heads/${pr.head}`) : pr.headRefOid,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, mergedAt: pr.mergedAt || null,
  });

  function gh(args) {
    state.calls.push(args.join(' '));
    if (state.failNext && state.failNext.match.test(args.join(' '))) {
      const { stderr } = state.failNext;
      state.failNext = null;
      return bad(stderr);
    }
    const [group, verb] = args;
    if (group === '--version') return ok('gh version 2.0.0 (stand-in)\n');
    if (group === 'auth' && verb === 'status') return ok(`github.com\n  ✓ Logged in to github.com account demo (stand-in)\n  - Token scopes: ${state.scopes.map((x) => `'${x}'`).join(', ')}\n`);
    const repo = flag(args, '-R') || args[2];
    if (group !== 'api' && repo !== slug) return bad(`GraphQL: Could not resolve to a Repository with the name '${repo}'.`);

    if (group === 'repo' && verb === 'view') {
      return ok({ nameWithOwner: slug, defaultBranchRef: { name: 'main' }, viewerPermission: 'ADMIN', isEmpty: !remote.sha('refs/heads/main'), visibility: 'PRIVATE', ...state.repo });
    }
    if (group === 'pr' && verb === 'list') {
      const head = flag(args, '--head');
      return ok(state.prs.filter((p) => p.head === head).slice(-1).map((p) => ({ number: p.number, url: p.url, state: p.state })));
    }
    if (group === 'pr' && verb === 'create') {
      const head = flag(args, '--head');
      const base = flag(args, '--base');
      if (!remote.sha(`refs/heads/${head}`)) return bad(`pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)`);
      if (remote.sha(`refs/heads/${head}`) === remote.sha(`refs/heads/${base}`)) return bad(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
      const number = state.prs.length + 1;
      const pr = { number, url: `https://github.com/${slug}/pull/${number}`, state: 'OPEN', head, base, title: flag(args, '--title'), body: flag(args, '--body') };
      state.prs.push(pr);
      return ok(`${pr.url}\n`);
    }
    const pr = group === 'pr' ? state.prs.find((p) => String(p.number) === args[2]) : null;
    if (group === 'pr' && !pr) return bad(`GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
    if (group === 'pr' && verb === 'view') return ok(prJson(pr));
    if (group === 'pr' && verb === 'checks') {
      const checks = state.checks(pr);
      if (!checks.length) return bad(`no checks reported on the '${pr.head}' branch`);
      const pending = checks.some((c) => c.bucket === 'pending');
      const failing = checks.some((c) => c.bucket === 'fail');
      return { ...ok(checks), code: pending ? 8 : failing ? 1 : 0 };
    }
    if (group === 'pr' && verb === 'merge') {
      if (pr.state !== 'OPEN') return bad(`Pull request #${pr.number} is not open`);
      const want = flag(args, '--match-head-commit');
      const head = remote.sha(`refs/heads/${pr.head}`);
      if (want !== head) return bad('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
      // Really merge, in a scratch clone of the bare repo.
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-merge-'));
      try {
        git(work, 'clone', '-q', remote.bare, 'w');
        const w = path.join(work, 'w');
        git(w, 'switch', '-q', pr.base);
        if (args.includes('--squash')) {
          git(w, 'merge', '--squash', '-q', `origin/${pr.head}`);
          git(w, 'commit', '-q', '-m', `${pr.title} (#${pr.number})`);
        } else {
          git(w, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, `origin/${pr.head}`);
        }
        git(w, 'push', '-q', 'origin', pr.base);
        if (args.includes('--delete-branch')) git(w, 'push', '-q', 'origin', `:refs/heads/${pr.head}`);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      Object.assign(pr, { state: 'MERGED', headRefOid: head, mergeCommit: remote.sha(`refs/heads/${pr.base}`), mergedAt: new Date().toISOString() });
      return ok(`✓ Squashed and merged pull request #${pr.number}\n`);
    }
    if (group === 'release' && verb === 'list') return ok(state.releases.map((r) => ({ tagName: r.tag, isLatest: r === state.releases.at(-1), isPrerelease: false, isDraft: false, publishedAt: r.at })));
    if (group === 'release' && verb === 'create') {
      const tag = args[2];
      const target = flag(args, '--target');
      if (remote.tags().includes(tag)) return bad(`a release with the same tag name already exists: ${tag}`);
      git(remote.bare, 'tag', tag, target);
      state.releases.push({ tag, target, title: flag(args, '--title'), notes: flag(args, '--notes'), at: new Date().toISOString() });
      return ok(`https://github.com/${slug}/releases/tag/${tag}\n`);
    }
    if (group === 'api' && args.some((a) => a.endsWith('/releases/generate-notes'))) {
      const tag = (args.find((a) => a.startsWith('tag_name=')) || '').slice(9);
      const merged = state.prs.filter((p) => p.state === 'MERGED').map((p) => `* ${p.title} by @test in ${p.url}`).join('\n');
      return ok({ name: tag, body: `## What's Changed\n${merged}` });
    }
    return bad(`fake gh does not know: gh ${args.join(' ')}`);
  }

  const run = async (cmd, args, opts) => {
    if (cmd === 'gh') return gh(args);
    if (cmd === 'git') state.gitCalls.push(args.join(' '));
    return realRun(cmd, args, opts);
  };
  return { run, state };
}
