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

## Independent review, and what changed because of it

A fresh reviewer read the safety-critical code looking for ways to break the rules in the README. It found real holes. All are fixed and each has a test.

| Finding | Fix |
|---|---|
| The AI could reach `.git` by writing `.GIT/config` (macOS ignores case) | Folder and secret names are compared the way the file system compares them |
| The preview ran AI-edited server code with the owner's full access | The preview server and install commands run in the sandbox, like tests |
| Sandboxed tests could call Roadie's own API on localhost and press its buttons | Roadie's ports are closed to sandboxed code; the page and token are only given to the browser that came with the launch link |
| The test sandbox could read the whole home folder and write almost anywhere | Reads in the home folder are limited to the site, tools and caches; writes to the site, temp and caches; no keychain |
| A `.gitattributes` rule could hide file contents from the secret scan | The scan reads real content regardless of attributes |
| File search followed links out of the site, and a bad pattern could freeze Roadie | Search checks every file like Read does, and takes plain text only |
| A failed first push left an empty repo stuck | The push can be retried on its own |
| A slow health check could bring a finished change back | A check that finishes late writes nothing |
| A merge could be recorded without its commit, blocking staging and release | The merge is recorded at once and the commit filled in when GitHub reports it |
| A test pass could be credited to files edited during the run, or to another site | A pass counts for the site and files it started on; switching sites mid-step is refused |
| Checks were not re-read at the moment of merging | They are |
| Abandon was not offered while a pull request was open | It always is |
| The preview proxy answered to any host name | It answers only as this machine |
| A site that rewrites its own files on start restarted for ever | Automatic restarts stop after four in quick succession, with a message |

### Second read of the fixes

A second reviewer checked the fixes for correctness and regressions. It judged 11 of the 14 correct and found more to fix, all now done with tests:

- After a merge or a closed pull request, one more edit left the change with no usable button. Abandon is now offered at every stage.
- Roadie's session cookie reached the previewed site's server on WebSocket connections, and was the same value as the API token. It is now stripped on every kind of request, has its own secret, and is named per port (so two Roadies do not log each other out).
- The restart limiter could drop real restarts during quick editing and missed slow loops. It now holds back only when the very same files change straight after each restart.
- Tests could not read committed fixtures with secret-looking names (`.env.test`, `*.pem`). Only uncommitted ones are withheld now.
- A failure caused by the sandbox now says so, instead of a bare "Operation not permitted". Git-hook installers (husky) are told to stand down during installs.
- Smaller: chat could be left "busy" if the AI failed to start; a stale health check could stop a newer watch; saves could overwrite a concurrent update; a health URL reporting the full commit id did not match; a run that dirtied files had no override.

Known limits the sandbox places on ordinary sites (by design, documented in the README): tests that need the internet, a headless browser, Docker or a database socket will not pass inside Roadie.

**The sandbox has not had an adversarial test by a second party.** A follow-up review that was asked to try to break out of the sandbox was stopped by the AI model's own safety filters, so that probing did not happen. The limits were checked one by one (see `test/sandbox.test.js`), but nobody other than the author has tried to defeat them. Worth having a security-minded person do so.

**What is still not defended against:**

- **Linux and Windows have no sandbox.** Everything in the table that depends on the sandbox holds on macOS only. Roadie warns about this in the window and the README says so. A Linux sandbox (bubblewrap) is the most important piece of future work.
- **Install commands have the internet.** They cannot use the owner's sign-ins or write outside the site, but a malicious install script could send the site's own files somewhere. They can also read `~/.npmrc`, which may hold a registry token.
- **Other programs running as the same user**, outside the sandbox, are not something Roadie can defend against: they could use git and gh directly.
- macOS `sandbox-exec` is deprecated by Apple, though it still works and is widely used.

## Windows support (added 2026-11-23)

Roadie no longer refuses to start on Windows. What changed:

- Site commands (start, test, install) run under `cmd.exe` there, and the whole process tree is ended with `taskkill /T /F`, since Windows has no process groups or signals (`src/proc.js`).
- The launch link is opened without a shell, so nothing in it can be read as a command.
- Path guards know Windows spellings: `.git::$INDEX_ALLOCATION`, `.env::$DATA`, trailing dots and spaces, and short names such as `GIT~1` or `ENV~1` (refused outright on Windows).
- Credential variables are stripped from site code whatever their letter case (Windows ignores case in variable names).
- Install hints name Git for Windows and winget; the README has the PowerShell form of setting the key.
- Roadie's own tests no longer use `sh` syntax, apart from the macOS sandbox tests, which are skipped elsewhere.

Line endings and paths:

- Git for Windows checks text files out with CRLF by default. A test now puts a clone into exactly that state (with real git, `core.autocrlf=true`) and checks the list of changes, the diffs, the fingerprint used for confirmations, the secret scan, search results, and that what is pushed has LF only.
- Roadie's repo and the starter site each carry a `.gitattributes` (`* text=auto eol=lf`), so shell scripts and Dockerfiles keep LF on every system. The starter is always written with LF.
- Windows cannot record a file's executable flag, so the starter's deploy script is now run as `sh deploy/update.sh` everywhere (crontab line, README, hosting guide).
- Paths: git is told to allow paths over 260 characters; a site folder is never given a name Windows reserves (`con`, `nul`, a trailing dot); the static preview hides dotfiles under their Windows spellings; file names shown in the chat use forward slashes.

**The tests now run on real Windows (GitHub Actions, 2026-11-23): 141 pass, 7 skipped** (the skipped ones need the macOS sandbox or sh). The first run found real problems, since fixed: a short name for a file that exists was resolved by Windows before the short-name check saw it (still refused, as a secret, but now refused as given); and several tests assumed LF checkouts, permission bits, forward slashes or the spelling `PATH`. **Still not run on Windows:** Roadie itself in a browser, the downloads, and `install.ps1`. Like Linux, Windows has no sandbox, and Roadie says so at the top of the window.

Things most likely to need attention on a real Windows run: the Claude Agent SDK's own Windows requirements; `gh auth git-credential` as a git credential helper under Git for Windows; site start commands written for `sh` (for example `PORT=3000 node server.js` in a package.json script) which `cmd.exe` cannot run; tests that create symlinks, which need Developer Mode or an administrator.

## Release downloads and installers (added 2026-11-23)

- `npm run package` (`scripts/package.mjs`) builds one self-contained archive per system into `dist/`: macOS, Linux and Windows, each for arm64 and x64. Each holds Node with npm (downloaded from nodejs.org and checked against its published checksums), Roadie's files unchanged, and the dependencies for that system. Nothing is compiled or bundled, and no new dependency was added. One machine builds all six.
- `scripts/install.sh` and `scripts/install.ps1` download the right archive from the newest GitHub release, check it against the release's `SHA256SUMS`, and install it for the current user only (no administrator rights).
- An installed Roadie lends its Node and npm to sites, placed after any the person has installed themselves.
- `.github/workflows/release.yml` builds and attaches the downloads whenever a release is published. First run: v0.0.2 (2026-11-23), all nine files attached. Until it finishes (a few minutes) a new release has no files, so installs and updates fail in that gap.

Verified on macOS arm64: built all six archives; installed the macOS one through `install.sh` from a local server; ran it with no other Node on the PATH; ran a starter site's `npm test` in the sandbox using only the bundled npm; a download with a wrong checksum was refused. **Not verified:** the Linux and Windows archives were built and inspected but never run; `install.ps1` has never run; no release has been published, so the install commands in the README do not work yet.

Added the same day:

- **Missing tools.** After installing, both installers look for git and gh. For anything missing they show the exact install command (Homebrew, apt, dnf, pacman, zypper, or winget) and run it only on a yes; they offer to run `gh auth login`, and say what to do about git's name and email and the AI key. `sh install.sh --check` does only this part. The yes/no question is asked on the terminal even when the script arrives through `curl | sh`.
- **Updates.** An installed Roadie asks github.com for the address of the newest release at start and twice a day (`src/update.js`; `ROADIE_NO_UPDATE_CHECK=1` turns it off). A newer one shows as a line at the top of the window with an Update button. The button, after a confirmation, runs the installer that came with the installed copy against that release; Roadie then stops. The installer keeps the old copy until the new one is in place. On Windows the installer runs in its own window after Roadie has stopped, because a running program cannot be replaced there. A copy run from source is told to use `git pull` instead.
- Verified on macOS: installed a build marked v0.1.0, updated it to one marked v0.2.0 from a local server, started the updated copy; a download with a wrong checksum was refused and the installed copy left as it was; the dependency check ran against a pretend package manager and against this machine. **Not verified:** the Windows update path and `install.ps1` (never run), the Linux package-manager commands (never run).
- **v0.0.1 published (2026-11-23)**, built on this Mac: six downloads, both installers and SHA256SUMS. Verified on macOS arm64 against the real release: `install.sh` from `releases/latest/download` downloads, passes the checksum and installs; the installed copy finds v0.0.1 as the latest release and offers no update; a copy claiming v0.0.0 is offered v0.0.1. 
- **v0.0.2 published (2026-11-23)**, built by the release workflow. Verified on macOS arm64: a v0.0.1 installed from GitHub was offered v0.0.2, updated itself through `applyUpdate`, and the updated copy started. Not verified: pressing the Update button in a browser, and anything on a real Linux or Windows machine.
- **v0.0.3 published (2026-11-24)**, built by the release workflow, after the owner's first Windows test of v0.0.2. Changes: the Windows launcher finds its own folder with `%~f0` (not `%~dp0`), and `install.ps1` adds the install folder to the PATH of the window it runs in as well as to the saved one; the sandbox note has a "Got it" button and stays hidden (browser storage); AI settings list the four current Claude models plus "Another model"; a line under the chat shows tokens in (and how many came from cache), tokens out and the cost so far. Remaining credit cannot be read with an ordinary API key, so the settings link to the billing page instead. CI now also runs on ARM Linux and ARM Windows (five systems). Checked: the v0.0.3 Windows zip holds the new launcher. Not verified: the new screens in a browser, and the launcher and PATH fix on real Windows.
- **After v0.0.3 (not yet released):** `install.ps1` downloads with `curl.exe` (part of Windows 10 and later) so the big download shows a progress bar like the Linux and macOS installer; it falls back to a silent `Invoke-WebRequest` where curl.exe is missing. PowerShell's own progress display stays off because it slows downloads badly. Not run on Windows.
- **v0.0.4 published (2026-11-24):** the `install.ps1` progress bar above.
- **After v0.0.4 (not yet released), from the owner's note that there was no way to add images (2026-11-25):**
  - **Add files** (button, drop on the chat, or paste): copies images and other files into the site through `checkSitePath`, with a rename box, the folder the site already uses for images, a question before replacing, a 25 MB limit and a note when `.gitignore` will leave the file out (`src/uploads.js`, `POST /api/files/add`, one file per request as raw bytes).
  - **Only show the AI**: up to five pictures go with the next message as image blocks and are not saved anywhere. The kind of picture is read from its bytes. The browser shrinks anything over 2000 pixels first.
  - **Changed files** shows images as pictures (`GET /api/file`, images only, served with a sandbox policy so an SVG cannot run script in Roadie's page, and refused to any page but Roadie's own).
  - **Undo** on one changed file (`gitops.restoreFile`): uncommitted edits go to `git stash`, and anything the branch had already committed for that file is taken back to where the change began.
  - **The AI can now delete and move files** (`delete_file`, `move_file`). Before, it had only Read, Edit and Write, so it could not rename an image or remove a page.
  - **Preview width**: laptop, tablet and phone widths.
  - Verified in a real browser (headless Chrome against a stand-in GitHub, real git, and the local model qwen3.5:9b through the real Agent SDK): adding three files, the replace question, refusals for `.git` and `..`, undo with and without commits, drop, paste, the phone width, the AI renaming an added image with `move_file` and putting it on the home page with alt text, and the AI describing an attached picture correctly. A 20 MB binary file adds about 0.6 s to the secrets scan. **Not verified:** any of it on Windows or Linux beyond the automated tests, and attached pictures with Claude itself (no API key on this machine).
- **Edit on page (branch `edit-on-page`, 2026-11-25), asked for by the owner as "WYSIWYG".** A toggle in the preview pane. Click an element to point the AI at it (page, CSS path, text and HTML go with the next message as background). Double-click text to retype it: `src/pageedit.js` finds the old text in the site's files and replaces only the changed words, keeping line breaks and entities. Click an image, then Replace image, to swap the file. The page side is `src/preview-page.js`, served by the proxy as the one script it already added.
  - Roadie writes a text change only when the old text is in exactly one place, as a whole piece of page text (straight after a tag and before one), in the file that makes the page when there is one. Otherwise nothing is written and a request for the AI is put in the message box.
  - Decided against a full visual editor (dragging layout, restyling): it would rewrite hand-coded HTML wholesale.
  - Safety: the page script only reports; the previewed site's own script could fake such reports, so they are ignored unless the owner has the toggle on, and an edit can only replace existing text in a page or prose file inside the site folder, where it shows under Changed files.
  - Verified in headless Chrome with real mouse and keyboard input inside the preview: pointing, links held while it is on, retyping a heading (the `<title>` with the same word left alone), adding words beside a `<strong>` with `&amp;` and `&copy;` kept, Escape, a repeated word handed to the AI, replacing a picture, and the page behaving normally with the toggle off. A bug found this way and fixed: text inside a link could not be typed into. **Not verified:** Firefox and Safari, and sites built from templates beyond the automated tests.
- This is the one place Roadie contacts the internet without a click. It is a read of a public address, sends nothing about the person, and is documented and switchable; the owner should say if they would rather it were off by default.

Why archives and not `.pkg`/`.msi` installers or a single executable: those need Apple and Microsoft code-signing certificates to install without warnings, and a single executable would need a bundling step. The Node program inside the archive is already signed by the Node.js project.

## Decision confirmed by the owner

- **First commit in an empty repo (confirmed 2026-11-23).** A new GitHub repo has no branch, so something has to be pushed to `main` once before pull requests can exist. Roadie offers "Make the first commit" only when GitHub has no commits at all, with the usual confirmation, and refuses it ever after. This is the single exception to "never push to main".

## Open items

- ~~Turn on CI for Roadie itself.~~ Done 2026-11-23: `.github/workflows/test.yml` runs `npm test` on Ubuntu (142 pass, 6 skipped), macOS (148 pass) and Windows (141 pass, 7 skipped) for every push to main and every pull request.

- Try the chat with a real ANTHROPIC_API_KEY.
- Test sandbox for Linux (bubblewrap or similar). Today Linux runs tests unsandboxed.
- Chat history is kept in memory only; restarting Roadie starts a fresh conversation.
- The AI cannot see the rendered page. The owner can paste a screenshot, but the AI cannot take one itself to check its own work.
- Images added to the site are not resized or compressed; Roadie only warns above 500 KB.
- There is no file browser: to see which images a site already has, ask the AI or look in the folder.

- Preview: a site whose pages redirect to an absolute URL on its own port would leave the proxy. Not seen yet; handle if a real site does it.
- Run the change bar against a real throwaway GitHub repo (ideally an empty one, to cover the first commit and the starter's workflow too).
