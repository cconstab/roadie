import assert from 'node:assert/strict';
import test from 'node:test';
import { branchName, changeView, healthMatches, healthVersion, nextVersions, parseVersion, slugify, summarizeChecks, testsVerdict } from '../src/change.js';
import { parseDraft } from '../src/agent.js';
import { createConfirmations, scanForSecrets } from '../src/guards.js';

const SETTINGS = { stagingUrl: 'https://staging.example.dev', productionUrl: 'https://example.dev', healthPath: '/api/health' };
const base = (over = {}) => ({
  defaultBranch: 'main', branch: 'main', remoteEmpty: false, record: null, filesChanged: 0, treeId: 'T1',
  hasTestCommand: true, pr: null, checks: null, settings: SETTINGS, ...over,
});
const rec = (over = {}) => ({ branch: 'change/x', description: 'x', base: 'B', ...over });
const onBranch = (record, over = {}) => base({ branch: 'change/x', record, filesChanged: 2, ...over });
const statuses = (v) => Object.fromEntries(v.steps.map((s) => [s.id, s.status]));
const PASS = { state: 'pass', total: 3, passing: 3, pending: 0, failing: [] };

test('with no change in progress the one next step is Start change', () => {
  const v = changeView(base());
  assert.equal(v.stage, 'idle');
  assert.deepEqual(v.next, { id: 'start', label: 'Start change', enabled: true });
  assert.deepEqual(v.steps.map((s) => s.id), ['start', 'tests', 'pr', 'ci', 'merge', 'staging', 'release', 'production']);
  assert.match(changeView(base({ filesChanged: 3 })).note, /3 changed files not yet on a branch/);
});

test('an empty GitHub repo needs its first commit before anything else', () => {
  const none = changeView(base({ remoteEmpty: true }));
  assert.equal(none.next.id, 'first-commit');
  assert.equal(none.next.enabled, false);
  const some = changeView(base({ remoteEmpty: true, filesChanged: 18 }));
  assert.equal(some.next.enabled, true);
  assert.match(some.note, /one first commit/);
});

test('a new change with no edits cannot move on', () => {
  const v = changeView(onBranch(rec(), { filesChanged: 0 }));
  assert.equal(v.stage, 'editing');
  assert.equal(v.next.enabled, false);
  assert.match(v.next.why, /Nothing has changed/);
});

test('tests come before the pull request, and must match the files as they are now', () => {
  const fresh = changeView(onBranch(rec()));
  assert.equal(fresh.next.id, 'tests');

  const passed = changeView(onBranch(rec({ tests: { passed: true, tree: 'T1' } })));
  assert.deepEqual(passed.next, { id: 'pr', label: 'Open PR', enabled: true });
  assert.equal(statuses(passed).tests, 'done');

  const editedSince = changeView(onBranch(rec({ tests: { passed: true, tree: 'OLD' } })));
  assert.equal(editedSince.next.id, 'tests');
  assert.equal(statuses(editedSince).tests, 'current');
  assert.match(editedSince.steps[1].detail, /changed since/);
});

test('failing tests block the pull request, offer the AI, and allow an explicit override', () => {
  const failed = changeView(onBranch(rec({ tests: { passed: false, tree: 'T1' } })));
  assert.equal(failed.next.id, 'tests');
  assert.equal(statuses(failed).tests, 'failed');
  assert.deepEqual(failed.also.map((a) => a.id), ['ask-ai', 'override', 'discard']);

  const overridden = changeView(onBranch(rec({ tests: { passed: false, tree: 'T1' }, override: { tree: 'T1' } })));
  assert.equal(overridden.next.id, 'pr');
  // The override is for those exact files only.
  const staleOverride = changeView(onBranch(rec({ tests: { passed: false, tree: 'T1' }, override: { tree: 'T1' } }), { treeId: 'T2' }));
  assert.equal(staleOverride.next.id, 'tests');
});

test('a site with no test command skips the tests step', () => {
  const v = changeView(onBranch(rec(), { hasTestCommand: false }));
  assert.equal(statuses(v).tests, 'skipped');
  assert.equal(v.next.id, 'pr');
});

test('an open pull request waits for CI, then offers Merge', () => {
  const pr = { number: 7, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE' };
  const r = rec({ tests: { passed: true, tree: 'T1' }, pr, pushedTree: 'T1' });

  const pending = changeView(onBranch(r, { pr, checks: { state: 'pending', total: 3, passing: 1, pending: 2, failing: [] } }));
  assert.equal(pending.stage, 'pr-open');
  assert.equal(pending.next.enabled, false);
  assert.equal(statuses(pending).ci, 'current');

  const failing = changeView(onBranch(r, { pr, checks: { state: 'fail', total: 3, passing: 2, pending: 0, failing: [{ name: 'npm test', link: 'l' }] } }));
  assert.equal(failing.next.enabled, false);
  assert.equal(statuses(failing).ci, 'failed');
  assert.match(failing.steps[3].detail, /npm test/);

  const green = changeView(onBranch(r, { pr, checks: PASS }));
  assert.deepEqual(green.next, { id: 'merge', label: 'Merge', enabled: true });

  const none = changeView(onBranch(r, { pr, checks: { state: 'none', total: 0, passing: 0, pending: 0, failing: [] } }));
  assert.equal(none.next.id, 'merge');
  assert.match(none.steps[3].detail, /no checks/);

  const conflict = changeView(onBranch(r, { pr: { ...pr, mergeable: 'CONFLICTING' }, checks: PASS }));
  assert.equal(conflict.next.enabled, false);
  assert.match(conflict.note, /conflicts with main/);
});

test('edits made after the pull request must be tested and pushed before merging', () => {
  const pr = { number: 7, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE' };
  const r = rec({ tests: { passed: true, tree: 'T1' }, pr, pushedTree: 'T1' });
  const edited = changeView(onBranch(r, { pr, checks: PASS, treeId: 'T2' }));
  assert.equal(edited.next.id, 'tests');
  const retested = changeView(onBranch({ ...r, tests: { passed: true, tree: 'T2' } }, { pr, checks: PASS, treeId: 'T2' }));
  assert.equal(retested.next.id, 'update-pr');
});

test('after the merge: staging, then release, then production, then finish', () => {
  const pr = { number: 7, url: 'u', state: 'MERGED' };
  const merged = rec({ pr, merge: { sha: 'abcdef1234' }, tests: { passed: true, tree: 'T1' } });

  const staging = changeView(onBranch(merged, { pr }));
  assert.equal(staging.stage, 'staging');
  assert.equal(staging.next.id, 'staging');
  assert.ok(staging.also.some((a) => a.id === 'finish'));
  assert.equal(changeView(onBranch({ ...merged, staging: { polling: true } }, { pr })).next.id, 'staging-stop');

  const live = { ...merged, staging: { live: true, seen: 'main-abcdef1' } };
  const release = changeView(onBranch(live, { pr }));
  assert.equal(release.stage, 'release');
  assert.equal(release.next.id, 'release');
  assert.equal(statuses(release).staging, 'done');

  const released = { ...live, release: { tag: 'v1.0.1' } };
  const production = changeView(onBranch(released, { pr }));
  assert.equal(production.stage, 'production');
  assert.equal(production.next.id, 'production');

  const done = changeView(onBranch({ ...released, production: { live: true } }, { pr }));
  assert.equal(done.stage, 'done');
  assert.equal(done.next.id, 'finish');
  assert.ok(Object.values(statuses(done)).every((s) => s === 'done'));
});

test('a site with no staging or production skips those steps', () => {
  const pr = { number: 7, url: 'u', state: 'MERGED' };
  const merged = rec({ pr, merge: { sha: 'abc' } });
  const v = changeView(onBranch(merged, { pr, settings: { stagingUrl: '', productionUrl: '', healthPath: '' } }));
  assert.equal(statuses(v).staging, 'skipped');
  assert.equal(statuses(v).production, 'skipped');
  assert.equal(v.next.id, 'release');
  const released = changeView(onBranch({ ...merged, release: { tag: 'v1' } }, { pr, settings: { stagingUrl: '', productionUrl: '', healthPath: '' } }));
  assert.equal(released.next.id, 'finish');
});

test('a pull request closed on GitHub ends the change', () => {
  const pr = { number: 7, url: 'u', state: 'CLOSED' };
  const v = changeView(onBranch(rec({ pr }), { pr }));
  assert.equal(v.stage, 'closed');
  assert.equal(v.next.id, 'finish');
});

test('branch names come from the description', () => {
  assert.equal(slugify('Make the Heading RED!'), 'make-the-heading-red');
  assert.equal(slugify('  ../../etc ; rm -rf /  '), 'etc-rm-rf');
  assert.equal(slugify('Añadir café ☕'), 'anadir-cafe');
  assert.equal(branchName('Fix footer'), 'change/fix-footer');
  assert.equal(branchName('', new Date('2026-11-23T04:05:00Z')), 'change/20261123-0405');
  assert.ok(branchName('x'.repeat(200)).length <= 47);
});

test('the next version follows the newest tag and keeps its style', () => {
  assert.deepEqual(nextVersions(['v1.0.0']), { latest: 'v1.0.0', patch: 'v1.0.1', minor: 'v1.1.0', major: 'v2.0.0', suggested: 'v1.0.1' });
  assert.equal(nextVersions(['v1.2.9', 'v1.10.0', 'v1.9.3', 'nightly', 'v2.0.0-rc1']).patch, 'v1.10.1');
  assert.equal(nextVersions(['1.4.2']).minor, '1.5.0');
  assert.equal(nextVersions([]).suggested, 'v0.1.0');
  assert.equal(parseVersion('release-1'), null);
});

test('a health answer matches only the exact commit or tag', () => {
  const staging = '{"ok":true,"version":"main-038052b","posts":7}';
  assert.equal(healthMatches(staging, '038052b'), true);
  assert.equal(healthMatches(staging, '038052c'), false);
  const prod = '{"ok":true,"version":"v1.2.0"}';
  assert.equal(healthMatches(prod, 'v1.2.0'), true);
  assert.equal(healthMatches('{"version":"v1.2.01"}', 'v1.2.0'), false);
  assert.equal(healthMatches('{"version":"v11.2.0"}', 'v1.2.0'), false);
  assert.equal(healthMatches('{"build":{"tag":"v1.2.0"}}', 'v1.2.0'), true);
  assert.equal(healthMatches('running build 038052b ok', '038052b'), true);
  assert.equal(healthMatches('<html>404</html>', 'v1.2.0'), false);
  assert.equal(healthMatches(staging, ''), false);
  assert.equal(healthVersion(staging), 'main-038052b');
  assert.equal(healthVersion('not json'), null);
});

test('checks are summed up into one verdict', () => {
  const c = (bucket, name = bucket) => ({ name, bucket, link: `l/${name}` });
  assert.equal(summarizeChecks([]).state, 'none');
  assert.equal(summarizeChecks([c('pass'), c('skipping')]).state, 'pass');
  assert.equal(summarizeChecks([c('pass'), c('pending')]).state, 'pending');
  assert.equal(summarizeChecks([c('pass'), c('pending'), c('fail')]).state, 'fail');
  assert.deepEqual(summarizeChecks([c('cancel', 'docker')]).failing, [{ name: 'docker', link: 'l/docker' }]);
  assert.equal(testsVerdict({ hasTestCommand: false }), 'none');
  assert.equal(testsVerdict({ hasTestCommand: true, tests: null, treeId: 'a' }), 'stale');
});

test('secrets are caught by file name and by content', () => {
  const hit = (line, file = 'config.js') => scanForSecrets({ additions: [{ path: file, line }] }).length > 0;
  assert.deepEqual(scanForSecrets({ files: ['index.html', '.env', 'deploy/server.pem', '.env.example'] }).map((f) => f.path), ['.env', 'deploy/server.pem']);

  // Made-up values, put together at run time so that no key-shaped text sits
  // in this file for other scanners to trip over.
  const filler = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  for (const line of [
    `const key = "${'sk-' + 'ant-'}api03-${filler}";`,
    `token: ${'gh' + 'p_'}${filler}`,
    `${'github_' + 'pat_'}11ABCDEFG0${filler.toLowerCase()}`,
    `aws_access_key_id = ${'AK' + 'IA'}IOSFODNN7EXAMPLE`,
    `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`,
    `DATABASE_URL=postgres://admin:${'hunter2' + 'secret'}@db.example.com/app`,
    `ADMIN_TOKEN=${'9f8a7b6c5d4e3f2a' + '1b0c9d8e7f6a5b4c'}`,
    'password: "Tr0ub4dor&3xyzzy"',
    `const stripe = "${'sk_' + 'live_'}${filler.slice(0, 24)}";`,
  ]) assert.ok(hit(line), line);

  for (const line of [
    'ADMIN_TOKEN=',
    'ADMIN_TOKEN=${ADMIN_TOKEN:-}',
    'const token = process.env.ADMIN_TOKEN;',
    'password: "<your password here>"',
    'api_key = "your-api-key-goes-here"',
    'const ADMIN_HASH = ADMIN_TOKEN ? sha(ADMIN_TOKEN) : null;',
    '<input type="password" name="password" autocomplete="current-password">',
    'if (!token) return fail(res, 401, "admins only");',
    'ADMIN_TOKEN: test-admin',
    '# Generate: openssl rand -hex 24',
  ]) assert.ok(!hit(line), line);
});

test('a confirmation works once, for its own step, for a limited time', () => {
  let time = 1000;
  let n = 0;
  const c = createConfirmations({ ttlMs: 500, now: () => time, random: () => `token-${++n}` });

  const first = c.prepare('pr', { title: 'x' });
  assert.equal(first.token, 'token-1');
  assert.deepEqual(c.take('token-1', 'pr'), { title: 'x' });
  assert.throws(() => c.take('token-1', 'pr'), /no longer valid/, 'a token cannot be used twice');

  c.prepare('merge', {});
  assert.throws(() => c.take('token-2', 'release'), /different step/);
  assert.throws(() => c.take('token-2', 'merge'), /no longer valid/, 'a wrong guess also uses the token up');

  c.prepare('release', {});
  time += 501;
  assert.throws(() => c.take('token-3', 'release'), /expired/);

  c.prepare('pr', {});
  c.prepare('merge', {});
  assert.throws(() => c.take('token-4', 'pr'), /no longer valid/, 'preparing a new step cancels the last');
  assert.throws(() => c.take('made-up', 'merge'), /no longer valid/);
});

test('the AI\'s pull request draft is read whether it is JSON or plain text', () => {
  assert.deepEqual(parseDraft('{"title": "Make the heading red.", "body": "- changes the colour"}'), { title: 'Make the heading red', body: '- changes the colour' });
  assert.deepEqual(parseDraft('Here you go:\n```json\n{"title":"Add footer","body":""}\n```'), { title: 'Add footer', body: '' });
  assert.deepEqual(parseDraft('Title: Fix the nav\n\n- one\n- two'), { title: 'Fix the nav', body: '- one\n- two' });
  assert.equal(parseDraft(''), null);
  assert.equal(parseDraft('{"nope": 1}').title, '{"nope": 1}');
});

test('every stage of a change offers a way out', () => {
  const open = { number: 7, url: 'u', state: 'OPEN', mergeable: 'MERGEABLE' };
  const merged = { number: 7, url: 'u', state: 'MERGED' };
  const cases = {
    'new, no edits': onBranch(rec(), { filesChanged: 0 }),
    'tests not run': onBranch(rec()),
    'tests failed': onBranch(rec({ tests: { passed: false, tree: 'T1' } })),
    'ready for PR': onBranch(rec({ tests: { passed: true, tree: 'T1' } })),
    'PR open, checks running': onBranch(rec({ pr: open, pushedTree: 'T1' }), { pr: open, checks: { state: 'pending', total: 1, passing: 0, pending: 1, failing: [] } }),
    'PR open, checks green': onBranch(rec({ pr: open, pushedTree: 'T1' }), { pr: open, checks: PASS }),
    'PR open, conflicts': onBranch(rec({ pr: open, pushedTree: 'T1' }), { pr: { ...open, mergeable: 'CONFLICTING' }, checks: PASS }),
    'PR open, newer edits': onBranch(rec({ pr: open, pushedTree: 'OLD' }), { pr: open, checks: PASS }),
    'PR closed': onBranch(rec({ pr: { ...open, state: 'CLOSED' } }), { pr: { ...open, state: 'CLOSED' } }),
    'merged, commit unknown': onBranch(rec({ pr: merged, merge: { sha: null } }), { pr: merged }),
    'merged, staging next': onBranch(rec({ pr: merged, merge: { sha: 'abc1234' } }), { pr: merged }),
    'merged, release next': onBranch(rec({ pr: merged, merge: { sha: 'abc1234' }, staging: { live: true } }), { pr: merged }),
    'released, production next': onBranch(rec({ pr: merged, merge: { sha: 'abc1234' }, staging: { live: true }, release: { tag: 'v1' } }), { pr: merged }),
    'all done': onBranch(rec({ pr: merged, merge: { sha: 'abc1234' }, staging: { live: true }, release: { tag: 'v1' }, production: { live: true } }), { pr: merged }),
  };
  for (const [name, facts] of Object.entries(cases)) {
    const v = changeView(facts);
    assert.equal(v.also.filter((a) => a.id === 'discard').length, 1, `${name}: Abandon is offered, once`);
    assert.ok(v.next, `${name}: there is a next step`);
  }
  // With no change in progress there is nothing to abandon.
  assert.ok(!changeView(base()).also.some((a) => a.id === 'discard'));
  assert.equal(changeView(cases['merged, commit unknown']).next.id, 'refresh');
});

test('a test run that changed files can be overridden, like a failing one', () => {
  const v = changeView(onBranch(rec({ tests: { passed: true, tree: 'OLD', dirtied: true } })));
  assert.equal(v.next.id, 'tests');
  assert.ok(v.also.some((a) => a.id === 'override'));
  assert.match(v.steps[1].detail, /add those files to \.gitignore/);
  const plainStale = changeView(onBranch(rec({ tests: { passed: true, tree: 'OLD' } })));
  assert.ok(!plainStale.also.some((a) => a.id === 'override'));
});

test('a health answer that gives the commit in full still matches the short form', () => {
  const full = '038052b3762ac180e251b199bb9e229ab1561888';
  assert.equal(healthMatches(`{"version":"${full}"}`, '038052b'), true);
  assert.equal(healthMatches(`{"version":"main-${full}"}`, '038052b'), true);
  assert.equal(healthMatches(`{"commit":"1${full}"}`, '038052b'), false, 'not when it is only somewhere in the middle');
  assert.equal(healthMatches('{"version":"v1.2.0-beta"}', 'v1.2.0'), false, 'a tag is still matched exactly');
});
