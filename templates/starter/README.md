# {{TITLE}}

A hand-coded website with a small Node server. No framework, no build step and
no npm dependencies.

## Run it

```sh
npm start            # http://localhost:8080
npm test             # tests (node:test)
```

Needs Node 22 or newer.

## Layout

```
public/                 everything visitors can load: pages, css, images
server.js               serves public/ and /api/health, with security headers
test/server.test.js     tests
Dockerfile compose.yaml the container the site runs in
deploy/                 the script the server uses to update itself
.github/workflows/      tests, and publishing the container image
```

Only files inside `public/` are ever served.

## Configuration

| env | default | what |
|---|---|---|
| `PORT` | `8080` | port |
| `HOST` | `127.0.0.1` | bind address (the Docker image uses `0.0.0.0`) |
| `APP_VERSION` | `dev` | which build this is; set by CI |

## How changes go live

Nobody deploys by hand. CI publishes container images, and the server pulls them.

| what happens | image tag | where it shows up |
|---|---|---|
| a pull request is merged to `main` and tests pass | `:staging` | {{STAGING_URL}}, within about 10 minutes |
| a GitHub release is published | `:latest` and `:<release tag>` | {{PRODUCTION_URL}}, within about 10 minutes |

So the routine is: merge pull requests, look at staging, and when it is good,
publish a release.

`/api/health` shows which build is live: `"version":"main-<commit>"` on staging,
the release tag on production.

The image is `{{IMAGE}}`. The publishing is the `publish` job in
`.github/workflows/test.yml`. The server side is `deploy/update.sh`, run every 10
minutes from cron: it compares what the registry has with what is running, and
only pulls and restarts when they differ.

## Setting up the server

One Linux server runs both production (port 8080) and staging (port 8081) as
containers, with Caddy in front for HTTPS:

```
{{CADDYFILE}}
```

Then, on the server, as your own user (who must be able to run `docker`):

```sh
git clone https://github.com/{{OWNER}}/{{REPO}}.git && cd {{REPO}}
cp .env.example .env
cp .env.staging.example .env.staging
deploy/update.sh                 # first run by hand, to see it work
crontab -e                       # then add the line from deploy/crontab.example
```

Roadie's hosting guide walks through all of this step by step, including
installing Docker and Caddy.

- **Roll back or hold production still:** set `IMAGE_TAG=v1.1.0` in `.env` and run
  `deploy/update.sh`. Set it back to `latest` to follow releases again.
- **Pause auto-deploy:** comment the line out with `crontab -e`.
- **Changes to `compose.yaml` or `deploy/`** are not picked up automatically; run
  `git pull` on the server for those.
