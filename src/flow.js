// Carries one change through the change bar: branch, tests, pull request, CI,
// merge, staging, release, production.
//
// Rules enforced here:
//   - Push, merge and release happen only through prepare() then confirm():
//     the interface shows the plan in between, and the plan is refused if the
//     files changed after it was shown.
//   - No pull request while tests fail, unless the person overrides for that
//     exact set of files.
//   - Anything that looks like a secret stops the commit.
//   - The default branch is never committed or pushed to (gitops refuses too),
//     except the one first commit of a repo that is empty on GitHub.
import { branchName, changeView, healthMatches, healthVersion, nextVersions, summarizeChecks, testsVerdict } from './change.js';
import { createConfirmations, scanForSecrets } from './guards.js';

const short = (sha) => String(sha || '').slice(0, 7);

function fail(message, data) {
  const err = new Error(message);
  if (data) err.data = data;
  return err;
}

// Added lines from unified diffs, for scanning before anything is staged.
export function additionsFromChanges(changes) {
  const out = [];
  for (const change of changes) {
    let inHunk = false;
    for (const line of (change.diff || '').split('\n')) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('+')) out.push({ path: change.path, line: line.slice(1) });
    }
  }
  return out;
}

function secretsMessage(findings) {
  return 'Roadie stopped because something here looks like a secret. Nothing was committed or sent.\n'
    + findings.map((f) => `- ${f.path}: ${f.why}`).join('\n')
    + '\nRemove it (or add the file to .gitignore), then try again.';
}

export function createFlow({
  gitops, config, getSite, runTests, emit = () => {}, draftPr, fetchImpl = fetch,
  pollMs = 15_000, healthTimeoutMs = 30 * 60_000, now = () => Date.now(),
}) {
  const confirmations = createConfirmations({ now });
  let remote = {};       // what GitHub last said: { pr, checks, remoteEmpty, error }
  let remoteFor = null;  // which site that was for
  let busy = null;       // short text while a step runs
  let ciTimer = null;
  const healthTimers = {};
  let testOutput = '';

  const site = () => {
    const s = getSite();
    if (!s) throw fail('Open a site first.');
    return s;
  };
  const record = () => config.getChange(site().key);
  const save = (r) => config.saveChange(site().key, r);

  function resetIfSiteChanged() {
    const s = getSite();
    const key = s && s.key;
    if (key !== remoteFor) {
      stopPolling();
      remote = {};
      remoteFor = key;
      testOutput = '';
    }
  }

  function stopPolling() {
    clearInterval(ciTimer);
    ciTimer = null;
    for (const which of Object.keys(healthTimers)) { clearInterval(healthTimers[which]); delete healthTimers[which]; }
  }

  async function facts() {
    resetIfSiteChanged();
    const s = site();
    const r = record();
    const branch = await gitops.currentBranch(s.dir);
    const hasCommits = await gitops.hasCommits(s.dir);
    if (remote.remoteEmpty === undefined) {
      // A local clone with commits means GitHub has them too, so only ask when there are none.
      remote.remoteEmpty = hasCommits ? false : await gitops.remoteIsEmpty(s.dir).catch(() => false);
    }
    const changes = await gitops.changes(s.dir, (r && r.base) || 'HEAD');
    return {
      site: s, record: r, branch, hasCommits, changes,
      defaultBranch: s.defaultBranch,
      remoteEmpty: remote.remoteEmpty && !hasCommits,
      filesChanged: changes.length,
      treeId: await gitops.treeId(s.dir),
      hasTestCommand: !!s.settings.test,
      pr: r && r.pr ? (remote.pr || { number: r.pr.number, url: r.pr.url, state: r.merge ? 'MERGED' : 'OPEN', mergeable: 'UNKNOWN' }) : null,
      checks: remote.checks ? summarizeChecks(remote.checks) : (r && r.pr && !r.merge ? { state: 'unknown' } : null),
      settings: s.settings,
    };
  }

  async function view() {
    if (!getSite()) return { open: false };
    const f = await facts();
    const v = changeView(f);
    const r = f.record;
    return {
      open: true,
      ...v,
      busy,
      branch: f.branch,
      defaultBranch: f.defaultBranch,
      filesChanged: f.filesChanged,
      description: r ? r.description : '',
      tests: r && r.tests ? { passed: r.tests.passed, at: r.tests.at, sandboxed: r.tests.sandboxed, current: r.tests.tree === f.treeId } : null,
      testOutput,
      pr: r && r.pr ? { number: r.pr.number, url: r.pr.url } : null,
      checks: (remote.checks || []).map((c) => ({ name: c.name, bucket: c.bucket, link: c.link })),
      merge: r && r.merge ? { sha: r.merge.sha } : null,
      release: r && r.release ? r.release : null,
      staging: r && r.staging ? r.staging : null,
      production: r && r.production ? r.production : null,
      links: {
        staging: f.settings.stagingUrl || null,
        production: f.settings.productionUrl || null,
      },
      remoteError: remote.error || null,
    };
  }

  let notifyTimer = null;
  // Tell the interface the change bar may have moved. Bursts are gathered up.
  function notify() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(async () => {
      try { emit(await view()); } catch { /* the next event will try again */ }
    }, 120);
  }

  async function step(text, fn) {
    if (busy) throw fail(`Roadie is still busy: ${busy}`);
    busy = text;
    notify();
    try { return await fn(); }
    finally { busy = null; notify(); }
  }

  async function refreshRemote() {
    const s = site();
    const r = record();
    if (!r || !r.pr) return;
    try {
      remote.pr = await gitops.prView(s.key, r.pr.number);
      remote.checks = remote.pr.state === 'OPEN' ? await gitops.prChecks(s.key, r.pr.number) : (remote.checks || []);
      remote.error = null;
      if (remote.pr.state === 'MERGED' && !r.merge) {
        // Merged on GitHub rather than from here: pick that up.
        save({ ...r, merge: { sha: remote.pr.mergeCommit && remote.pr.mergeCommit.oid, at: now() } });
      }
    } catch (err) {
      remote.error = err.message;
    }
  }

  function watchCi() {
    clearInterval(ciTimer);
    ciTimer = setInterval(async () => {
      if (!getSite()) return stopPolling();
      await refreshRemote();
      const r = record();
      const state = remote.checks ? summarizeChecks(remote.checks).state : 'unknown';
      if (!r || !r.pr || r.merge || (remote.pr && remote.pr.state !== 'OPEN') || (state !== 'pending' && state !== 'unknown')) {
        clearInterval(ciTimer);
        ciTimer = null;
      }
      notify();
    }, pollMs);
    ciTimer.unref?.();
  }

  // --- steps that stay on this machine ----------------------------------------

  async function start({ description } = {}) {
    return step('Starting the change…', async () => {
      const f = await facts();
      if (f.record) throw fail('A change is already in progress.');
      if (!f.hasCommits) throw fail('This repo has no commits yet. Make the first commit before starting a change.');
      let name = branchName(description, new Date(now()));
      const existing = await gitops.branchExists(f.site.dir, name);
      if (existing) name = `${name}-${new Date(now()).toISOString().slice(11, 16).replace(':', '')}`;
      await gitops.startBranch(f.site.dir, name, f.defaultBranch);
      const base = await gitops.remoteSha(f.site.dir, f.defaultBranch);
      save({ branch: name, description: String(description || '').trim().slice(0, 120), base, createdAt: now() });
      f.site.branch = name;
      return view();
    });
  }

  async function tests() {
    return step('Running the tests…', async () => {
      const s = site();
      testOutput = '';
      const result = await runTests({
        dir: s.dir, command: s.settings.test,
        onOutput: (chunk) => { testOutput = (testOutput + chunk).slice(-60_000); emit({ testChunk: chunk }); },
      });
      testOutput = result.output;
      const r = record();
      if (r) {
        save({
          ...r,
          override: null,
          tests: { passed: result.passed, code: result.code, tree: await gitops.treeId(s.dir), at: now(), sandboxed: result.sandboxed },
        });
      }
      return { passed: result.passed, code: result.code, output: result.output, sandboxed: result.sandboxed, timedOut: result.timedOut };
    });
  }

  // What to hand the AI when a step fails.
  async function aiRequest(kind) {
    const r = record();
    if (kind === 'ci') {
      const failing = (remote.checks || []).filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      return {
        text: 'A check failed on GitHub for this change. Work out the likely cause from the repo and fix it.',
        context: `Failing checks on pull request #${r && r.pr ? r.pr.number : '?'}:\n${failing.map((c) => `- ${c.name} (${c.link})`).join('\n')}\n\nYou cannot open those links. Read the workflow files in .github/workflows and the code to see what each check runs, run the tests with run_tests, and fix what you find.`,
      };
    }
    return {
      text: 'The tests are failing. Find out why and fix it, then run them again.',
      context: `Output of the last test run (${site().settings.test}):\n\n${testOutput.slice(-12_000)}`,
    };
  }

  // --- steps that leave the machine: prepare, then confirm ---------------------

  function commitPlanFiles(changes) {
    return changes.map((c) => ({ path: c.path, status: c.status }));
  }

  function checkSecrets(changes) {
    const findings = scanForSecrets({ files: changes.filter((c) => c.status !== 'deleted').map((c) => c.path), additions: additionsFromChanges(changes) });
    if (findings.length) throw fail(secretsMessage(findings), { findings });
  }

  async function prepare(action, input = {}) {
    const f = await facts();
    const s = f.site;
    const r = f.record;
    const fingerprint = { tree: f.treeId, branch: f.branch, head: await gitops.headSha(s.dir) };

    if (action === 'first-commit') {
      if (r) throw fail('A change is in progress.');
      if (f.hasCommits) throw fail('This repo already has commits.');
      if (!(await gitops.remoteIsEmpty(s.dir))) throw fail(`GitHub already has commits for ${s.key}. Open the site again to pick them up.`);
      if (!f.filesChanged) throw fail('There are no files to commit yet.');
      checkSecrets(f.changes);
      const message = String(input.message || 'First commit').trim().slice(0, 200) || 'First commit';
      return confirmations.prepare(action, {
        title: `Make the first commit to ${f.defaultBranch}`,
        summary: `${s.key} is empty on GitHub. This puts ${f.filesChanged} file${f.filesChanged === 1 ? '' : 's'} on ${f.defaultBranch} as its first commit. It is the only time Roadie pushes to ${f.defaultBranch}: every later change goes through a pull request.`,
        commands: ['git add -A', `git commit -m ${JSON.stringify(message)}`, `git push origin ${f.defaultBranch}`],
        files: commitPlanFiles(f.changes),
        message, fingerprint,
        sends: `${f.filesChanged} files to github.com/${s.key} (branch ${f.defaultBranch})`,
      });
    }

    if (!r) throw fail('Start a change first.');
    if (f.branch !== r.branch) throw fail(`The clone is on ${f.branch}, not this change's branch ${r.branch}. Switch back before continuing.`);
    if (f.branch === f.defaultBranch) throw fail(`Roadie never commits to ${f.defaultBranch} directly.`);

    if (action === 'pr' || action === 'update-pr') {
      if (action === 'pr' && r.pr) throw fail('This change already has a pull request.');
      if (action === 'update-pr' && !r.pr) throw fail('There is no pull request to update yet.');
      if (!f.filesChanged) throw fail('Nothing has changed yet.');
      const verdict = testsVerdict({ hasTestCommand: f.hasTestCommand, tests: r.tests, treeId: f.treeId });
      const override = verdict !== 'passed' && verdict !== 'none';
      if (override && input.override !== true) {
        throw fail(verdict === 'failed'
          ? 'The tests are failing, so Roadie will not send this. Fix them, or choose to go ahead anyway.'
          : 'Run the tests first: the files have changed since they last ran.');
      }
      checkSecrets(f.changes);
      const uncommitted = (await gitops.changes(s.dir, 'HEAD')).length;
      let title = String(input.title || '').trim();
      let body = String(input.body || '');
      let drafted = 'you';
      if (action === 'pr' && !title) {
        const draft = await draftPr({ site: s, description: r.description, changes: f.changes }).catch(() => null);
        if (draft && draft.title) { title = draft.title; body = draft.body || ''; drafted = 'ai'; }
        else {
          title = r.description || `Update ${f.changes[0].path}${f.changes.length > 1 ? ` and ${f.changes.length - 1} more` : ''}`;
          body = f.changes.map((c) => `- ${c.status} \`${c.path}\``).join('\n');
          drafted = 'fallback';
        }
      }
      if (action === 'update-pr' && !title) title = `Update: ${r.description || 'further changes'}`;
      const commands = [];
      if (uncommitted) commands.push('git add -A', 'git commit -m <the title below>');
      commands.push(`git push origin ${r.branch}`);
      if (action === 'pr') commands.push(`gh pr create --base ${f.defaultBranch} --head ${r.branch}`);
      return confirmations.prepare(action, {
        title: action === 'pr' ? 'Open a pull request' : `Update pull request #${r.pr.number}`,
        summary: action === 'pr'
          ? `Commits your changes to the branch ${r.branch}, pushes it to GitHub, and opens a pull request into ${f.defaultBranch}. Nothing is merged.`
          : `Commits your newer changes to ${r.branch} and pushes them. Pull request #${r.pr.number} picks them up and its checks run again.`,
        warning: override ? (verdict === 'failed' ? 'The tests are failing. You are choosing to send this anyway.' : 'The tests have not been run on these files. You are choosing to send this anyway.') : null,
        commands,
        files: commitPlanFiles(f.changes),
        editable: { title, body: action === 'pr' ? body : undefined },
        drafted,
        override,
        fingerprint,
        sends: `${f.changes.length} changed file${f.changes.length === 1 ? '' : 's'} to github.com/${s.key} (branch ${r.branch})`,
      });
    }

    if (action === 'merge') {
      if (!r.pr) throw fail('There is no pull request yet.');
      await refreshRemote();
      if (remote.error) throw fail(`Could not check the pull request on GitHub: ${remote.error}`);
      const pr = remote.pr;
      if (pr.state !== 'OPEN') throw fail(`Pull request #${pr.number} is ${pr.state.toLowerCase()}, so it cannot be merged.`);
      if (r.pushedTree !== f.treeId) throw fail('There are newer edits here that are not in the pull request. Update the PR first.');
      const checks = summarizeChecks(remote.checks);
      if (checks.state === 'pending') throw fail('The checks are still running. Wait for them to finish.');
      if (checks.state === 'fail') throw fail(`Checks are failing (${checks.failing.map((c) => c.name).join(', ')}), so Roadie will not merge.`);
      if (pr.mergeable === 'CONFLICTING') throw fail(`Pull request #${pr.number} conflicts with ${f.defaultBranch}.`);
      const info = await gitops.repoInfo(s.key);
      const allowed = { squash: info.squashMergeAllowed, merge: info.mergeCommitAllowed, rebase: info.rebaseMergeAllowed };
      const wanted = s.settings.mergeMethod || 'squash';
      const method = allowed[wanted] !== false ? wanted : Object.keys(allowed).find((m) => allowed[m]);
      if (!method) throw fail('This repo does not allow any merge method Roadie knows.');
      const flag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[method];
      return confirmations.prepare(action, {
        title: `Merge pull request #${pr.number}`,
        summary: `Merges "${pr.title}" into ${f.defaultBranch} on GitHub (${method}), and deletes the branch ${r.branch} there.`
          + (s.settings.stagingUrl ? ` On this site, a merge to ${f.defaultBranch} is what publishes to staging.` : ''),
        warning: checks.state === 'none' ? 'This repo has no checks, so nothing has tested this on GitHub.' : null,
        commands: [`gh pr merge ${pr.number} ${flag} --delete-branch --match-head-commit ${short(pr.headRefOid)}`],
        checks: { state: checks.state, total: checks.total },
        method, number: pr.number, sha: pr.headRefOid, fingerprint,
        sends: `a merge of #${pr.number} on github.com/${s.key}`,
      });
    }

    if (action === 'release') {
      if (!r.merge || !r.merge.sha) throw fail('Merge the pull request first.');
      if (r.release) throw fail(`This change was already released as ${r.release.tag}.`);
      await gitops.fetch(s.dir);
      const published = await gitops.releases(s.key);
      const tags = [...new Set([...published.map((x) => x.tagName), ...(await gitops.tags(s.dir))])];
      const versions = nextVersions(tags);
      const tag = String(input.tag || versions.suggested).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw fail(`"${tag}" is not a usable version. Use something like ${versions.suggested}.`);
      if (tags.includes(tag)) throw fail(`${tag} already exists. Pick a newer version.`);
      const previousTag = (published.find((x) => x.isLatest) || {}).tagName || versions.latest || undefined;
      let notes;
      let notesFrom = 'github';
      try {
        notes = (await gitops.releaseNotes(s.key, { tag, target: r.merge.sha, previousTag })).body;
      } catch {
        notesFrom = 'commits';
        notes = (await gitops.log(s.dir, previousTag ? `${previousTag}..${r.merge.sha}` : r.merge.sha)).map((l) => `- ${l}`).join('\n');
      }
      return confirmations.prepare(action, {
        title: `Publish release ${tag}`,
        summary: `Creates the tag ${tag} at the merged commit ${short(r.merge.sha)} and publishes a GitHub release.`
          + (s.settings.productionUrl ? ' On this site, publishing a release is what deploys to production.' : ''),
        warning: s.settings.productionUrl ? `This goes live at ${s.settings.productionUrl}.` : null,
        commands: [`gh release create ${tag} --target ${short(r.merge.sha)} --title ${tag} --notes <the notes below>`],
        versions, tag, previousTag: previousTag || null, target: r.merge.sha, notesFrom,
        editable: { notes },
        fingerprint,
        sends: `release ${tag} on github.com/${s.key}`,
      });
    }

    if (action === 'discard') {
      const uncommitted = (await gitops.changes(s.dir, 'HEAD')).length;
      return confirmations.prepare(action, {
        title: 'Abandon this change',
        summary: `Goes back to ${f.defaultBranch}.`
          + (uncommitted ? ` Your ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} are set aside in git's stash, not deleted: "git stash list" in the site folder shows them.` : '')
          + ` The branch ${r.branch} stays on this machine.`
          + (r.pr && !r.merge ? ` Pull request #${r.pr.number} stays open on GitHub; close it there if you no longer want it.` : ''),
        commands: [...(uncommitted ? [`git stash push --include-untracked -m "roadie: ${r.branch}"`] : []), `git switch ${f.defaultBranch}`],
        local: true,
        fingerprint,
      });
    }

    throw fail(`Unknown step: ${action}`);
  }

  async function confirm(token, action, edits = {}) {
    const plan = confirmations.take(token, action);
    return step(`${plan.title}…`, async () => {
      const f = await facts();
      const s = f.site;
      const head = await gitops.headSha(s.dir);
      if (plan.fingerprint.tree !== f.treeId || plan.fingerprint.branch !== f.branch || plan.fingerprint.head !== head) {
        throw fail('The files changed after you reviewed this step, so Roadie did not go ahead. Review it again.');
      }
      const r = f.record;

      // Stage, re-scan what is actually staged, and commit if there is anything to commit.
      const commitStaged = async (message, opts) => {
        await gitops.stageAll(s.dir);
        const files = await gitops.stagedFiles(s.dir);
        const findings = scanForSecrets({ files, additions: await gitops.stagedAdditions(s.dir) });
        if (findings.length) {
          await gitops.unstageAll(s.dir);
          throw fail(secretsMessage(findings), { findings });
        }
        if (files.length) await gitops.commit(s.dir, message, opts);
        return files.length;
      };

      if (action === 'first-commit') {
        await commitStaged(plan.message, { defaultBranch: f.defaultBranch, firstCommit: true });
        await gitops.push(s.dir, f.defaultBranch, { defaultBranch: f.defaultBranch, firstCommit: true });
        remote.remoteEmpty = false;
        return view();
      }

      if (action === 'pr' || action === 'update-pr') {
        const title = String(edits.title ?? plan.editable.title).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!title) throw fail('The pull request needs a title.');
        const body = String(edits.body ?? plan.editable.body ?? '');
        await commitStaged(title, { defaultBranch: f.defaultBranch });
        await gitops.push(s.dir, r.branch, { defaultBranch: f.defaultBranch });
        let pr = r.pr;
        if (action === 'pr') {
          const existing = await gitops.prForBranch(s.key, r.branch);
          pr = existing && existing.state === 'OPEN'
            ? { number: existing.number, url: existing.url }
            : await gitops.prCreate(s.key, { title, body, base: f.defaultBranch, head: r.branch });
        }
        save({
          ...r, pr,
          pushedTree: await gitops.treeId(s.dir),
          override: plan.override ? { tree: f.treeId, at: now() } : null,
        });
        remote.pr = null;
        remote.checks = null;
        await refreshRemote();
        watchCi();
        return view();
      }

      if (action === 'merge') {
        await gitops.prMerge(s.key, plan.number, { method: plan.method, sha: plan.sha, deleteBranch: true });
        await refreshRemote();
        const sha = remote.pr && remote.pr.mergeCommit ? remote.pr.mergeCommit.oid : null;
        save({ ...record(), merge: { sha, at: now() } });
        clearInterval(ciTimer);
        ciTimer = null;
        await gitops.fetch(s.dir).catch(() => {});
        return view();
      }

      if (action === 'release') {
        const tag = String(edits.tag || plan.tag).trim();
        if (tag !== plan.tag && ![plan.versions.patch, plan.versions.minor, plan.versions.major].includes(tag)) {
          throw fail('To use a different version, review the release again with that version.');
        }
        const notes = String(edits.notes ?? plan.editable.notes ?? '');
        const release = await gitops.releaseCreate(s.key, { tag, target: plan.target, title: tag, notes });
        save({ ...r, release: { tag: release.tag, url: release.url, at: now() } });
        return view();
      }

      if (action === 'discard') {
        await gitops.stashAll(s.dir, `roadie: ${r.branch}`);
        await gitops.switchTo(s.dir, f.defaultBranch);
        stopPolling();
        save(null);
        remote = { remoteEmpty: false };
        s.branch = f.defaultBranch;
        return view();
      }

      throw fail(`Unknown step: ${action}`);
    });
  }

  // --- watching the deployed sites ----------------------------------------------

  function health(which, { stop = false } = {}) {
    const s = site();
    const r = record();
    if (which !== 'staging' && which !== 'production') throw fail('Unknown site to check.');
    clearInterval(healthTimers[which]);
    delete healthTimers[which];
    if (stop) {
      if (r && r[which]) save({ ...r, [which]: { ...r[which], polling: false } });
      notify();
      return;
    }
    const base = which === 'staging' ? s.settings.stagingUrl : s.settings.productionUrl;
    if (!base || !s.settings.healthPath) throw fail(`Set the ${which} URL and health-check path in Site settings first.`);
    const needle = which === 'staging' ? short(r && r.merge && r.merge.sha) : r && r.release && r.release.tag;
    if (!needle) throw fail(which === 'staging' ? 'Merge the pull request first.' : 'Publish the release first.');
    const url = base + s.settings.healthPath;
    const started = now();
    const key = s.key;

    const check = async () => {
      const current = config.getChange(key);
      if (!current) { clearInterval(healthTimers[which]); delete healthTimers[which]; return; }
      let seen = null;
      let error = null;
      let live = false;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { 'Cache-Control': 'no-cache' } });
        const body = await res.text();
        if (!res.ok) error = `It answered ${res.status}.`;
        seen = healthVersion(body);
        live = res.ok && healthMatches(body, needle);
      } catch (err) {
        error = `No answer (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`;
      }
      const timedOut = !live && now() - started > healthTimeoutMs;
      if (live || timedOut) { clearInterval(healthTimers[which]); delete healthTimers[which]; }
      config.saveChange(key, {
        ...config.getChange(key),
        [which]: { url, waitingFor: needle, seen, error, live, polling: !live && !timedOut, timedOut, checkedAt: now() },
      });
      notify();
    };
    save({ ...r, [which]: { url, waitingFor: needle, polling: true, live: false } });
    healthTimers[which] = setInterval(check, pollMs);
    healthTimers[which].unref?.();
    check();
    notify();
  }

  async function finish() {
    return step('Finishing…', async () => {
      const f = await facts();
      const r = f.record;
      if (!r) return view();
      if ((await gitops.changes(f.site.dir, 'HEAD')).length) {
        throw fail('There are uncommitted edits here. Update the PR with them, or abandon the change, before finishing.');
      }
      stopPolling();
      await gitops.returnToDefault(f.site.dir, f.defaultBranch);
      if (r.merge) await gitops.deleteLocalBranch(f.site.dir, r.branch, f.defaultBranch);
      save(null);
      remote = { remoteEmpty: false };
      f.site.branch = f.defaultBranch;
      return view();
    });
  }

  async function refresh() {
    resetIfSiteChanged();
    await refreshRemote();
    const r = getSite() && record();
    if (r && r.pr && !r.merge) watchCi();
    return view();
  }

  // The commit the open change started from, so the diff pane can show all of it.
  function base() {
    const s = getSite();
    const r = s && config.getChange(s.key);
    return (r && r.base) || 'HEAD';
  }

  return { view, notify, start, tests, prepare, confirm, health, finish, refresh, aiRequest, base, stop: stopPolling };
}
