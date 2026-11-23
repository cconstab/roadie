# Roadie

Edit a hand-coded website by chatting with an AI, watch a live preview, then walk
the change through GitHub to staging and production. Roadie runs on your own
machine, against your own site.

**Status: milestone 1 of 5.** Opening a site and the live preview work. Chat, diffs
and the change bar are still to come. See [PROGRESS.md](PROGRESS.md).

## Setup

You need:

- Node 24 or newer
- `git`, with your name and email set
- the GitHub command-line tool `gh`, signed in (`gh auth login`)

```sh
npm start     # runs Roadie at http://127.0.0.1:4747 and opens your browser
npm test      # runs the tests
```

Roadie checks git and gh when it starts and tells you plainly if something is
missing. It listens on `127.0.0.1` only.

## Add a site

1. Type the site's GitHub `owner/repo` in the box at the top and choose **Open site**.
   Roadie clones it into `~/roadie/sites/<owner>/<repo>`. If it is already there,
   Roadie fetches and fast-forwards the main branch, unless the clone has
   uncommitted changes or is on another branch, in which case it is left alone.
2. Roadie reads the README and `package.json` and shows what it worked out: start
   command, test command, port, staging and production URLs, health-check path.
   Correct anything that is wrong, then choose **Save and run**.

Settings are saved in `~/roadie/config.json`, never in the site's repo.

## The preview

Roadie runs the site's start command on a free port (passed as `PORT`, with
`HOST=127.0.0.1`) and shows it in the middle pane. A site with no start command
is served as static files.

The preview pane loads the site through a small local proxy, which changes three
things and nothing else:

- it removes `X-Frame-Options` and the `frame-ancestors` part of the
  Content-Security-Policy, so the site can be shown inside Roadie;
- it marks responses `no-cache`, so an edit shows up straight away;
- it adds one script tag to each page, which reloads the page when files change.

The site's own files and headers are never edited. **Open in new tab** goes
straight to the site, without the proxy.

Editing a file reloads the preview. Editing anything that might be server code
restarts the site first. Files covered by the site's `.gitignore` are ignored.

## Where things live

| Path | What |
|---|---|
| `~/roadie/sites/<owner>/<repo>` | the clones |
| `~/roadie/config.json` | per-site settings |

Set `ROADIE_HOME` to use a different folder, and `ROADIE_PORT` for a different port.
