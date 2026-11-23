// Runs one command without a shell and always resolves, never throws.
import { spawn } from 'node:child_process';

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
      child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: 127, stdout: '', stderr: err.message, missing: true });
    }
    const timer = setTimeout(() => {
      stderr += `\n${cmd} timed out after ${timeout} ms`;
      child.kill('SIGKILL');
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
