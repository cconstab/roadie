// Runs one command without a shell and always resolves, never throws.
import { spawn } from 'node:child_process';
import { isWindows, stopTree } from './proc.js';

// Commands still running, so they can be stopped when Roadie exits rather than
// finishing unseen afterwards.
const running = new Set();
export function stopRunningCommands() {
  for (const child of running) stopOne(child, 'SIGTERM');
}

// On Windows git and gh start helper programs that outlive a plain kill, so the tree is ended.
function stopOne(child, signal) {
  if (isWindows()) return stopTree(child);
  try { child.kill(signal); } catch { /* gone */ }
}

export function run(cmd, args = [], { cwd, env, input, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, missing: false, ...result });
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ code: 127, stdout: '', stderr: err.message, missing: true });
    }
    running.add(child);
    child.on('close', () => running.delete(child));
    child.on('error', () => running.delete(child));
    const timer = setTimeout(() => {
      stderr += `\n${cmd} timed out after ${timeout} ms`;
      stopOne(child, 'SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      stderr += err.message;
      finish({ code: 127, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => finish({ code: code ?? 1 }));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
