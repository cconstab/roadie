// The hosting guide: how to put a site on a server of your own, step by step.
// Roadie never connects to the server. The person runs these commands
// themselves; the guide (and the AI, when asked) talks them through it.
//
// Install commands are the ones in the official Docker, Caddy and GitHub docs
// (checked November 2026). They are for Ubuntu or Debian.
import fs from 'node:fs';
import path from 'node:path';

export function cleanDomain(input) {
  const host = String(input || '').trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? host : '';
}

export function caddyfile(domain) {
  const d = domain || 'example.com';
  return [
    `${d} {`,
    '  encode zstd gzip',
    '  reverse_proxy 127.0.0.1:8080',
    '}',
    '',
    `www.${d} {`,
    `  redir https://${d}{uri} permanent`,
    '}',
    '',
    '# staging: the tip of main, kept out of search engines',
    `staging.${d} {`,
    '  encode zstd gzip',
    '  header X-Robots-Tag "noindex, nofollow"',
    '  reverse_proxy 127.0.0.1:8081',
    '}',
  ].join('\n');
}

const dockerRepo = (distro, suites) => [
  "# Add Docker's official GPG key:",
  'sudo apt update',
  'sudo apt install ca-certificates curl',
  'sudo install -m 0755 -d /etc/apt/keyrings',
  `sudo curl -fsSL https://download.docker.com/linux/${distro}/gpg -o /etc/apt/keyrings/docker.asc`,
  'sudo chmod a+r /etc/apt/keyrings/docker.asc',
  '',
  '# Add the repository to Apt sources:',
  'sudo tee /etc/apt/sources.list.d/docker.sources <<EOF',
  'Types: deb',
  `URIs: https://download.docker.com/linux/${distro}`,
  `Suites: $(. /etc/os-release && echo "${suites}")`,
  'Components: stable',
  'Architectures: $(dpkg --print-architecture)',
  'Signed-By: /etc/apt/keyrings/docker.asc',
  'EOF',
  '',
  'sudo apt update',
  'sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
].join('\n');

const CADDY_INSTALL = [
  'sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl',
  "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
  "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list",
  'sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
  'sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list',
  'sudo apt update',
  'sudo apt install caddy',
].join('\n');

// site: { owner, repo, dir, settings }
export function hostingGuide(site) {
  const { owner, repo, dir, settings = {} } = site;
  const domain = cleanDomain(settings.productionUrl) || cleanDomain(settings.stagingUrl).replace(/^staging\./, '');
  const d = domain || 'example.com';
  const health = settings.healthPath || '/api/health';
  const image = `ghcr.io/${owner}/${repo}`.toLowerCase();
  const has = (name) => fs.existsSync(path.join(dir, name));
  const deployFiles = has('compose.yaml') && has(path.join('deploy', 'update.sh'));
  const SERVER = 'on the server';

  const steps = [
    {
      id: 'server',
      title: 'Get a server',
      text: 'You need one Linux server with a public IP address, running Ubuntu or Debian. The smallest size most providers sell is enough. You also need a domain name, and to be able to log in to the server over SSH as a normal user who can use sudo. Every command marked "on the server" below is run there, as that user.',
      commands: [{ where: 'on your computer', code: 'ssh you@your-server-ip' }],
      check: 'You are logged in and "sudo true" works without an error.',
    },
    {
      id: 'dns',
      title: 'Point your domain at the server',
      text: `At the company where you manage your domain, add these DNS records. Use the server's public IP address. If the server also has an IPv6 address, add matching AAAA records.${domain ? '' : ' Replace example.com with your own domain throughout this guide (set the Production URL in Site settings and Roadie will fill it in).'}`,
      commands: [
        { where: 'at your DNS provider', code: `A   ${d}           your-server-ip\nA   www.${d}       your-server-ip\nA   staging.${d}   your-server-ip` },
        { where: 'on your computer', label: 'Check, after a few minutes', code: `dig +short ${d} staging.${d}` },
      ],
      check: "Both names answer with the server's IP address. DNS changes can take a while to spread.",
    },
    {
      id: 'firewall',
      title: 'Open the web ports',
      text: 'Visitors reach the site on ports 80 and 443, and you need 22 for SSH. If the server uses the ufw firewall, run this. Many providers also have a firewall in their control panel: allow the same three ports there.',
      commands: [{ where: SERVER, code: 'sudo ufw allow OpenSSH\nsudo ufw allow 80,443/tcp\nsudo ufw enable\nsudo ufw status' }],
      check: 'The status lists OpenSSH and 80,443/tcp as allowed. Allow OpenSSH before enabling, or you will lock yourself out.',
    },
    {
      id: 'docker',
      title: 'Install Docker',
      text: 'The site runs in a container, so the server needs Docker. These are the commands from Docker\'s own install guide. Use the block that matches your server.',
      commands: [
        { where: SERVER, label: 'Ubuntu', code: dockerRepo('ubuntu', '${UBUNTU_CODENAME:-$VERSION_CODENAME}') },
        { where: SERVER, label: 'Debian', code: dockerRepo('debian', '$VERSION_CODENAME') },
        { where: SERVER, label: 'Check', code: 'sudo docker run hello-world' },
      ],
      check: 'The last command prints "Hello from Docker!".',
    },
    {
      id: 'docker-user',
      title: 'Let your user run Docker',
      text: 'The deploy script runs as you, not as root, so your user must be allowed to use Docker. Be aware of what this means: Docker\'s docs warn that membership of the docker group gives that user root-level power over the server. Run this as your normal user, then log out and back in.',
      commands: [{ where: SERVER, code: 'sudo usermod -aG docker $USER\n# log out, log back in, then:\ndocker run hello-world' }],
      check: 'The same "Hello from Docker!" appears, this time without sudo.',
    },
    {
      id: 'caddy',
      title: 'Install the web server (Caddy)',
      text: 'Caddy sits in front of the site. It answers on your domain, gets and renews the HTTPS certificates by itself, and passes requests to the container. These are the commands from Caddy\'s install guide.',
      commands: [
        { where: SERVER, code: CADDY_INSTALL },
        { where: SERVER, label: 'Check', code: 'systemctl status caddy' },
      ],
      check: 'The status says "active (running)".',
    },
    {
      id: 'caddyfile',
      title: 'Tell Caddy about your site',
      text: 'Replace the contents of /etc/caddy/Caddyfile with the block below, then reload Caddy. Production listens on port 8080 and staging on 8081, both reachable only from the server itself. Certificates are issued once the DNS records from step 2 point here and ports 80 and 443 are open.',
      commands: [
        { where: SERVER, label: 'Open the file', code: 'sudo nano /etc/caddy/Caddyfile' },
        { where: 'in /etc/caddy/Caddyfile', code: caddyfile(domain) },
        { where: SERVER, label: 'Apply it', code: 'sudo systemctl reload caddy' },
      ],
      check: 'The reload prints nothing. Use reload, not restart, so the site never goes down for a config change.',
    },
  ];

  if (deployFiles) {
    steps.push(
      {
        id: 'checkout',
        title: 'Put the site\'s deploy files on the server',
        text: `Clone the repo into your home folder and create the two settings files. The defaults in them are right for this setup. If the repo is private, the server needs its own way to read it: the simplest is to install gh on the server and run "gh auth login", then clone with "gh repo clone ${owner}/${repo}".`,
        commands: [{ where: SERVER, code: `cd ~\ngit clone https://github.com/${owner}/${repo}.git\ncd ${repo}\ncp .env.example .env\ncp .env.staging.example .env.staging` }],
        check: `"ls -a ~/${repo}" shows .env and .env.staging.`,
      },
      {
        id: 'registry',
        title: 'Let the server download the site\'s image',
        text: `Each merge to main makes GitHub build a container image, ${image}. It exists only after the first merge has passed CI, and GitHub makes it private by default. Either make it public (on GitHub: your profile, Packages, the package, Package settings, Change visibility), after which the server needs no login. Or keep it private and log the server in with a token: on GitHub create a personal access token (classic) with only the read:packages scope. Type the token on the server only. Do not paste it into the chat or anywhere in Roadie.`,
        commands: [{ where: SERVER, label: 'Only if the image stays private', code: `export CR_PAT=your-token\necho $CR_PAT | docker login ghcr.io -u ${owner} --password-stdin` }],
        check: 'A public image needs nothing. A private one prints "Login Succeeded".',
      },
      {
        id: 'first-deploy',
        title: 'Deploy for the first time',
        text: 'Run the update script by hand once, to watch it work. It downloads the images and starts the containers. Production is skipped with a "could not read the digest" message until you have published your first release; that is expected.',
        commands: [{ where: SERVER, code: `cd ~/${repo}\ndeploy/update.sh` }],
        check: 'It prints "staging: deployed ... healthy".',
      },
      {
        id: 'cron',
        title: 'Turn on automatic deploys',
        text: 'Have the server run the update script every 10 minutes. Open your crontab and paste the line from deploy/crontab.example. From then on, a merge reaches staging and a release reaches production without anyone logging in to the server.',
        commands: [
          { where: SERVER, code: `cat ~/${repo}/deploy/crontab.example\ncrontab -e` },
          { where: SERVER, label: 'Watch deploys happen', code: `journalctl -t ${repo.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-update -f` },
        ],
        check: '"crontab -l" shows the line.',
      },
    );
  } else {
    steps.push({
      id: 'deploy-files',
      title: 'Add deploy files to the site',
      text: 'This site has no compose.yaml and deploy/update.sh, so Roadie cannot give exact commands for the remaining steps: getting the site onto the server and keeping it up to date. Ask the AI to add a Dockerfile, a compose.yaml and a deploy script that match how this site runs, or to explain how the site is meant to be deployed if its README already says.',
      commands: [],
      check: 'The repo has a documented way to run on a server.',
    });
  }

  steps.push({
    id: 'verify',
    title: 'Check that it is live',
    text: `Ask the staging site which build it is running. After a merge it reports the commit that was merged; after a release, production reports the release tag. Roadie's Staging and Production steps do this check for you.`,
    commands: [{ where: 'on your computer', code: `curl https://staging.${d}${health}\ncurl https://${d}${health}` }],
    check: 'Each answers with JSON that includes a version.',
  });

  return { domain, hasDomain: !!domain, deployFiles, steps: steps.map((s, i) => ({ number: i + 1, ...s })) };
}

// The guide as plain text, for handing to the AI as background.
export function guideText(guide) {
  return guide.steps.map((s) => [
    `Step ${s.number}: ${s.title}`,
    s.text,
    ...s.commands.map((c) => `[${c.label ? c.label + ', ' : ''}${c.where}]\n${c.code}`),
    `Done when: ${s.check}`,
  ].join('\n')).join('\n\n');
}
