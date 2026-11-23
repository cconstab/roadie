# Roadie

Edit a hand-coded website by chatting with an AI, watch a live preview, then walk
the change through GitHub to staging and production. Roadie runs on your own
machine, against your own site.

**Status: milestone 2 of 5.** Opening a site, the live preview, chatting with the AI
and the list of changes work. The change bar (branch, tests, pull request, merge,
release) is still to come. See [PROGRESS.md](PROGRESS.md).

## Setup

You need:

- Node 24 or newer
- `git`, with your name and email set
- the GitHub command-line tool `gh`, signed in (`gh auth login`)
- an AI to do the editing: an Anthropic API key, or [Ollama](https://ollama.com) with a local model

```sh
npm install                          # the Claude Agent SDK and zod, nothing else
export ANTHROPIC_API_KEY=sk-ant-...  # skip this if you will use Ollama
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

## Chatting with the AI

Type what you want changed in the left pane. You see what the AI is doing as it
works (files it reads and edits, test runs), the preview reloads as files change,
and the right pane lists every changed file with its diff against the last commit.
**Stop** interrupts it. **New chat** starts a fresh conversation.

Choose the AI with the button next to the Chat heading:

- **Claude, with an Anthropic API key.** Roadie reads `ANTHROPIC_API_KEY` from the
  environment it was started in and never stores it. (Amazon Bedrock, Google Vertex
  and Microsoft Foundry work too, through the environment variables the Claude Agent
  SDK documents.) You pay Anthropic for what you use.
- **A local model, with Ollama.** Give the address of your Ollama server and pick a
  model. Choose one that supports tools, and give it a context window of 64k or more.
  Small local models are much weaker at careful edits than Claude.

### What the AI can and cannot do

The limits are enforced by Roadie, not left to the AI's judgement:

- It can read, create and edit files **inside the open site's folder only**.
- It cannot touch `.git`, or files that look like secrets (`.env`, key files).
- It can list and search the site's files, and run the site's test command.
- It has no shell, no git, no `gh` and no web access, so it can never push, open
  a pull request, merge or release. Only your clicks do that.
- It does not load Claude settings, instructions or plugins from your machine.

It is told to treat the repo as the source of truth, read the README and tests
first, follow the existing style, add no frameworks or dependencies, keep the
security policy intact, change only what the task needs, leave CI, Docker and
deploy files alone unless asked, and update tests for what it changes.

### How tests are run

Test files are code the AI may have edited, so on macOS the test command runs in
a sandbox: it can reach servers on your own machine but nothing beyond it, and it
cannot write to the site's `.git` folder. On other systems tests run without that
sandbox for now. Either way they get no AI key and no GitHub token.

## Where things live

| Path | What |
|---|---|
| `~/roadie/sites/<owner>/<repo>` | the clones |
| `~/roadie/config.json` | per-site settings |

Set `ROADIE_HOME` to use a different folder, and `ROADIE_PORT` for a different port.
