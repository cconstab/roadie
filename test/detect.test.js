import assert from 'node:assert/strict';
import test from 'node:test';
import { detect } from '../src/detect.js';
import { tmpDir, writeFiles } from './helpers.js';

test('a Node site with start and test scripts and a documented pipeline', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, {
    'package.json': { scripts: { start: 'node server.js', test: 'node --test test/*.test.js' } },
    'server.js': 'const PORT = Number(process.env.PORT) || 8080;',
    'README.md': [
      '```sh', 'npm start            # http://localhost:8080', '```',
      'Merged PRs show up at https://staging.example.dev, releases at https://example.dev.',
      '`curl https://staging.example.dev/api/health` shows which build is live.',
    ].join('\n'),
  });
  const { settings, notes } = detect(dir);
  assert.deepEqual(settings, {
    start: 'npm start', test: 'npm test', install: '', port: 8080,
    stagingUrl: 'https://staging.example.dev', productionUrl: 'https://example.dev', healthPath: '/api/health',
  });
  assert.match(notes.start, /node server\.js/);
  assert.match(notes.port, /README/);
});

test('a folder of plain files has no commands, so it is served statically', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'index.html': '<h1>hi</h1>' });
  const { settings, notes } = detect(dir);
  assert.equal(settings.start, '');
  assert.equal(settings.test, '');
  assert.equal(settings.port, null);
  assert.match(notes.start, /static files/);
});

test("npm's placeholder test script does not count as a test command", (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'package.json': { scripts: { test: 'echo "Error: no test specified" && exit 1' } } });
  assert.equal(detect(dir).settings.test, '');
});

test('dependencies bring an install command that matches the lockfile', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, {
    'package.json': { scripts: { dev: 'vite --port 5173' }, devDependencies: { vite: '^7.0.0' } },
    'package-lock.json': '{}',
  });
  const { settings } = detect(dir);
  assert.equal(settings.start, 'npm run dev');
  assert.equal(settings.install, 'npm ci');
  assert.equal(settings.port, 5173);
});

test('the port falls back to the default in the server source', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, {
    'package.json': { main: 'app.js', scripts: { start: 'node app.js' }, homepage: 'https://example.org/' },
    'app.js': 'app.listen(process.env.PORT || 3000);',
  });
  const { settings } = detect(dir);
  assert.equal(settings.port, 3000);
  assert.equal(settings.productionUrl, 'https://example.org');
});

test('a broken package.json is reported, not thrown', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'package.json': '{ not json' });
  const { settings, notes } = detect(dir);
  assert.equal(settings.start, '');
  assert.match(notes.start, /could not be read/);
});
