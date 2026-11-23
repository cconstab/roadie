// Works out how to run and test a site from its package.json and README.
// Every guess comes with a note saying where it came from, so it can be checked.
import fs from 'node:fs';
import path from 'node:path';

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function findReadme(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const name = names.find((n) => /^readme(\.(md|markdown|txt))?$/i.test(n));
  return name ? readText(path.join(dir, name)) : '';
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;
const URL_END = /[^\s)`'"<>\]]+/.source;

export function detect(dir) {
  const notes = {};
  const out = { start: '', test: '', install: '', port: null, stagingUrl: '', productionUrl: '', healthPath: '' };

  let pkg = null;
  const pkgText = readText(path.join(dir, 'package.json'));
  if (pkgText) {
    try { pkg = JSON.parse(pkgText); } catch { notes.start = 'package.json could not be read as JSON.'; }
  }
  const readme = findReadme(dir);
  const scripts = (pkg && pkg.scripts) || {};
  const has = (name) => fs.existsSync(path.join(dir, name));

  // Start command
  if (scripts.start) {
    out.start = 'npm start';
    notes.start = `package.json "start" script: ${scripts.start}`;
  } else if (scripts.dev) {
    out.start = 'npm run dev';
    notes.start = `package.json "dev" script: ${scripts.dev}`;
  } else if (pkg && has('server.js')) {
    out.start = 'node server.js';
    notes.start = 'No start script, but there is a server.js.';
  } else {
    notes.start = notes.start || 'No start command found. Roadie will serve the folder as static files.';
  }

  // Test command
  if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
    out.test = 'npm test';
    notes.test = `package.json "test" script: ${scripts.test}`;
  } else {
    notes.test = 'No test command found.';
  }

  // Install command, only when the site has dependencies
  const depCount = pkg ? Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length : 0;
  if (depCount > 0) {
    if (has('pnpm-lock.yaml')) out.install = 'pnpm install --frozen-lockfile';
    else if (has('yarn.lock')) out.install = 'yarn install --frozen-lockfile';
    else if (has('package-lock.json')) out.install = 'npm ci';
    else out.install = 'npm install';
    notes.install = `${depCount} dependencies in package.json. Runs once, when node_modules is missing.`;
  } else {
    notes.install = pkg ? 'No dependencies, so nothing to install.' : 'No package.json.';
  }

  // Port: a flag in the start script, then the README, then the server source
  const startScript = scripts.start || scripts.dev || '';
  const flag = startScript.match(/(?:--port[ =]|-p )(\d{2,5})/);
  const fromReadme = readme.match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/);
  const mainFile = (pkg && typeof pkg.main === 'string' && pkg.main) || (has('server.js') ? 'server.js' : '');
  const fromSource = mainFile ? readText(path.join(dir, mainFile)).match(/process\.env\.PORT[^\n]{0,24}?(\d{4,5})/) : null;
  if (flag) { out.port = Number(flag[1]); notes.port = 'From the port flag in the start script.'; }
  else if (fromReadme) { out.port = Number(fromReadme[1]); notes.port = `The README mentions ${fromReadme[0]}.`; }
  else if (fromSource) { out.port = Number(fromSource[1]); notes.port = `Default port in ${mainFile}.`; }
  else notes.port = 'No port found. Roadie picks a free one and passes it as PORT.';

  // Staging and production URLs, and the health-check path
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  const staging = (readme.match(new RegExp(`https://${URL_END}`, 'g')) || [])
    .map((u) => u.replace(/[.,;:!?]+$/, '')) // sentence punctuation is not part of the URL
    .find((u) => /\bstaging\b/i.test(hostOf(u)));
  if (staging) {
    out.stagingUrl = new URL(staging).origin;
    notes.stagingUrl = 'Found in the README.';
    const guess = out.stagingUrl.replace(/\/\/staging[.-]/i, '//');
    if (guess !== out.stagingUrl && readme.includes(guess)) {
      out.productionUrl = guess;
      notes.productionUrl = 'The staging URL without "staging", which the README also mentions.';
    }
  }
  if (!out.productionUrl && pkg && typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)) {
    out.productionUrl = pkg.homepage.replace(/\/+$/, '');
    notes.productionUrl = 'package.json "homepage".';
  }
  const health = readme.match(/\/[A-Za-z0-9_\-/]*health[a-z]*/i);
  if (health) { out.healthPath = health[0]; notes.healthPath = 'Found in the README.'; }

  return { settings: out, notes };
}
