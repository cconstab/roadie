// The starter site: what Roadie puts into an empty repo so there is something
// to run, test, preview and deploy. The files live in templates/starter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caddyfile, cleanDomain } from './guide.js';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'starter');

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function starterValues({ owner, repo, title, domain }) {
  // The title ends up in code comments and strings, so keep it to plain text.
  const TITLE = (String(title || '').replace(/[\u0000-\u001f\u007f`$\\{}]/g, ' ').replace(/\*\//g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)) || repo;
  const SLUG = repo.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  const d = cleanDomain(domain);
  return {
    TITLE,
    TITLE_HTML: escapeHtml(TITLE),
    TITLE_JSON: JSON.stringify(TITLE),
    SLUG,
    OWNER: owner,
    REPO: repo,
    IMAGE: `ghcr.io/${owner}/${repo}`.toLowerCase(),
    STAGING_URL: d ? `https://staging.${d}` : 'your staging site',
    PRODUCTION_URL: d ? `https://${d}` : 'your production site',
    CADDYFILE: caddyfile(d),
  };
}

function templateFiles(dir = TEMPLATE_DIR, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? templateFiles(path.join(dir, entry.name), rel) : [rel];
  }).sort();
}

export function starterFileList() {
  return templateFiles();
}

// Only {{UPPER_CASE}} names Roadie knows are filled in. Docker and GitHub
// Actions use similar braces for their own purposes; those are left alone.
export function fill(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => (name in values ? values[name] : whole));
}

// Writes the starter into dir. Files that already exist are never overwritten.
export function writeStarter(dir, options) {
  const values = starterValues(options);
  const written = [];
  const skipped = [];
  for (const rel of templateFiles()) {
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) { skipped.push(rel); continue; }
    const source = path.join(TEMPLATE_DIR, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fill(fs.readFileSync(source, 'utf8'), values), { mode: fs.statSync(source).mode & 0o777 });
    written.push(rel);
  }
  return { written, skipped, values };
}

// Is there a site here yet? 'empty': nothing at all. 'bare': only the files
// GitHub offers when creating a repo (README, licence, .gitignore). null: a real site.
export function blankKind(files) {
  if (!files.length) return 'empty';
  const placeholder = /^(readme(\.[a-z]+)?|licen[cs]e(\.[a-z]+)?|\.gitignore|\.gitattributes|code_of_conduct\.md|contributing\.md|security\.md)$/i;
  return files.every((f) => placeholder.test(f)) ? 'bare' : null;
}
