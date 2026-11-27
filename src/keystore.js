// Keeps the Anthropic API key in the operating system's own password store, so
// nobody has to set an environment variable:
//
//   macOS    Keychain, through the built-in `security` command
//   Windows  the signed-in user's protected storage (DPAPI), through PowerShell;
//            the encrypted text is kept in a file only that user can decrypt
//   Linux    the desktop keyring, through `secret-tool`, where it is installed
//
// The key is handed to these tools on standard input, never on a command line,
// where other programs could read it. It is never written to disk in the clear
// and never sent to the browser.
//
// What this does not do: hide the key from programs running as the same user.
// A site's own tests run as that user, exactly as they could read an
// environment variable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'Roadie Anthropic API key';
const ACCOUNT = 'roadie';

// Letters, digits, dash and underscore only, which is what Anthropic issues.
// It also means the key needs no quoting wherever it is passed on.
export function cleanKey(given) {
  const key = String(given ?? '').trim();
  if (!key) throw new Error('Paste the API key first.');
  if (!/^[A-Za-z0-9_-]{20,400}$/.test(key)) throw new Error('That does not look like an Anthropic API key. Copy it again from the Console: it starts with "sk-ant-" and has no spaces.');
  return key;
}

// Enough to recognise the key, never enough to use it.
export const keyEnding = (key) => (key ? `…${String(key).slice(-4)}` : '');

function realRun(cmd, args, { input = '', timeout = 30_000 } = {}) {
  // Windows PowerShell must not inherit PowerShell 7's module folders.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env }); }
    catch (err) { return resolve({ code: -1, stdout: '', stderr: err.message }); }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { stderr += 'It took too long to answer.'; child.kill(); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message, missing: err.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
// Both read one line from standard input and write one line back. They call
// .NET directly and use no PowerShell commands: Windows PowerShell cannot load
// its own command modules when it is started from inside PowerShell 7.
const PS_LOAD = '$ErrorActionPreference = "Stop"; [void][Reflection.Assembly]::LoadWithPartialName("System.Security"); $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser; ';
const PS_PROTECT = PS_LOAD + '$k = [Console]::In.ReadLine(); $b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($k), $null, $scope); [Console]::Out.WriteLine([Convert]::ToBase64String($b))';
const PS_UNPROTECT = PS_LOAD + '$e = [Console]::In.ReadLine(); $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($e), $null, $scope); [Console]::Out.WriteLine([Text.Encoding]::UTF8.GetString($b))';

export function createKeyStore({ home, platform = process.platform, run = realRun } = {}) {
  const file = home ? path.join(home, 'anthropic-key.protected') : null;
  const failed = (what, r) => new Error(`${what} (${(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0]})`);

  if (platform === 'darwin') {
    return {
      where: 'your macOS Keychain',
      async get() {
        const r = await run('/usr/bin/security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
        return r.code === 0 ? r.stdout.trim() || null : null;
      },
      async set(given) {
        const key = cleanKey(given);
        // `security -i` reads its command from standard input, so the key is not on a command line.
        const r = await run('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${ACCOUNT} -s "${SERVICE}" -w ${key}\n` });
        if (r.code !== 0 || (await this.get()) !== key) throw failed('The Keychain did not take the key.', r);
      },
      async remove() {
        await run('/usr/bin/security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
      },
    };
  }

  if (platform === 'win32') {
    return {
      where: "Windows' protected storage for your account",
      async get() {
        if (!file || !fs.existsSync(file)) return null;
        const r = await run('powershell.exe', [...POWERSHELL, PS_UNPROTECT], { input: fs.readFileSync(file, 'utf8').trim() + '\n' });
        return r.code === 0 ? r.stdout.trim() || null : null;
      },
      async set(given) {
        const key = cleanKey(given);
        const r = await run('powershell.exe', [...POWERSHELL, PS_PROTECT], { input: key + '\n' });
        const sealed = r.stdout.trim();
        // What comes back is one long line of base64. Anything else, the key itself above all, is not written down.
        if (r.code !== 0 || !/^[A-Za-z0-9+/=]{100,}$/.test(sealed) || sealed.includes(key)) throw failed('Windows could not protect the key.', r);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, sealed + '\n', { mode: 0o600 });
      },
      async remove() {
        if (file) fs.rmSync(file, { force: true });
      },
    };
  }

  const attrs = ['service', 'roadie', 'account', 'anthropic'];
  return {
    where: 'your desktop keyring',
    async get() {
      const r = await run('secret-tool', ['lookup', ...attrs]);
      return r.code === 0 ? r.stdout.trim() || null : null;
    },
    async set(given) {
      const key = cleanKey(given);
      const r = await run('secret-tool', ['store', `--label=${SERVICE}`, ...attrs], { input: key });
      if (r.missing) throw new Error('This system has no keyring tool Roadie can use ("secret-tool" is not installed), so the key cannot be stored safely here. Set ANTHROPIC_API_KEY in your terminal instead.');
      if (r.code !== 0 || (await this.get()) !== key) throw failed('The keyring did not take the key.', r);
    },
    async remove() {
      await run('secret-tool', ['clear', ...attrs]);
    },
  };
}
