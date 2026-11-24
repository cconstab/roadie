#!/usr/bin/env node
// Builds the downloads for a release: one self-contained archive per system.
//
//   node scripts/package.mjs                 every target
//   node scripts/package.mjs darwin-arm64    only the ones named
//
// Each archive holds Node with npm (from nodejs.org, checksum verified),
// Roadie's own files, and its dependencies for that system. Node and npm are
// there for Roadie and, when the person has none of their own, for their sites. Nothing is
// compiled or bundled: the files inside are the same ones as in this repo.
// Any one machine can build every target. Output goes to dist/.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NODE_MAJOR = 24;

// name: what the download is called. node: nodejs.org's name for the same system.
export const TARGETS = [
  { name: 'macos-arm64', os: 'darwin', cpu: 'arm64', node: 'darwin-arm64' },
  { name: 'macos-x64', os: 'darwin', cpu: 'x64', node: 'darwin-x64' },
  { name: 'linux-x64', os: 'linux', cpu: 'x64', node: 'linux-x64' },
  { name: 'linux-arm64', os: 'linux', cpu: 'arm64', node: 'linux-arm64' },
  { name: 'windows-x64', os: 'win32', cpu: 'x64', node: 'win-x64' },
  { name: 'windows-arm64', os: 'win32', cpu: 'arm64', node: 'win-arm64' },
];

// What goes into every archive, from the repo.
// (scripts: an installed Roadie updates itself with the installer it came with.)
const APP_FILES = ['src', 'public', 'templates', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'LICENSE'];

// Finds its own folder even when started through a link (as the installer sets up).
export const LAUNCHER_SH = `#!/bin/sh
# Starts Roadie with the Node runtime that came in this folder.
self="$0"
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
here=$(cd "$(dirname "$self")" && pwd)
# Sites get this Node and npm too, after any the person has installed themselves.
ROADIE_RUNTIME_BIN="$here/runtime/bin" exec "$here/runtime/bin/node" "$here/app/src/main.js" "$@"
`;

export const LAUNCHER_CMD = [
  '@echo off',
  'rem Starts Roadie with the Node runtime that came in this folder.',
  'rem Sites get this Node and npm too, after any the person has installed themselves.',
  'setlocal',
  'rem %~dp0 alone can give the current folder when this file is found through PATH and its name was typed in quotes.',
  'for %%I in ("%~f0") do set "ROADIE_DIR=%%~dpI"',
  'set "ROADIE_RUNTIME_BIN=%ROADIE_DIR%runtime"',
  '"%ROADIE_DIR%runtime\\node.exe" "%ROADIE_DIR%app\\src\\main.js" %*',
  '',
].join('\r\n');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// The newest release of the Node major Roadie needs, and nodejs.org's checksums for it.
async function nodeRelease() {
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const latest = index.find((r) => r.version.startsWith(`v${NODE_MAJOR}.`));
  if (!latest) throw new Error(`No Node ${NODE_MAJOR} release found on nodejs.org.`);
  const sums = await (await fetch(`https://nodejs.org/dist/${latest.version}/SHASUMS256.txt`)).text();
  const checksums = new Map(sums.trim().split('\n').map((line) => line.trim().split(/\s+/).reverse()));
  return { version: latest.version, checksums };
}

// Puts Node and npm for one target into runtimeDir, refusing a download whose checksum is wrong.
async function fetchNode(target, release, runtimeDir, cacheDir) {
  const windows = target.os === 'win32';
  const inside = `node-${release.version}-${target.node}`;
  const remote = `${inside}.${windows ? 'zip' : 'tar.gz'}`;
  const cached = path.join(cacheDir, remote);
  if (!fs.existsSync(cached)) await download(`https://nodejs.org/dist/${release.version}/${remote}`, cached);
  const want = release.checksums.get(remote);
  if (!want || sha256(cached) !== want) {
    fs.rmSync(cached, { force: true });
    throw new Error(`Checksum mismatch for ${remote}. Nothing was packaged from it.`);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  const parent = path.dirname(runtimeDir);
  if (windows) sh('unzip', ['-q', cached, '-d', parent]);
  else sh('tar', ['-xzf', cached, '-C', parent]);
  fs.renameSync(path.join(parent, inside), runtimeDir);
  // Headers, man pages and the changelog are not needed to run anything.
  for (const extra of ['include', 'share', 'CHANGELOG.md', 'README.md']) fs.rmSync(path.join(runtimeDir, extra), { recursive: true, force: true });
  const program = windows ? 'node.exe' : path.join('bin', 'node');
  if (!fs.existsSync(path.join(runtimeDir, program))) throw new Error(`${target.name}: no ${program} in the Node download.`);
}

async function build(target, release, version, cacheDir) {
  const folder = 'roadie';
  const stage = path.join(DIST, 'stage', target.name);
  const top = path.join(stage, folder);
  const app = path.join(top, 'app');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });

  for (const name of APP_FILES) fs.cpSync(path.join(ROOT, name), path.join(app, name), { recursive: true });
  // Dependencies for the target system, exactly as the lock file says, running no install scripts.
  sh('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${target.os}`, `--cpu=${target.cpu}`], { cwd: app, shell: process.platform === 'win32' });
  // npm cannot tell which C library a Linux target has; these archives are for the usual one (glibc).
  const scoped = path.join(app, 'node_modules', '@anthropic-ai');
  for (const name of fs.readdirSync(scoped)) if (name.endsWith('-musl')) fs.rmSync(path.join(scoped, name), { recursive: true });
  const expected = `claude-agent-sdk-${target.os}-${target.cpu}`;
  if (!fs.existsSync(path.join(scoped, expected))) throw new Error(`${target.name}: ${expected} was not installed, so the AI would not start.`);

  await fetchNode(target, release, path.join(top, 'runtime'), cacheDir);
  fs.writeFileSync(path.join(top, 'VERSION'), `roadie ${version}\nnode ${release.version}\n${target.name}\n`);

  let archive;
  if (target.os === 'win32') {
    fs.writeFileSync(path.join(top, 'roadie.cmd'), LAUNCHER_CMD);
    archive = path.join(DIST, `roadie-${target.name}.zip`);
    fs.rmSync(archive, { force: true });
    sh('zip', ['-qr', archive, folder], { cwd: stage });
  } else {
    fs.writeFileSync(path.join(top, 'roadie'), LAUNCHER_SH, { mode: 0o755 });
    archive = path.join(DIST, `roadie-${target.name}.tar.gz`);
    sh('tar', ['-czf', archive, '-C', stage, folder]);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return archive;
}

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !TARGETS.some((t) => t.name === w));
  if (unknown.length) throw new Error(`Unknown target: ${unknown.join(', ')}. Choose from: ${TARGETS.map((t) => t.name).join(', ')}`);
  const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS;
  // The release's tag when built for one; otherwise the version in package.json.
  const version = process.env.ROADIE_RELEASE || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const cacheDir = path.join(DIST, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const release = await nodeRelease();
  console.log(`Roadie ${version} with Node ${release.version}`);

  for (const target of targets) {
    const archive = await build(target, release, version, cacheDir);
    console.log(`  ${path.basename(archive)}  ${(fs.statSync(archive).size / 1e6).toFixed(0)} MB`);
  }
  fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
  // The installers go up with the archives, and everything is listed with its checksum.
  for (const name of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(DIST, name));
  const files = fs.readdirSync(DIST).filter((f) => /^roadie-.*\.(tar\.gz|zip)$/.test(f)).sort();
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), files.map((f) => `${sha256(path.join(DIST, f))}  ${f}\n`).join(''));
  console.log(`Done: ${DIST}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
