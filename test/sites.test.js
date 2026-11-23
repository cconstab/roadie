import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createConfig } from '../src/config.js';
import { createGitOps } from '../src/gitops.js';
import { openSite, parseRepo, sameRepo, siteDir } from '../src/sites.js';
import { fakeGitOps, tmpDir } from './helpers.js';

test('parseRepo accepts owner/repo and GitHub URLs', () => {
  assert.deepEqual(parseRepo('acme/site'), { owner: 'acme', repo: 'site', key: 'acme/site' });
  assert.equal(parseRepo(' https://github.com/cconstab/3Chords.dev ').key, 'cconstab/3Chords.dev');
  assert.equal(parseRepo('git@github.com:acme/site.git').key, 'acme/site');
  assert.equal(parseRepo('github.com/acme/site/').key, 'acme/site');
});

test('parseRepo refuses anything that could escape the sites folder', () => {
  for (const bad of ['', 'acme', 'a/b/c', '../x', 'acme/..', './site', 'acme/si te', 'acme/site;rm']) {
    assert.throws(() => parseRepo(bad), undefined, bad);
  }
});

test('sameRepo compares the origin with the owner and repo', () => {
  assert.ok(sameRepo('git@github.com:Acme/Site.git', 'acme', 'site'));
  assert.ok(sameRepo('https://github.com/acme/site', 'acme', 'site'));
  assert.ok(!sameRepo('git@github.com:acme/other.git', 'acme', 'site'));
  assert.ok(!sameRepo('git@example.com:acme/site.git', 'acme', 'site'));
});

test('a site that is not on disk is cloned into sites/<owner>/<repo>', async (t) => {
  const home = tmpDir(t);
  const gitops = fakeGitOps();
  const result = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(result.action, 'cloned');
  assert.equal(result.dir, path.join(home, 'sites', 'acme', 'site'));
  assert.deepEqual(gitops.calls[0], ['clone', 'acme/site', result.dir]);
  assert.ok(!gitops.calls.some(([name]) => name === 'pullFastForward'));
});

test('an existing clean clone on main is fetched and fast-forwarded', async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(siteDir(home, 'acme', 'site'), { recursive: true });
  const gitops = fakeGitOps();
  const result = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(result.action, 'pulled');
  const names = gitops.calls.map(([name]) => name);
  assert.ok(!names.includes('clone'));
  assert.ok(names.indexOf('fetch') < names.indexOf('pullFastForward'));
});

test('a clone with uncommitted changes is left alone', async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(siteDir(home, 'acme', 'site'), { recursive: true });
  const gitops = fakeGitOps({ isClean: false });
  const result = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(result.action, 'left');
  assert.match(result.note, /uncommitted/);
  assert.ok(!gitops.calls.some(([name]) => name === 'pullFastForward'));
});

test('a clone on another branch is left alone', async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(siteDir(home, 'acme', 'site'), { recursive: true });
  const gitops = fakeGitOps({ currentBranch: 'fix-header' });
  const result = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(result.action, 'left');
  assert.equal(result.branch, 'fix-header');
  assert.ok(!gitops.calls.some(([name]) => name === 'pullFastForward'));
});

test('a folder that is a clone of something else is refused', async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(siteDir(home, 'acme', 'site'), { recursive: true });
  await assert.rejects(
    openSite({ gitops: fakeGitOps({ originUrl: 'git@github.com:evil/other.git' }), home, owner: 'acme', repo: 'site' }),
    /clone of something else/,
  );
  await assert.rejects(
    openSite({ gitops: fakeGitOps({ isRepo: false }), home, owner: 'acme', repo: 'site' }),
    /not a git clone/,
  );
});

test('checkTools says plainly what is missing', async () => {
  const run = (answers) => async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    const hit = Object.keys(answers).find((k) => key.startsWith(k));
    return { code: 1, stdout: '', stderr: '', missing: false, ...(hit ? answers[hit] : {}) };
  };

  const none = await createGitOps({ run: run({}) }).checkTools();
  assert.deepEqual(none.map((c) => [c.id, c.ok]), [['git', false], ['gh', false]]);
  assert.match(none[1].fix, /cli\.github\.com/);

  const signedOut = await createGitOps({ run: run({
    'git --version': { code: 0, stdout: 'git version 2.50.0\n' },
    'git config user.name': { code: 0, stdout: 'Sam\n' },
    'git config user.email': { code: 0, stdout: 'sam@example.com\n' },
    'gh --version': { code: 0, stdout: 'gh version 2.80.0\n' },
    'gh auth status': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
  }) }).checkTools();
  assert.deepEqual(signedOut.map((c) => [c.id, c.ok]), [['git', true], ['git-identity', true], ['gh', true], ['gh-auth', false]]);
  assert.match(signedOut[3].fix, /gh auth login/);

  const good = await createGitOps({ run: run({
    'git --version': { code: 0, stdout: 'git version 2.50.0\n' },
    'git config': { code: 0, stdout: 'x\n' },
    'gh --version': { code: 0, stdout: 'gh version 2.80.0\n' },
    'gh auth status': { code: 0, stdout: '✓ Logged in to github.com account sam (keyring)\n' },
  }) }).checkTools();
  assert.ok(good.every((c) => c.ok));
  assert.match(good.at(-1).detail, /sam/);
});

test('site settings are saved in Roadie\'s home, cleaned, and never in the site', async (t) => {
  const home = tmpDir(t);
  const config = createConfig(home);
  const saved = config.saveSite('acme/site', {
    start: ' npm start ', test: 'npm test', port: '8080', stagingUrl: 'https://staging.example.com/',
    healthPath: 'api/health', surprise: 'dropped',
  });
  assert.deepEqual(saved, {
    start: 'npm start', test: 'npm test', install: '', port: 8080,
    stagingUrl: 'https://staging.example.com', productionUrl: '', healthPath: '/api/health', mergeMethod: 'squash', previewInternet: false,
  });
  assert.deepEqual(config.getSite('acme/site'), saved);
  assert.equal(config.getSite('acme/other'), null);
  assert.deepEqual(fs.readdirSync(home), ['config.json']);
  assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
});
