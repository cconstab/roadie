# Roadie progress

Task tracking for this project lives in this file.

## Decisions

- Roadie is for anyone to run against their own site. Nothing is tied to one repo; the pipeline steps a site does not have (staging, production) are optional.
- Node 24 or newer. Plain HTML, CSS and JavaScript interface, no build step.
- AI sign-in: `ANTHROPIC_API_KEY` from the environment, or a local Ollama endpoint. Roadie stores neither.
- GitHub traffic goes over HTTPS and signs in through `gh` (`gh auth git-credential`, per command). Roadie stores no tokens, changes no git config, and does not depend on the user's SSH setup.
- Commit Roadie's own code at each milestone. No pushes unless asked.
- While building: never push, open PRs, merge or release on `cconstab/3Chords.dev`. Those steps are tested with git and gh faked, or against a throwaway repo.

## Milestones

- [x] 1. Open a site: clone, detect commands, run it, live preview through the proxy
- [x] 2. Chat: the AI edits files in the site, preview reloads, diffs show
- [x] 3. Start change, Run tests, Open PR (built and tested against a stand-in GitHub; see below)
- [x] 4. CI status, Merge, Staging check (same)
- [x] 5. Release, Production check, README, final test pass (same)

## Milestone 1 notes

Checked against `cconstab/3Chords.dev` (cloned and run locally only):

- Clone into `~/roadie/sites/cconstab/3Chords.dev`; start, test, port, staging URL, production URL and health path all detected from `package.json` and the README.
- The site runs on a free port with `HOST=127.0.0.1`; the preview shows it framed in Chrome.
- Through the proxy only `frame-ancestors` is removed from the site's policy; the rest is byte-for-byte the same. Responses are marked `no-cache` so edits show at once.
- A CSS edit reloads the preview; a `server.js` edit restarts the site then reloads; writes to gitignored files (`data/db.json`) do neither.
- Stopping Roadie stops the site's process.

## Milestone 2 notes

- Agent SDK 0.3.330. Built-in tools are limited to Read, Edit and Write; a hook checks every path; list, search and run-tests are Roadie's own tools. No machine settings are loaded.
- Checked live with a local Ollama model (qwen3.5:9b) against the 3Chords.dev clone: it read and edited a file, the diff showed, and the preview reloaded. Asked to write to /tmp, read .git/config and use a shell, the first two were refused by the hook and the third had no tool to call.
- **Not yet checked live with an Anthropic API key**: none was set while building. The code path differs only in environment variables, model name and system prompt.
- The test sandbox (macOS sandbox-exec) runs the 3Chords.dev tests fine, and blocks outside network access and writes to .git.
- Roadie's git commands never run hooks from a site's clone.

## Starter site and hosting guide (added after milestone 2)

- A blank repo (no files, or only README/licence/.gitignore) is offered a starter site from `templates/starter`: a zero-dependency Node server, tests, Dockerfile, compose file, CI workflow and deploy script, following the 3Chords.dev pipeline.
- Checked: the starter's own tests pass; Roadie detects all its settings; its Docker image builds, runs read-only as an unprivileged user, and reports healthy.
- **Not checked: the starter's GitHub Actions workflow.** It has never run on GitHub. It is the 3Chords.dev workflow with names changed. Running it needs the throwaway repo.
- The hosting guide gives DNS, firewall, Docker, Caddy, registry, first deploy and cron steps, filled in for the site. Install commands were copied from the official Docker, Caddy and GitHub docs in November 2026. They have not been run on a real server.
- The AI can talk someone through the guide. Checked with a local Ollama model.

## Milestones 3 to 5: the change bar

Built while the owner was away, so without the throwaway GitHub repo.

- `src/change.js` is the state machine, a pure function of facts. `src/flow.js` carries a change through the steps. `src/guards.js` holds the secret scan and the one-time confirmations.
- Tested end to end with **real git** against a local bare repository standing in for GitHub, and a **fake gh** (`test/fake-github.js`) that really merges and tags in that repository. The whole flow was also clicked through in Chrome against that stand-in, from an empty repo to a live release.
- The **read** formats of gh (pull request, checks, releases, repo settings) were checked against real data from cconstab/3Chords.dev.
- **Never run against GitHub itself:** `git push` over HTTPS with gh's sign-in, `gh pr create`, `gh pr merge`, `gh release create`, and GitHub's release-notes call. These are the first things to try with a throwaway repo.
- GitHub's push protection may refuse a push that contains a secret Roadie's own scan missed. Roadie reports that refusal; it does not try to get round it.

## Decision taken, to confirm with the owner

- **First commit in an empty repo.** A new GitHub repo has no branch, so something has to be pushed to `main` once before pull requests can exist. Roadie offers "Make the first commit" only when GitHub has no commits at all, with the usual confirmation, and refuses it ever after. This is the single exception to "never push to main". It was implemented without the owner's answer; say if it should go.

## Open items

- **Turn on CI for Roadie itself.** `docs/ci-test.yml` is a ready workflow (npm test on Ubuntu and macOS). It could not be pushed into place because the owner's gh sign-in lacks the `workflow` permission. To enable: `gh auth refresh -h github.com -s workflow`, then `mkdir -p .github/workflows && git mv docs/ci-test.yml .github/workflows/test.yml`, commit and push. Roadie's tests have therefore **not been run on Linux**.

- Try the chat with a real ANTHROPIC_API_KEY.
- Test sandbox for Linux (bubblewrap or similar). Today Linux runs tests unsandboxed.
- Chat history is kept in memory only; restarting Roadie starts a fresh conversation.

- Preview: a site whose pages redirect to an absolute URL on its own port would leave the proxy. Not seen yet; handle if a real site does it.
- Run the change bar against a real throwaway GitHub repo (ideally an empty one, to cover the first commit and the starter's workflow too).
