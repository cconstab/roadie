// The change bar's logic, as plain functions of facts. Nothing here runs git,
// touches the network or keeps state, so every rule can be tested directly.

export const STEPS = [
  { id: 'start', label: 'Start change' },
  { id: 'tests', label: 'Run tests' },
  { id: 'pr', label: 'Open PR' },
  { id: 'ci', label: 'CI' },
  { id: 'merge', label: 'Merge' },
  { id: 'staging', label: 'Staging' },
  { id: 'release', label: 'Release' },
  { id: 'production', label: 'Production' },
];

export function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export function branchName(description, now = new Date()) {
  const slug = slugify(description);
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  return `change/${slug || stamp}`;
}

export function parseVersion(tag) {
  const m = String(tag).match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
  return m ? { prefix: m[1], major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) } : null;
}

// The newest version among the tags, and the three ways to follow it.
export function nextVersions(tags) {
  const versions = tags.map((t) => ({ tag: t, v: parseVersion(t) })).filter((x) => x.v);
  versions.sort((a, b) => a.v.major - b.v.major || a.v.minor - b.v.minor || a.v.patch - b.v.patch);
  const latest = versions.at(-1);
  if (!latest) return { latest: null, patch: 'v0.1.0', minor: 'v0.1.0', major: 'v1.0.0', suggested: 'v0.1.0' };
  const { prefix, major, minor, patch } = latest.v;
  const out = {
    latest: latest.tag,
    patch: `${prefix}${major}.${minor}.${patch + 1}`,
    minor: `${prefix}${major}.${minor + 1}.0`,
    major: `${prefix}${major + 1}.0.0`,
  };
  return { ...out, suggested: out.patch };
}

// Does what a health URL answered show this build? `needle` is a short commit
// id or a release tag. A JSON answer is matched on its values, so a tag such
// as v1.2.0 does not match v1.2.01.
export function healthMatches(body, needle) {
  if (!needle || typeof body !== 'string') return false;
  // A commit id may be reported in full: the short form matches as its beginning.
  // A tag must match whole: v1.2.0 is not v1.2.0-beta.
  const isCommit = /^[0-9a-f]{7,40}$/.test(needle);
  const boundary = new RegExp(`(^|[^A-Za-z0-9.])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${isCommit ? '[0-9a-f]*($|[^A-Za-z0-9.])' : '($|[^A-Za-z0-9.+-])'}`);
  try {
    const values = [];
    const walk = (v) => {
      if (typeof v === 'string' || typeof v === 'number') values.push(String(v));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(body));
    return values.some((v) => v === needle || boundary.test(v));
  } catch {
    return boundary.test(body);
  }
}

export function healthVersion(body) {
  try {
    const data = JSON.parse(body);
    return typeof data.version === 'string' ? data.version : null;
  } catch { return null; }
}

// One verdict for a pull request's checks.
export function summarizeChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failing = list.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const pending = list.filter((c) => c.bucket === 'pending');
  const passing = list.filter((c) => c.bucket === 'pass' || c.bucket === 'skipping');
  const state = !list.length ? 'none' : failing.length ? 'fail' : pending.length ? 'pending' : 'pass';
  return { state, total: list.length, passing: passing.length, pending: pending.length, failing: failing.map((c) => ({ name: c.name, link: c.link })) };
}

// Are the tests known to pass for exactly the files as they are now?
export function testsVerdict({ hasTestCommand, tests, treeId }) {
  if (!hasTestCommand) return 'none';
  if (!tests || tests.tree !== treeId) return 'stale';
  return tests.passed ? 'passed' : 'failed';
}

const short = (sha) => String(sha || '').slice(0, 7);

// Given the facts, say where the change is and what the one next step is.
//
// facts: {
//   defaultBranch, branch, remoteEmpty,
//   record: null | { branch, description, tests, pr, pushedTree, merge, release, staging, production, override },
//   filesChanged, treeId, hasTestCommand,
//   pr: null | { number, url, state, mergeable }, checks: summarizeChecks(),
//   settings: { stagingUrl, productionUrl, healthPath },
// }
// returns { stage, steps: [{ id, label, status, detail }], next: null | { id, label, enabled, why }, also: [{ id, label }], note }
export function changeView(f) {
  const record = f.record;
  const status = {};
  const detail = {};
  const set = (id, s, d = '') => { status[id] = s; detail[id] = d; };
  for (const step of STEPS) set(step.id, 'todo');
  let stage = 'idle';
  let next = null;
  let note = '';
  const also = [];

  const canStaging = !!(f.settings.stagingUrl && f.settings.healthPath);
  const canProduction = !!(f.settings.productionUrl && f.settings.healthPath);
  if (!f.hasTestCommand) set('tests', 'skipped', 'This site has no test command.');
  if (!canStaging) set('staging', 'skipped', 'No staging URL or health path is set for this site.');
  if (!canProduction) set('production', 'skipped', 'No production URL or health path is set for this site.');

  const finish = () => {
    // Whatever state a change is in, there is always a way out of it.
    if (record && !also.some((a) => a.id === 'discard')) also.push({ id: 'discard', label: 'Abandon this change' });
    return { steps: STEPS.map((s) => ({ ...s, status: status[s.id], detail: detail[s.id] })), stage, next, also, note };
  };

  if (!record) {
    if (f.remoteEmpty) {
      stage = 'first-commit';
      note = 'GitHub has nothing for this repo yet. A repo needs one first commit on its main branch before changes can go through pull requests.';
      if (f.localCommits) {
        note = 'The first commit was made here but has not reached GitHub yet.';
        next = { id: 'first-commit', label: 'Push the first commit', enabled: true };
      } else {
        next = f.filesChanged > 0
          ? { id: 'first-commit', label: 'Make the first commit', enabled: true }
          : { id: 'first-commit', label: 'Make the first commit', enabled: false, why: 'There are no files yet. Set up the starter site or add some files first.' };
      }
      return finish();
    }
    if (f.branch !== f.defaultBranch) {
      note = `The clone is on branch ${f.branch}, which Roadie did not start. Start change will branch from the newest ${f.defaultBranch} and bring your uncommitted edits along.`;
    } else if (f.filesChanged > 0) {
      note = `There are ${f.filesChanged} changed file${f.filesChanged === 1 ? '' : 's'} not yet on a branch. Start change puts them on one.`;
    }
    set('start', 'current');
    next = { id: 'start', label: 'Start change', enabled: true };
    return finish();
  }

  set('start', 'done', record.branch);
  const verdict = testsVerdict({ hasTestCommand: f.hasTestCommand, tests: record.tests, treeId: f.treeId });
  const testsOk = verdict === 'passed' || verdict === 'none' || (record.override && record.override.tree === f.treeId);
  const describeTests = () => {
    if (verdict === 'passed') set('tests', 'done', 'Passed for the files as they are now.');
    else if (verdict === 'failed') set('tests', 'failed', record.override && record.override.tree === f.treeId ? 'Failed. You chose to go ahead anyway.' : 'Failed.');
    else if (verdict === 'stale') {
      set('tests', 'current', !record.tests ? 'Not run yet.'
        : record.tests.dirtied ? 'Files changed while the tests were running, so that run does not count. If the tests themselves write files into the site, add those files to .gitignore.'
        : 'Files changed since the last run.');
    }
  };

  // Before the pull request exists
  if (!f.pr) {
    stage = 'editing';
    describeTests();
    if (f.filesChanged === 0) {
      next = { id: 'tests', label: 'Run tests', enabled: false, why: 'Nothing has changed yet. Ask the AI for a change, or edit a file.' };
      if (verdict === 'none') next = { id: 'pr', label: 'Open PR', enabled: false, why: next.why };
      also.push({ id: 'discard', label: 'Abandon this change' });
      return finish();
    }
    if (testsOk) {
      set('pr', 'current');
      next = { id: 'pr', label: 'Open PR', enabled: true };
      if (verdict !== 'none') also.push({ id: 'tests', label: 'Run tests again' });
    } else {
      next = { id: 'tests', label: verdict === 'failed' ? 'Run tests again' : 'Run tests', enabled: true };
      if (verdict === 'failed') {
        note = 'The tests fail. Hand the failure to the AI, or fix it yourself, then run them again.';
        also.push({ id: 'ask-ai', label: 'Ask the AI to fix it' }, { id: 'override', label: 'Open PR anyway…' });
      } else if (record.tests && record.tests.dirtied) {
        also.push({ id: 'override', label: 'Open PR anyway…' });
      }
    }
    also.push({ id: 'discard', label: 'Abandon this change' });
    return finish();
  }

  const prLabel = `#${f.pr.number}`;

  if (f.pr.state === 'CLOSED') {
    stage = 'closed';
    describeTests();
    set('pr', 'failed', `${prLabel} was closed without merging.`);
    note = `Pull request ${prLabel} was closed on GitHub without being merged.`;
    next = { id: 'finish', label: 'Finish', enabled: true };
    return finish();
  }

  if (f.pr.state === 'OPEN') {
    stage = 'pr-open';
    describeTests();
    set('pr', 'done', prLabel);
    const unpushed = record.pushedTree !== f.treeId;
    also.push({ id: 'discard', label: 'Abandon this change' });
    if (unpushed) {
      set('pr', 'current', `${prLabel}, with newer edits here that are not in it yet.`);
      if (testsOk) {
        next = { id: 'update-pr', label: 'Update PR', enabled: true };
        if (verdict !== 'none') also.unshift({ id: 'tests', label: 'Run tests again' });
      } else {
        next = { id: 'tests', label: verdict === 'failed' ? 'Run tests again' : 'Run tests', enabled: true };
        if (verdict === 'failed') also.unshift({ id: 'ask-ai', label: 'Ask the AI to fix it' }, { id: 'override', label: 'Update PR anyway…' });
      }
      return finish();
    }
    const checks = f.checks || { state: 'unknown' };
    if (f.pr.mergeable === 'CONFLICTING') {
      set('ci', checks.state === 'pass' ? 'done' : 'todo');
      set('merge', 'failed', `Conflicts with ${f.defaultBranch}.`);
      note = `${prLabel} conflicts with ${f.defaultBranch}, so GitHub cannot merge it. Resolve the conflict on GitHub, or abandon this change and start again from the newest ${f.defaultBranch}.`;
      next = { id: 'merge', label: 'Merge', enabled: false, why: 'The pull request has conflicts.' };
      return finish();
    }
    if (checks.state === 'pending' || checks.state === 'unknown') {
      set('ci', 'current', checks.state === 'pending' ? `${checks.passing} of ${checks.total} checks done.` : 'Asking GitHub…');
      next = { id: 'merge', label: 'Merge', enabled: false, why: 'Waiting for the checks to finish.' };
    } else if (checks.state === 'fail') {
      set('ci', 'failed', `${checks.failing.length} failing: ${checks.failing.map((c) => c.name).join(', ')}`);
      note = 'A check failed on GitHub. Open its link to see why, fix it here (the AI can help), then update the PR.';
      next = { id: 'merge', label: 'Merge', enabled: false, why: 'Checks must pass before merging.' };
      also.unshift({ id: 'ask-ai-ci', label: 'Ask the AI about it' });
    } else {
      set('ci', 'done', checks.state === 'none' ? 'This repo has no checks.' : `All ${checks.total} checks passed.`);
      set('merge', 'current');
      next = { id: 'merge', label: 'Merge', enabled: true };
    }
    return finish();
  }

  // Merged
  set('tests', status.tests === 'skipped' ? 'skipped' : 'done', detail.tests);
  set('pr', 'done', prLabel);
  set('ci', 'done');
  set('merge', 'done', record.merge && record.merge.sha ? short(record.merge.sha) : '');
  stage = 'merged';
  if (!record.merge || !record.merge.sha) {
    note = 'The pull request is merged. GitHub has not yet said which commit that made. Roadie keeps asking; Check again asks now.';
    next = { id: 'refresh', label: 'Check again', enabled: true };
    also.push({ id: 'finish', label: 'Finish without releasing' });
    return finish();
  }
  const stagingLive = record.staging && record.staging.live;
  const productionLive = record.production && record.production.live;

  if (canStaging && !stagingLive && !record.release) {
    stage = 'staging';
    set('staging', 'current', record.staging && record.staging.seen ? `Staging is on ${record.staging.seen}.` : '');
    next = record.staging && record.staging.polling
      ? { id: 'staging-stop', label: 'Stop checking', enabled: true }
      : { id: 'staging', label: 'Check staging', enabled: true };
    also.push({ id: 'release', label: 'Skip to release…' }, { id: 'finish', label: 'Finish without releasing' });
    return finish();
  }
  if (canStaging) set('staging', stagingLive ? 'done' : 'skipped', stagingLive ? `Live: ${record.staging.seen || short(record.merge && record.merge.sha)}` : 'Not checked.');

  if (!record.release) {
    stage = 'release';
    set('release', 'current');
    next = { id: 'release', label: 'Release…', enabled: true };
    also.push({ id: 'finish', label: 'Finish without releasing' });
    return finish();
  }
  set('release', 'done', record.release.tag);

  if (canProduction && !productionLive) {
    stage = 'production';
    set('production', 'current', record.production && record.production.seen ? `Production is on ${record.production.seen}.` : '');
    next = record.production && record.production.polling
      ? { id: 'production-stop', label: 'Stop checking', enabled: true }
      : { id: 'production', label: 'Check production', enabled: true };
    also.push({ id: 'finish', label: 'Finish' });
    return finish();
  }
  if (canProduction) set('production', 'done', `Live: ${record.release.tag}`);

  stage = 'done';
  note = `${record.release.tag} is released${canProduction ? ' and live' : ''}.`;
  next = { id: 'finish', label: 'Finish', enabled: true };
  return finish();
}
