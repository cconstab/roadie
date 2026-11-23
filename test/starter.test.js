import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { detect } from '../src/detect.js';
import { createGitOps } from '../src/gitops.js';
import { caddyfile, cleanDomain, guideText, hostingGuide } from '../src/guide.js';
import { openSite, siteDir } from '../src/sites.js';
import { blankKind, fill, starterFileList, starterValues, writeStarter } from '../src/starter.js';
import { runTests } from '../src/tests.js';
import { fakeGitOps, tmpDir, writeFiles } from './helpers.js';

test('a repo with nothing, or only GitHub\'s placeholder files, counts as blank', () => {
  assert.equal(blankKind([]), 'empty');
  assert.equal(blankKind(['README.md']), 'bare');
  assert.equal(blankKind(['.gitignore', 'LICENSE', 'README.md']), 'bare');
  assert.equal(blankKind(['README.md', 'index.html']), null);
  assert.equal(blankKind(['package.json']), null);
  assert.equal(blankKind(['docs/README.md']), null);
});

test('only Roadie\'s own placeholders are filled in', () => {
  const values = { TITLE: 'My Site', IMAGE: 'ghcr.io/a/b' };
  assert.equal(fill('{{TITLE}} uses {{IMAGE}}', values), 'My Site uses ghcr.io/a/b');
  // Docker and GitHub Actions syntax must survive untouched.
  for (const keep of ["--format '{{.Manifest.Digest}}'", '${{ github.ref }}', "{{join .RepoDigests \" \"}}", '{{UNKNOWN_NAME}}']) {
    assert.equal(fill(keep, values), keep);
  }
});

test('titles and domains from the form cannot break the generated files', () => {
  const v = starterValues({ owner: 'Acme', repo: 'My.Site', title: 'Sam\'s `Site` ${process.exit()} */ <b>\n"x"', domain: ' https://WWW.Example.org/path?q ' });
  assert.equal(v.TITLE, 'Sam\'s Site process.exit() <b> "x"');
  assert.equal(v.TITLE_HTML, 'Sam&#39;s Site process.exit() &lt;b&gt; &quot;x&quot;');
  assert.equal(JSON.parse(v.TITLE_JSON), v.TITLE);
  assert.equal(v.SLUG, 'my-site');
  assert.equal(v.IMAGE, 'ghcr.io/acme/my.site');
  assert.equal(v.PRODUCTION_URL, 'https://example.org');
  assert.equal(v.STAGING_URL, 'https://staging.example.org');
  assert.equal(starterValues({ owner: 'a', repo: 'b', title: '', domain: '' }).TITLE, 'b');

  for (const bad of ['', 'localhost', 'not a domain', 'example.com; rm -rf /', 'a..b', '$(whoami).com', '-x.com']) {
    assert.equal(cleanDomain(bad), '', bad);
  }
  assert.equal(cleanDomain('Example.COM:8080/x'), 'example.com');
});

test('the starter is a working site: its tests pass and Roadie can read its settings', async (t) => {
  const dir = tmpDir(t);
  const result = writeStarter(dir, { owner: 'acme', repo: 'site', title: 'Acme & Sons', domain: 'acme.example' });
  assert.deepEqual(result.written, starterFileList());
  assert.deepEqual(result.skipped, []);
  for (const file of ['server.js', 'public/index.html', 'test/server.test.js', 'Dockerfile', 'compose.yaml', 'deploy/update.sh', '.github/workflows/test.yml', '.gitignore', '.env.example', 'README.md']) {
    assert.ok(result.written.includes(file), file);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.env')), 'no real settings file is created');
  assert.ok(fs.statSync(path.join(dir, 'deploy/update.sh')).mode & 0o100, 'the deploy script is executable');

  // Nothing of Roadie's is left behind, and the other tools' braces are intact.
  for (const file of result.written) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /\{\{[A-Z_]+\}\}/, file);
  }
  assert.match(fs.readFileSync(path.join(dir, 'deploy/update.sh'), 'utf8'), /\{\{\.Manifest\.Digest\}\}/);
  assert.match(fs.readFileSync(path.join(dir, '.github/workflows/test.yml'), 'utf8'), /\$\{\{ github\.ref \}\}/);
  assert.match(fs.readFileSync(path.join(dir, 'public/index.html'), 'utf8'), /<h1>Acme &amp; Sons<\/h1>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description, 'Acme & Sons');
  assert.match(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8'), /image: ghcr\.io\/acme\/site:\$\{IMAGE_TAG:-latest\}/);

  assert.deepEqual(detect(dir).settings, {
    start: 'npm start', test: 'npm test', install: '', port: 8080,
    stagingUrl: 'https://staging.acme.example', productionUrl: 'https://acme.example', healthPath: '/api/health',
  });

  const tests = await runTests({ dir, command: 'npm test' });
  assert.equal(tests.passed, true, tests.output);
});

test('the starter never overwrites a file that is already there', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'README.md': '# Mine\n', '.gitignore': 'secret-stuff/\n' });
  const result = writeStarter(dir, { owner: 'acme', repo: 'site', title: 'x', domain: '' });
  assert.deepEqual(result.skipped.sort(), ['.gitignore', 'README.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# Mine\n');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'secret-stuff/\n');
  assert.ok(fs.existsSync(path.join(dir, 'server.js')));
});

test('a real empty git repo opens without errors and is seen as empty', async (t) => {
  const home = tmpDir(t);
  const dir = siteDir(home, 'acme', 'site');
  const gitops = createGitOps();
  // Stand in for cloning an empty GitHub repo.
  gitops.clone = async (slug, target) => {
    fs.mkdirSync(target, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: target });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/site.git'], { cwd: target });
  };
  gitops.fetch = async () => {};
  const first = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(first.branch, 'main');
  assert.equal(await gitops.hasCommits(dir), false);
  assert.equal(blankKind(await gitops.listFiles(dir)), 'empty');

  const again = await openSite({ gitops, home, owner: 'acme', repo: 'site' });
  assert.equal(again.action, 'left');
  assert.match(again.note, /no commits yet/);

  writeStarter(dir, { owner: 'acme', repo: 'site', title: 'Site', domain: '' });
  const changes = await gitops.changes(dir);
  assert.ok(changes.length >= 15);
  assert.ok(changes.every((c) => c.status === 'added'));
  assert.ok(!changes.some((c) => c.path === '.env'));
});

test('the starter is offered for a blank repo through the API, and only then', async (t) => {
  const home = tmpDir(t);
  const gitops = fakeGitOps({ listFiles: [] });
  const app = await createApp({ home, gitops, config: createConfig(home) });
  const port = await app.listen(0);
  t.after(() => app.close());
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'X-Roadie-Token': app.token, Cookie: app.cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  const opened = await call('POST', '/api/open', { repo: 'acme/site' });
  assert.equal(opened.data.site.blank, 'empty');
  assert.ok(opened.data.starterFiles.includes('server.js'));

  const made = await call('POST', '/api/starter', { title: 'Acme', domain: 'acme.example' });
  assert.equal(made.status, 200);
  assert.equal(made.data.site.blank, null);
  assert.equal(made.data.site.settings.start, 'npm start');
  assert.equal(made.data.site.settings.stagingUrl, 'https://staging.acme.example');
  assert.ok(fs.existsSync(path.join(home, 'sites/acme/site/server.js')));

  const twice = await call('POST', '/api/starter', { title: 'Again' });
  assert.equal(twice.status, 400);
  assert.match(twice.data.error, /already has files/);

  // The guide for this site, with ticks remembered in Roadie's config.
  const guide = (await call('GET', '/api/guide')).data;
  assert.equal(guide.guide.domain, 'acme.example');
  assert.equal(guide.guide.deployFiles, true);
  assert.deepEqual(guide.done, []);
  await call('POST', '/api/guide/done', { id: 'dns', done: true });
  await call('POST', '/api/guide/done', { id: 'docker', done: true });
  assert.deepEqual((await call('POST', '/api/guide/done', { id: 'dns', done: false })).data.done, ['docker']);
  assert.deepEqual((await call('GET', '/api/guide')).data.done, ['docker']);
});

test('the hosting guide is filled in for the site and uses the official install commands', (t) => {
  const dir = tmpDir(t);
  writeStarter(dir, { owner: 'Acme', repo: 'Site', title: 'x', domain: 'acme.example' });
  const guide = hostingGuide({ owner: 'Acme', repo: 'Site', dir, settings: detect(dir).settings });
  assert.equal(guide.hasDomain, true);
  assert.deepEqual(guide.steps.map((s) => s.id), ['server', 'dns', 'firewall', 'docker', 'docker-user', 'caddy', 'caddyfile', 'checkout', 'registry', 'first-deploy', 'cron', 'verify']);
  assert.deepEqual(guide.steps.map((s) => s.number), guide.steps.map((_, i) => i + 1));

  const all = guideText(guide);
  for (const expected of [
    'A   staging.acme.example   your-server-ip',
    'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
    'URIs: https://download.docker.com/linux/debian',
    'sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'sudo usermod -aG docker $USER',
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    'sudo systemctl reload caddy',
    'git clone https://github.com/Acme/Site.git',
    'echo $CR_PAT | docker login ghcr.io -u Acme --password-stdin',
    'ghcr.io/acme/site',
    'curl https://staging.acme.example/api/health',
  ]) assert.ok(all.includes(expected), expected);
  assert.match(all, /root-level power/, 'the docker group warning is passed on');
  assert.match(all, /Do not paste it into the chat/);
  assert.doesNotMatch(all, /get\.docker\.com/, "Docker's convenience script is not for production servers");

  assert.match(caddyfile('acme.example'), /^acme\.example \{\n  encode zstd gzip\n  reverse_proxy 127\.0\.0\.1:8080\n\}/);
  assert.match(caddyfile('acme.example'), /staging\.acme\.example \{[^}]*X-Robots-Tag[^}]*127\.0\.0\.1:8081/);
});

test('without a domain or deploy files the guide says so instead of guessing', (t) => {
  const dir = tmpDir(t);
  writeFiles(dir, { 'index.html': 'x' });
  const guide = hostingGuide({ owner: 'acme', repo: 'site', dir, settings: {} });
  assert.equal(guide.hasDomain, false);
  assert.equal(guide.deployFiles, false);
  assert.ok(guide.steps.some((s) => s.id === 'deploy-files'));
  assert.ok(!guide.steps.some((s) => s.id === 'cron'));
  assert.match(guide.steps.find((s) => s.id === 'dns').text, /Replace example\.com with your own domain/);
});
