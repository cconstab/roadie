// Runs the site's test command. The same function serves the Run tests button
// and the AI's run_tests tool.
//
// Test files are code the AI may have edited, so they run boxed in where the
// operating system allows it: on macOS, under sandbox-exec, with no network
// beyond this machine and no writing to the site's .git folder. That stops a
// test from pushing, publishing or planting a git hook.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { childEnv, trackChild } from './runner.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_OUTPUT = 60_000;

export function sandboxAvailable() {
  return process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

export function sandboxProfile(siteDir) {
  const git = JSON.stringify(fs.realpathSync(siteDir) + '/.git');
  return [
    '(version 1)',
    '(allow default)',
    // Tests may talk to servers they start on this machine, and nothing else.
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    // No rewriting git config or planting hooks.
    `(deny file-write* (subpath ${git}))`,
  ].join('\n');
}

export function runTests({ dir, command, timeoutMs = 300_000, onOutput, sandbox = sandboxAvailable() }) {
  return new Promise((resolve) => {
    if (!command) {
      return resolve({ passed: false, code: null, output: 'This site has no test command. Set one in Site settings.', sandboxed: false, timedOut: false, durationMs: 0 });
    }
    const started = Date.now();
    const env = childEnv({ FORCE_COLOR: '0', NO_COLOR: '1' });
    const child = sandbox
      ? spawn(SANDBOX_EXEC, ['-p', sandboxProfile(dir), '/bin/sh', '-c', command], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, { cwd: dir, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ passed: code === 0 && !timedOut, code, output, sandboxed: !!sandbox, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => { output += err.message; finish(127); });
    child.on('close', (code) => finish(code ?? 1));
  });
}
