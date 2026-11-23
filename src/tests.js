// Runs the site's test command. The same function serves the Run tests button
// and the AI's run_tests tool.
//
// Test files are code the AI may have edited, so they run in the box described
// in sandbox.js: no network beyond this machine, no way to Roadie's own ports,
// no sign-in or secrets, and no writing outside the site and temp folders.
import { childEnv, trackChild } from './runner.js';
import { roadieFiles, roadiePorts, sandboxAvailable, sandboxHint, spawnBoxed } from './sandbox.js';

export { sandboxAvailable };

const MAX_OUTPUT = 60_000;

// tracked: the files committed in the repo, if known (see sandbox.js for why it matters).
export function runTests({ dir, command, timeoutMs = 300_000, onOutput, tracked = null, sandbox = sandboxAvailable() }) {
  return new Promise((resolve) => {
    if (!command) {
      return resolve({ passed: false, code: null, output: 'This site has no test command. Set one in Site settings.', sandboxed: false, timedOut: false, durationMs: 0 });
    }
    const started = Date.now();
    const child = spawnBoxed(command, {
      cwd: dir, env: childEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }), mode: 'tests',
      blockPorts: roadiePorts(), protect: roadieFiles(), tracked, sandbox,
    });
    const untrack = trackChild(child);

    let output = '';
    let timedOut = false;
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
      onOutput?.(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);

    const finish = (code) => {
      clearTimeout(timer);
      untrack();
      if (output.length > MAX_OUTPUT) output = '[earlier output cut]\n' + output.slice(-MAX_OUTPUT);
      if (timedOut) output += `\nStopped: the tests ran longer than ${Math.round(timeoutMs / 1000)} seconds.`;
      if (code !== 0 && child.sandboxed) output += sandboxHint(output, 'tests');
      resolve({ passed: code === 0 && !timedOut, code, output, sandboxed: child.sandboxed, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => { output += err.message; finish(127); });
    child.on('close', (code) => finish(code ?? 1));
  });
}
