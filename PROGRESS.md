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
- [ ] 3. Start change, Run tests, Open PR
- [ ] 4. CI status, Merge, Staging check
- [ ] 5. Release, Production check, README, final test pass

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

## Open items

- Try the chat with a real ANTHROPIC_API_KEY.
- Test sandbox for Linux (bubblewrap or similar). Today Linux runs tests unsandboxed.
- Chat history is kept in memory only; restarting Roadie starts a fresh conversation.

- Preview: a site whose pages redirect to an absolute URL on its own port would leave the proxy. Not seen yet; handle if a real site does it.
- Milestone 3 needs a throwaway GitHub repo from the user.
