// Starting and stopping site commands the way each system needs.
//
// macOS and Linux: a command gets its own process group, and the group is
// signalled as one. Windows has no process groups or signals, so the command
// runs under cmd.exe and the whole tree is ended with taskkill.
import { spawn, spawnSync } from 'node:child_process';

export const isWindows = (platform = process.platform) => platform === 'win32';

// Options for spawn() so that the command and everything it starts can later be stopped together.
export function treeOptions(platform = process.platform) {
  return isWindows(platform) ? { windowsHide: true } : { detached: true };
}

// The command that ends a process and all its descendants on Windows.
export function taskkillArgs(pid) {
  return ['/pid', String(pid), '/T', '/F'];
}

// Stop a child started with treeOptions(), and everything it started.
// On Windows there is no gentle stop for console programs, so it is always forced.
// It is synchronous there, so it also works while Roadie itself is exiting.
export function stopTree(child, signal = 'SIGTERM', { platform = process.platform, kill = process.kill.bind(process), runSync = spawnSync } = {}) {
  if (!child || !child.pid) return;
  try {
    if (isWindows(platform)) runSync('taskkill', taskkillArgs(child.pid), { stdio: 'ignore', windowsHide: true });
    else kill(-child.pid, signal);
  } catch { /* already gone */ }
}

// Start a shell command (sh on macOS and Linux, cmd.exe on Windows) as a stoppable tree.
export function spawnShell(command, options = {}) {
  return spawn(command, { ...options, ...treeOptions(), shell: true });
}

// How to open a link in the default browser: [program, arguments].
export function browserOpener(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  // Not "cmd /c start": cmd would read characters in the link as commands.
  if (isWindows(platform)) return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
