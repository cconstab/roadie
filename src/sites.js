// Getting a site onto disk: clone it, or bring an existing clone up to date.
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z0-9_.-]+$/;

// Accepts "owner/repo" or a pasted GitHub URL.
export function parseRepo(input) {
  let text = String(input || '').trim();
  text = text
    .replace(/^git@github\.com:/i, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = text.split('/');
  if (parts.length !== 2) throw new Error('Enter the site as owner/repo, the way it appears in its GitHub address.');
  const [owner, repo] = parts;
  const bad = (s) => !NAME.test(s) || s === '.' || s === '..';
  if (bad(owner) || bad(repo)) throw new Error('That does not look like a GitHub owner/repo.');
  return { owner, repo, key: `${owner}/${repo}` };
}

export function siteDir(home, owner, repo) {
  return path.join(home, 'sites', owner, repo);
}

export function sameRepo(originUrl, owner, repo) {
  const m = String(originUrl).trim().replace(/\.git$/i, '').match(/github\.com[:/]+([^/]+)\/([^/]+)$/i);
  return !!m && m[1].toLowerCase() === owner.toLowerCase() && m[2].toLowerCase() === repo.toLowerCase();
}

// Clone the repo, or fast-forward main if the clone is already there.
// Local work is never touched: a clone on another branch or with uncommitted
// changes is left exactly as it is.
export async function openSite({ gitops, home, owner, repo }) {
  const dir = siteDir(home, owner, repo);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await gitops.clone(`${owner}/${repo}`, dir);
    const branch = await gitops.currentBranch(dir);
    return { dir, action: 'cloned', branch, defaultBranch: await gitops.defaultBranch(dir), note: `Cloned into ${dir}.` };
  }

  if (!(await gitops.isRepo(dir))) {
    throw new Error(`${dir} already exists but is not a git clone. Move it out of the way and try again.`);
  }
  const origin = await gitops.originUrl(dir);
  if (!sameRepo(origin, owner, repo)) {
    throw new Error(`${dir} is a clone of something else (${origin}). Move it out of the way and try again.`);
  }

  await gitops.fetch(dir);
  const defaultBranch = await gitops.defaultBranch(dir);
  const branch = await gitops.currentBranch(dir);
  if (!(await gitops.hasCommits(dir))) {
    return { dir, action: 'left', branch, defaultBranch, note: 'This repo has no commits yet.' };
  }
  if (branch !== defaultBranch) {
    return { dir, action: 'left', branch, defaultBranch, note: `The clone is on branch ${branch}, so ${defaultBranch} was not pulled.` };
  }
  if (!(await gitops.isClean(dir))) {
    return { dir, action: 'left', branch, defaultBranch, note: `${defaultBranch} has uncommitted changes, so it was not pulled.` };
  }
  await gitops.pullFastForward(dir, defaultBranch);
  return { dir, action: 'pulled', branch, defaultBranch, note: `Already cloned. ${defaultBranch} is up to date with GitHub.` };
}
