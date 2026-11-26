// The change bar from end to end. git runs for real against a local stand-in
// for GitHub; gh is faked (see fake-github.js). Nothing touches the network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanSettings, createConfig } from '../src/config.js';
import { createFlow } from '../src/flow.js';
import { createGitOps } from '../src/gitops.js';
import { runTests } from '../src/tests.js';
import { createRemote, fakeGitHub } from './fake-github.js';
import { tmpDir, writeFiles } from './helpers.js';

const SITE_FILES = {
  'index.html': '<h1>hello</h1>\n',
  'README.md': '# Site\n',
  // The "test suite": passes unless a file called BROKEN exists.
  // The site's "tests": a node script, so it runs the same under sh and cmd.exe.
  'check.js': 'if (require("node:fs").existsSync("BROKEN")) { console.log("1 test failed: BROKEN exists"); process.exit(1); }\nconsole.log("all tests passed");\n',
  'slow-check.js': 'setTimeout(() => require("./check.js"), 400);\n',
};

function setup(t, { files = SITE_FILES, settings = {}, health, pollMs = 15, flowOptions = {} } = {}) {
  const root = tmpDir(t);
  const remote = createRemote(root, files);
  const dir = remote.clone(path.join(root, 'sites', 'acme', 'site'));
  const github = fakeGitHub(remote);
  const gitops = createGitOps({ run: github.run });
  const config = createConfig(path.join(root, 'home'));
  const site = {
    key: 'acme/site', owner: 'acme', repo: 'site', dir, branch: 'main', defaultBranch: 'main',
    settings: cleanSettings({ test: 'node check.js', stagingUrl: 'https://staging.acme.example', productionUrl: 'https://acme.example', healthPath: '/api/health', ...settings }),
  };
  const web = { staging: '{"ok":true,"version":"dev"}', production: '{"ok":true,"version":"v0.0.9"}', hits: [], ...health };
  const events = [];
  const flow = createFlow({
    gitops, config, runTests,
    getSite: () => site,
    emit: (e) => events.push(e),
    draftPr: async ({ description }) => ({ title: `AI: ${description}`, body: '- drafted by the AI' }),
    fetchImpl: async (url) => {
      web.hits.push(url);
      if (web.wait) await web.wait;
      const body = url.startsWith('https://staging.') ? web.staging : web.production;
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, text: async () => body };
    },
    pollMs,
    ...flowOptions,
  });
  t.after(() => flow.stop());
  const edit = (name, content) => writeFiles(dir, { [name]: content });
  const go = async (action, input, edits) => {
    const { token, plan } = await flow.prepare(action, input);
    return { plan, view: await flow.confirm(token, action, edits) };
  };
  return { root, remote, dir, github, gitops, config, site, flow, events, web, edit, go };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out waiting');
};

test('a whole change: branch, tests, pull request, CI, merge, staging, release, production', async (t) => {
  const { remote, dir, github, config, flow, web, edit, go, site } = setup(t);
  const mainBefore = remote.sha('main');

  // Start change
  assert.equal((await flow.view()).next.id, 'start');
  edit('index.html', '<h1>hello, world</h1>\n'); // edits made before starting come along
  let v = await flow.start({ description: 'Friendlier heading' });
  assert.equal(v.branch, 'change/friendlier-heading');
  assert.equal(v.stage, 'editing');
  assert.equal(v.filesChanged, 1);
  assert.equal(v.next.id, 'tests');

  // Run tests
  const result = await flow.tests();
  assert.equal(result.passed, true);
  assert.match(result.output, /all tests passed/);
  v = await flow.view();
  assert.equal(v.next.id, 'pr');
  assert.equal(v.tests.current, true);

  // Open PR: shown first, sent only on confirm
  const prepared = await flow.prepare('pr');
  assert.equal(prepared.plan.editable.title, 'AI: Friendlier heading');
  assert.equal(prepared.plan.drafted, 'ai');
  assert.deepEqual(prepared.plan.files, [{ path: 'index.html', status: 'modified' }]);
  assert.deepEqual(prepared.plan.commands, ['git add -A', 'git commit -m <the title below>', 'git push origin change/friendlier-heading', 'gh pr create --base main --head change/friendlier-heading']);
  assert.match(prepared.plan.sends, /github\.com\/acme\/site/);
  assert.deepEqual(remote.branches(), ['main'], 'preparing sends nothing');
  assert.equal(github.state.prs.length, 0);

  v = await flow.confirm(prepared.token, 'pr', { title: 'Make the heading friendlier', body: 'Says hello to the world.' });
  assert.equal(v.stage, 'pr-open');
  assert.deepEqual(v.pr, { number: 1, url: 'https://github.com/acme/site/pull/1' });
  assert.deepEqual(remote.branches().sort(), ['change/friendlier-heading', 'main']);
  assert.equal(remote.sha('main'), mainBefore, 'main is untouched by opening a pull request');
  assert.equal(remote.show('change/friendlier-heading', 'index.html'), '<h1>hello, world</h1>');
  assert.deepEqual(remote.log('change/friendlier-heading'), ['Make the heading friendlier', 'first']);
  assert.equal(github.state.prs[0].title, 'Make the heading friendlier');
  assert.equal(github.state.prs[0].body, 'Says hello to the world.');
  assert.equal(github.state.prs[0].base, 'main');

  // CI passed, so Merge is next
  assert.equal(v.next.id, 'merge');
  assert.equal(v.steps.find((s) => s.id === 'ci').status, 'done');

  // Merge
  const merge = await flow.prepare('merge');
  assert.match(merge.plan.commands[0], /^gh pr merge 1 --squash --delete-branch --match-head-commit [0-9a-f]{7}$/);
  assert.match(merge.plan.summary, /publishes to staging/);
  assert.equal(remote.sha('main'), mainBefore);
  v = await flow.confirm(merge.token, 'merge');
  assert.notEqual(remote.sha('main'), mainBefore);
  assert.deepEqual(remote.log('main'), ['Make the heading friendlier (#1)', 'first']);
  assert.deepEqual(remote.branches(), ['main'], 'the branch is deleted on GitHub');
  assert.equal(v.merge.sha, remote.sha('main'));
  assert.equal(v.stage, 'staging');

  // Staging: poll until the health URL reports the merged commit
  flow.health('staging');
  await until(() => web.hits.length >= 2);
  assert.equal(config.getChange('acme/site').staging.live, false);
  assert.equal(config.getChange('acme/site').staging.seen, 'dev');
  web.staging = `{"ok":true,"version":"main-${remote.sha('main').slice(0, 7)}"}`;
  await until(() => config.getChange('acme/site').staging.live);
  // The link offered is to the site itself, not to the address asked for its version.
  assert.equal(config.getChange('acme/site').staging.site, 'https://staging.acme.example');
  assert.equal((await flow.view()).staging.site, 'https://staging.acme.example');
  assert.equal(web.hits[0], 'https://staging.acme.example/api/health');
  v = await flow.view();
  assert.equal(v.stage, 'release');
  const hitsAfterLive = web.hits.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(web.hits.length, hitsAfterLive, 'polling stops once it is live');

  // Release
  const release = await flow.prepare('release');
  assert.equal(release.plan.tag, 'v0.1.0');
  assert.equal(release.plan.target, remote.sha('main'));
  assert.match(release.plan.editable.notes, /Make the heading friendlier/);
  assert.match(release.plan.warning, /goes live at https:\/\/acme\.example/);
  assert.deepEqual(remote.tags(), []);
  v = await flow.confirm(release.token, 'release', { notes: 'First release.' });
  assert.deepEqual(remote.tags(), ['v0.1.0']);
  assert.equal(remote.sha('v0.1.0'), remote.sha('main'));
  assert.equal(github.state.releases[0].notes, 'First release.');
  assert.equal(v.release.tag, 'v0.1.0');
  assert.equal(v.stage, 'production');

  // Production
  flow.health('production');
  await until(() => web.hits.some((u) => u === 'https://acme.example/api/health'));
  web.production = '{"ok":true,"version":"v0.1.0"}';
  await until(() => config.getChange('acme/site').production.live);
  v = await flow.view();
  assert.equal(v.stage, 'done');

  // Finish: back on an up-to-date main, change forgotten
  v = await flow.finish();
  assert.equal(v.stage, 'idle');
  assert.equal(site.branch, 'main');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(), remote.sha('main'));
  assert.equal(execFileSync('git', ['branch', '--list', 'change/*'], { cwd: dir }).toString().trim(), '');
  assert.equal(config.getChange('acme/site'), null);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), '<h1>hello, world</h1>\n'); // git on Windows may check out CRLF

  // Nothing was ever force-pushed, and main was never pushed from here.
  const pushes = github.state.gitCalls.filter((c) => / push /.test(` ${c} `));
  assert.ok(pushes.length >= 1);
  assert.ok(pushes.every((c) => !/--force|-f\b|\+refs|refs\/heads\/main/.test(c)), pushes.join('\n'));
});

test('nothing is sent unless tests pass, or the person overrides for those exact files', async (t) => {
  const { remote, github, flow, edit, config } = setup(t);
  await flow.start({ description: 'Risky' });
  edit('index.html', '<h1>changed</h1>\n');

  await assert.rejects(flow.prepare('pr'), /Run the tests first/);

  edit('BROKEN', 'yes\n');
  const result = await flow.tests();
  assert.equal(result.passed, false);
  assert.match(result.output, /BROKEN exists/);
  let v = await flow.view();
  assert.equal(v.next.id, 'tests');
  assert.ok(v.also.some((a) => a.id === 'ask-ai'));
  await assert.rejects(flow.prepare('pr'), /tests are failing/);
  assert.deepEqual(remote.branches(), ['main']);

  // What the AI is handed to fix it
  const ask = await flow.aiRequest('tests');
  assert.match(ask.context, /1 test failed: BROKEN exists/);

  // Override, shown plainly in the plan
  const forced = await flow.prepare('pr', { override: true });
  assert.match(forced.plan.warning, /tests are failing/i);
  assert.equal(forced.plan.override, true);
  v = await flow.confirm(forced.token, 'pr');
  assert.equal(github.state.prs.length, 1);
  assert.ok(config.getChange('acme/site').override);
  assert.match(v.steps.find((s) => s.id === 'tests').detail, /chose to go ahead/);

  // New edits need their own test run: the override does not carry over.
  edit('index.html', '<h1>changed again</h1>\n');
  v = await flow.view();
  assert.equal(v.next.id, 'tests');
  await assert.rejects(flow.prepare('update-pr'), /Run the tests first/);
});

test('a plan is refused if the files change after it was shown, and a token works once', async (t) => {
  const { remote, flow, edit } = setup(t);
  await flow.start({ description: 'Sneaky' });
  edit('index.html', '<h1>reviewed</h1>\n');
  await flow.tests();

  const shown = await flow.prepare('pr');
  edit('index.html', '<h1>swapped after review</h1>\n');
  await assert.rejects(flow.confirm(shown.token, 'pr'), /files changed after you reviewed/);
  assert.deepEqual(remote.branches(), ['main'], 'nothing was pushed');
  await assert.rejects(flow.confirm(shown.token, 'pr'), /no longer valid/);

  await flow.tests();
  const again = await flow.prepare('pr');
  await assert.rejects(flow.confirm(again.token, 'merge'), /different step/);
  await assert.rejects(flow.confirm('guessed-token', 'pr'), /no longer valid/);
  assert.deepEqual(remote.branches(), ['main']);
});

test('secrets stop the commit, by file name or by content', async (t) => {
  const { remote, dir, flow, edit } = setup(t);
  await flow.start({ description: 'Config' });
  edit('.env', `ADMIN_TOKEN=${'9f8a7b6c5d4e3f2a' + '1b0c9d8e7f6a5b4c'}\n`);
  await flow.tests();
  const byName = await flow.prepare('pr').catch((e) => e);
  assert.match(byName.message, /looks like a secret/);
  assert.match(byName.message, /Nothing was committed or sent/);
  assert.deepEqual(byName.data.findings.map((f) => f.path), ['.env', '.env']);

  fs.rmSync(path.join(dir, '.env'));
  edit('config.js', `export const token = "${'gh' + 'p_'}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\n`);
  await flow.tests();
  const byContent = await flow.prepare('pr').catch((e) => e);
  assert.match(byContent.message, /config\.js: A line looks like it contains a GitHub token/);

  edit('config.js', 'export const token = process.env.GITHUB_TOKEN;\n');
  await flow.tests();
  const fine = await flow.prepare('pr');
  assert.ok(fine.token);
  assert.deepEqual(remote.branches(), ['main']);
  assert.equal(execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString().trim().split('\n').length, 1, 'nothing was committed along the way');
});

test('a secret that appears between review and confirm is still caught', async (t) => {
  const { remote, dir, flow, edit, gitops } = setup(t);
  await flow.start({ description: 'Race' });
  edit('index.html', '<h1>fine</h1>\n');
  await flow.tests();
  const shown = await flow.prepare('pr');
  // Pretend the tree id did not notice (it does; this checks the second line of defence).
  const realTree = gitops.treeId;
  const frozen = await gitops.treeId(dir);
  gitops.treeId = async () => frozen;
  edit('id_rsa', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nabc\n`);
  const err = await flow.confirm(shown.token, 'pr').catch((e) => e);
  gitops.treeId = realTree;
  assert.match(err.message, /looks like a secret/);
  assert.deepEqual(remote.branches(), ['main']);
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString().trim(), '', 'the staged files were unstaged again');
});

test('the default branch is never committed or pushed to', async (t) => {
  const { remote, dir, gitops, flow, edit } = setup(t);
  const before = remote.sha('main');
  edit('index.html', '<h1>on main</h1>\n');

  await assert.rejects(flow.prepare('pr'), /Start a change first/);
  await gitops.stageAll(dir);
  await assert.rejects(gitops.commit(dir, 'sneak', { defaultBranch: 'main' }), /never commits to main directly/);
  await assert.rejects(gitops.push(dir, 'main', { defaultBranch: 'main' }), /never pushes to main directly/);
  // The first-commit exception does not apply once GitHub has commits.
  await assert.rejects(gitops.commit(dir, 'sneak', { defaultBranch: 'main', firstCommit: true }), /only possible in a repo with no commits/);
  await assert.rejects(gitops.push(dir, 'main', { defaultBranch: 'main', firstCommit: true }), /already has commits/);
  await assert.rejects(flow.prepare('first-commit'), /already has commits/);
  await assert.rejects(gitops.push(dir, '--force', { defaultBranch: 'main' }), /No branch to push/);
  assert.equal(remote.sha('main'), before);
  assert.equal(execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString().trim().split('\n').length, 1);
});

test('merging needs green checks and an up-to-date pull request', async (t) => {
  const { remote, github, flow, edit, go } = setup(t);
  await flow.start({ description: 'Checks' });
  edit('index.html', '<h1>v2</h1>\n');
  await flow.tests();
  github.state.checks = () => [
    { name: 'npm test', bucket: 'pending', state: 'IN_PROGRESS', link: 'https://x/1' },
    { name: 'docker', bucket: 'pass', state: 'SUCCESS', link: 'https://x/2' },
  ];
  let { view: v } = await go('pr');
  const before = remote.sha('main');
  assert.equal(v.next.enabled, false);
  assert.match(v.next.why, /Waiting for the checks/);
  await assert.rejects(flow.prepare('merge'), /still running/);

  github.state.checks = () => [{ name: 'npm test', bucket: 'fail', state: 'FAILURE', link: 'https://x/1' }];
  v = await flow.refresh();
  assert.equal(v.steps.find((s) => s.id === 'ci').status, 'failed');
  assert.deepEqual(v.checks, [{ name: 'npm test', bucket: 'fail', link: 'https://x/1' }]);
  await assert.rejects(flow.prepare('merge'), /Checks are failing \(npm test\)/);
  assert.match((await flow.aiRequest('ci')).context, /npm test \(https:\/\/x\/1\)/);

  // Fix it: new edits must be tested and pushed before the merge is offered again.
  github.state.checks = () => [{ name: 'npm test', bucket: 'pass', state: 'SUCCESS', link: 'https://x/1' }];
  edit('index.html', '<h1>v3</h1>\n');
  await assert.rejects(flow.prepare('merge'), /Update the PR first/);
  await flow.tests();
  v = await flow.view();
  assert.equal(v.next.id, 'update-pr');
  ({ view: v } = await go('update-pr'));
  assert.equal(remote.show('change/checks', 'index.html'), '<h1>v3</h1>');
  assert.equal(github.state.prs.length, 1, 'the same pull request is updated');
  assert.equal(v.next.id, 'merge');

  // If the branch moved on GitHub since the review, the merge is refused there.
  const shown = await flow.prepare('merge');
  github.state.failNext = { match: /^pr merge/, stderr: 'GraphQL: Head branch was modified. Review and try the merge again.' };
  await assert.rejects(flow.confirm(shown.token, 'merge'), /Head branch was modified/);
  assert.equal(remote.sha('main'), before);

  await go('merge');
  assert.equal(remote.show('main', 'index.html'), '<h1>v3</h1>');
});

test('the CI step watches the checks by itself until they finish', async (t) => {
  const { github, flow, edit, go, events } = setup(t);
  await flow.start({ description: 'Watch' });
  edit('index.html', '<h1>w</h1>\n');
  await flow.tests();
  let pending = true;
  github.state.checks = () => [{ name: 'npm test', bucket: pending ? 'pending' : 'pass', state: 'X', link: 'l' }];
  const { view: v } = await go('pr');
  assert.equal(v.next.enabled, false);
  const asked = () => github.state.calls.filter((c) => c.startsWith('pr checks')).length;
  await until(() => asked() >= 3);
  pending = false;
  await until(() => events.some((e) => e.next && e.next.id === 'merge' && e.next.enabled));
  const settled = asked();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(asked() <= settled + 1, 'it stops asking once the checks are done');
});

test('a repo with no checks can still be merged, with a warning', async (t) => {
  const { github, flow, edit, go } = setup(t);
  await flow.start({ description: 'No ci' });
  edit('index.html', '<h1>n</h1>\n');
  await flow.tests();
  github.state.checks = () => [];
  const { view: v } = await go('pr');
  assert.equal(v.next.id, 'merge');
  const merge = await flow.prepare('merge');
  assert.match(merge.plan.warning, /no checks/);
});

test('just after a push, a site with workflows waits for GitHub to list its checks', async (t) => {
  // Seen on a real repo: for a few seconds after the pull request opens GitHub
  // lists no checks at all, and Roadie offered Merge as if the repo had none.
  let clock = 1_000_000;
  const { github, flow, edit, go } = setup(t, {
    files: { ...SITE_FILES, '.github/workflows/tests.yml': 'on: pull_request\n' },
    flowOptions: { now: () => clock, checksGraceMs: 60_000, pollMs: 100_000 },
  });
  await flow.start({ description: 'Slow to start' });
  edit('index.html', '<h1>s</h1>\n');
  await flow.tests();
  github.state.checks = () => [];
  const { view: v } = await go('pr');
  assert.equal(v.next.enabled, false, 'Merge is not offered yet');
  assert.match(v.steps.find((s) => s.id === 'ci').detail, /Waiting for GitHub to start the checks/);
  await assert.rejects(flow.prepare('merge'), /still running/);

  // The checks appear and pass: now it can be merged.
  github.state.checks = () => [{ name: 'tests', bucket: 'pass', state: 'SUCCESS', link: 'https://github.com/acme/site/actions/runs/1' }];
  assert.equal((await flow.refresh()).next.enabled, true);

  // If none ever appear, Roadie stops waiting after a while and says the repo has none.
  github.state.checks = () => [];
  assert.equal((await flow.refresh()).next.enabled, false);
  clock += 61_000;
  assert.equal((await flow.refresh()).next.enabled, true);
  assert.match((await flow.prepare('merge')).plan.warning, /no checks/);
});

test('the release follows the newest version and refuses one that exists', async (t) => {
  const { remote, github, flow, edit, go } = setup(t, { settings: { stagingUrl: '', productionUrl: '', healthPath: '' } });
  execFileSync('git', ['tag', 'v1.4.2', 'main'], { cwd: remote.bare });
  github.state.releases.push({ tag: 'v1.4.2', at: '2026-01-01T00:00:00Z' });
  await flow.start({ description: 'Rel' });
  edit('index.html', '<h1>r</h1>\n');
  await flow.tests();
  await go('pr');
  await assert.rejects(flow.prepare('release'), /Merge the pull request first/);
  const { view: merged } = await go('merge');
  assert.equal(merged.stage, 'release', 'with no staging URL the bar goes straight to release');

  const plan = (await flow.prepare('release')).plan;
  assert.deepEqual(plan.versions, { latest: 'v1.4.2', patch: 'v1.4.3', minor: 'v1.5.0', major: 'v2.0.0', suggested: 'v1.4.3' });
  assert.equal(plan.previousTag, 'v1.4.2');
  assert.equal(plan.warning, null);
  await assert.rejects(flow.prepare('release', { tag: 'v1.4.2' }), /already exists/);
  await assert.rejects(flow.prepare('release', { tag: 'v2; rm -rf /' }), /not a usable version/);

  const { view: v } = await go('release', { tag: 'v1.5.0' });
  assert.equal(v.release.tag, 'v1.5.0');
  assert.ok(remote.tags().includes('v1.5.0'));
  assert.equal(v.next.id, 'finish');
  await assert.rejects(flow.prepare('release'), /already released as v1\.5\.0/);
});

test('an empty repo gets one first commit to main, with confirmation, and never a second', async (t) => {
  const { remote, dir, flow, edit, go, github } = setup(t, { files: null });
  assert.deepEqual(remote.branches(), []);
  let v = await flow.view();
  assert.equal(v.stage, 'first-commit');
  assert.equal(v.next.enabled, false);
  await assert.rejects(flow.start({ description: 'x' }), /no commits yet/);

  edit('index.html', '<h1>new site</h1>\n');
  edit('check.js', SITE_FILES['check.js']);
  edit('.env', `SECRET_KEY=${'abc123def456' + 'ghi789jkl'}\n`);
  await assert.rejects(flow.prepare('first-commit'), /looks like a secret/);
  fs.rmSync(path.join(dir, '.env'));

  const shown = await flow.prepare('first-commit');
  assert.match(shown.plan.summary, /only time Roadie pushes to main/);
  assert.deepEqual(shown.plan.commands, ['git add -A', 'git commit -m "First commit"', 'git push origin main']);
  assert.deepEqual(remote.branches(), []);
  v = await flow.confirm(shown.token, 'first-commit');
  assert.deepEqual(remote.branches(), ['main']);
  assert.deepEqual(remote.log('main'), ['First commit']);
  assert.equal(v.stage, 'idle');
  assert.equal(v.next.id, 'start');

  // From here on it is pull requests only.
  edit('index.html', '<h1>second</h1>\n');
  await assert.rejects(flow.prepare('first-commit'), /already has commits/);
  await flow.start({ description: 'Second' });
  await flow.tests();
  await go('pr');
  assert.deepEqual(remote.log('main'), ['First commit']);
  assert.equal(github.state.prs.length, 1);
});

test('abandoning a change keeps the edits in the stash and goes back to main', async (t) => {
  const { dir, flow, edit, go, config, remote } = setup(t);
  await flow.start({ description: 'Never mind' });
  edit('index.html', '<h1>half done</h1>\n');
  edit('new.txt', 'draft\n');
  const { plan, view: v } = await go('discard');
  assert.equal(plan.local, true);
  assert.match(plan.summary, /set aside in git's stash, not deleted/);
  assert.equal(v.stage, 'idle');
  assert.equal(config.getChange('acme/site'), null);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), '<h1>hello</h1>\n');
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
  assert.match(execFileSync('git', ['stash', 'list'], { cwd: dir }).toString(), /roadie: change\/never-mind/);
  execFileSync('git', ['stash', 'pop'], { cwd: dir });
  assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8').replace(/\r\n/g, '\n'), 'draft\n', 'the edits can be brought back');
  assert.deepEqual(remote.branches(), ['main']);
});

test('a health URL that is down or wrong is reported, not mistaken for live', async (t) => {
  const { flow, edit, go, config, web } = setup(t);
  await flow.start({ description: 'Down' });
  edit('index.html', '<h1>d</h1>\n');
  await flow.tests();
  await go('pr');
  await go('merge');
  assert.throws(() => flow.health('production'), /Publish the release first/);
  web.staging = new Error('getaddrinfo ENOTFOUND staging.acme.example');
  flow.health('staging');
  await until(() => config.getChange('acme/site').staging.error);
  const s = config.getChange('acme/site').staging;
  assert.equal(s.live, false);
  assert.equal(s.polling, true);
  assert.match(s.error, /No answer/);
  flow.health('staging', { stop: true });
  assert.equal(config.getChange('acme/site').staging.polling, false);
  const hits = web.hits.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(web.hits.length, hits);
});

test('a merge done on GitHub instead of in Roadie is picked up', async (t) => {
  const { github, flow, edit, go, remote } = setup(t);
  await flow.start({ description: 'Elsewhere' });
  edit('index.html', '<h1>e</h1>\n');
  await flow.tests();
  await go('pr');
  // Someone clicks Merge on github.com
  const pr = github.state.prs[0];
  const r = await github.run('gh', ['pr', 'merge', '1', '-R', 'acme/site', '--squash', '--match-head-commit', remote.sha(`refs/heads/${pr.head}`)]);
  assert.equal(r.code, 0);
  const v = await flow.refresh();
  assert.equal(v.stage, 'staging');
  assert.equal(v.merge.sha, remote.sha('main'));
});

test('a test run the AI asked for counts, but only for the files as they were then', async (t) => {
  const { flow, edit, dir, config } = setup(t);
  await flow.start({ description: 'AI ran it' });
  edit('index.html', '<h1>ai</h1>\n');
  // What the AI's run_tests tool does: the same runner, then tell the change bar.
  const aiRun = async () => {
    const started = await flow.beginTests();
    await flow.recordTests(started, await runTests({ dir, command: 'node check.js' }));
  };
  await aiRun();
  let v = await flow.view();
  assert.equal(v.next.id, 'pr');
  assert.equal(config.getChange('acme/site').tests.by, 'ai');
  assert.match(v.testOutput, /all tests passed/);

  edit('index.html', '<h1>ai, then edited</h1>\n');
  v = await flow.view();
  assert.equal(v.next.id, 'tests');

  edit('BROKEN', 'x\n');
  await aiRun();
  v = await flow.view();
  assert.equal(v.steps.find((s) => s.id === 'tests').status, 'failed');
  await assert.rejects(flow.prepare('pr'), /tests are failing/);
});

test('a change that touches workflow files warns when gh may not push them', async (t) => {
  const { flow, edit, github, go, remote } = setup(t);
  await flow.start({ description: 'Add CI' });
  edit('.github/workflows/test.yml', 'name: tests\non: [push]\n');
  await flow.tests();

  github.state.scopes = ['gist', 'read:org', 'repo'];
  const warned = await flow.prepare('pr');
  assert.match(warned.plan.warning, /workflow file/);
  assert.match(warned.plan.warning, /gh auth refresh -h github\.com -s workflow/);

  github.state.scopes = ['repo', 'workflow'];
  const fine = await flow.prepare('pr');
  assert.equal(fine.plan.warning, null);
  await go('pr');
  assert.ok(remote.branches().includes('change/add-ci'));
});

test('when GitHub refuses a push, the reason and the fix are spelled out', async () => {
  const refuse = (stderr) => createGitOps({ run: async (cmd, args) => (args.includes('push')
    ? { code: 1, stdout: '', stderr, missing: false }
    : { code: 0, stdout: '', stderr: '', missing: false }) });

  const scope = await refuse(' ! [remote rejected] x -> x (refusing to allow an OAuth App to create or update workflow `.github/workflows/test.yml` without `workflow` scope)')
    .push('/tmp', 'change/x', { defaultBranch: 'main' }).catch((e) => e);
  assert.match(scope.message, /workflow file/);
  assert.match(scope.message, /gh auth refresh -h github\.com -s workflow/);

  const secret = await refuse('remote: error: GH013: Repository rule violations found for refs/heads/x.\nremote: - Push cannot contain secrets')
    .push('/tmp', 'change/x', { defaultBranch: 'main' }).catch((e) => e);
  assert.match(secret.message, /refused the push under one of the repo's rules/);
  assert.match(secret.message, /Push cannot contain secrets/, 'GitHub\'s own words are kept');

  const hostKey = await refuse('Host key verification failed.\nfatal: Could not read from remote repository.')
    .push('/tmp', 'change/x', { defaultBranch: 'main' }).catch((e) => e);
  assert.match(hostKey.message, /ssh -T git@github\.com/);
});

test('if the first push fails, it can be tried again without getting stuck', async (t) => {
  const { remote, flow, edit, github } = setup(t, { files: null });
  edit('index.html', '<h1>new</h1>\n');
  const shown = await flow.prepare('first-commit');
  // The network drops just as the push starts: the commit is made, the push is not.
  github.state.failGitPush = true;
  await assert.rejects(flow.confirm(shown.token, 'first-commit'), /Pushing main failed/);
  assert.deepEqual(remote.branches(), []);
  github.state.failGitPush = false;
  let v = await flow.view();
  assert.equal(v.stage, 'first-commit');
  assert.equal(v.next.label, 'Push the first commit');
  assert.equal(v.next.enabled, true);
  const retry = await flow.prepare('first-commit');
  assert.deepEqual(retry.plan.commands, ['git push origin main']);
  v = await flow.confirm(retry.token, 'first-commit');
  assert.deepEqual(remote.branches(), ['main']);
  assert.equal(v.next.id, 'start');
});

test('edits that land while the tests are running are not counted as tested', async (t) => {
  const { flow, edit } = setup(t, { settings: { test: 'node slow-check.js' } });
  await flow.start({ description: 'Mid-run' });
  edit('index.html', '<h1>before the run</h1>\n');
  const running = flow.tests();
  await new Promise((r) => setTimeout(r, 150));
  edit('index.html', '<h1>changed during the run</h1>\n'); // the AI is still writing
  assert.equal((await running).passed, true);
  const v = await flow.view();
  assert.equal(v.next.id, 'tests', 'the pass does not open the pull request');
  assert.match(v.steps.find((s) => s.id === 'tests').detail, /changed while the tests were running/);
  await assert.rejects(flow.prepare('pr'), /Run the tests first/);
});

test('a health check that answers after the change is finished does not bring it back', async (t) => {
  const { flow, edit, go, config, web } = setup(t);
  await flow.start({ description: 'Late answer' });
  edit('index.html', '<h1>l</h1>\n');
  await flow.tests();
  await go('pr');
  await go('merge');
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  web.wait = slow; // the health URL takes its time to answer
  flow.health('staging');
  await new Promise((r) => setTimeout(r, 40));
  await flow.finish();
  assert.equal(config.getChange('acme/site'), null);
  release();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(config.getChange('acme/site'), null, 'still finished');
  assert.equal((await flow.view()).next.id, 'start');
});

test('a merge is recorded even when GitHub is slow to say which commit it made', async (t) => {
  const { flow, edit, go, github, remote } = setup(t, { pollMs: 5 });
  await flow.start({ description: 'Slow github' });
  edit('index.html', '<h1>s</h1>\n');
  await flow.tests();
  await go('pr');
  // After the merge, GitHub cannot be reached for a while.
  const shown = await flow.prepare('merge');
  github.state.failAll = /^pr view/;
  let v = await flow.confirm(shown.token, 'merge');
  assert.equal(remote.log('main')[0], `${github.state.prs[0].title} (#1)`, 'the merge really happened');
  assert.equal(v.merge.sha, null);
  assert.equal(v.stage, 'merged');
  assert.equal(v.next.id, 'refresh');
  assert.throws(() => flow.health('staging'), /not yet said which commit/);
  await assert.rejects(flow.prepare('release'), /not yet said which commit/);
  github.state.failAll = null;
  v = await flow.refresh();
  assert.equal(v.merge.sha, remote.sha('main'));
  assert.equal(v.next.id, 'staging');
});

test('checks are read again at the moment of merging', async (t) => {
  const { flow, edit, go, github, remote } = setup(t);
  await flow.start({ description: 'Late red' });
  edit('index.html', '<h1>r</h1>\n');
  await flow.tests();
  await go('pr');
  const before = remote.sha('main');
  const shown = await flow.prepare('merge'); // green when shown
  github.state.checks = () => [{ name: 'npm test', bucket: 'fail', state: 'FAILURE', link: 'l' }];
  await assert.rejects(flow.confirm(shown.token, 'merge'), /now failing \(npm test\), so Roadie did not merge/);
  assert.equal(remote.sha('main'), before);
});

test('a change with an open pull request can still be abandoned, from any branch', async (t) => {
  const { flow, edit, go, dir, config } = setup(t);
  await flow.start({ description: 'Abandon me' });
  edit('index.html', '<h1>a</h1>\n');
  await flow.tests();
  const { view: v } = await go('pr');
  assert.ok(v.also.some((a) => a.id === 'discard'));
  execFileSync('git', ['switch', '-q', 'main'], { cwd: dir }); // the person wandered off in a terminal
  const { plan } = await go('discard');
  assert.match(plan.summary, /Pull request #1 stays open on GitHub/);
  assert.equal(config.getChange('acme/site'), null);
});
