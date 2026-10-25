import { execFile, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

export const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
export const POWERSHELL_PREAMBLE = "$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $true\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n";
export const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
let powerShell;
export async function windowsPowerShell() {
 if (!powerShell) powerShell = promisify(execFile)('pwsh.exe', [...POWERSHELL_ARGS,
  '@{ version = $PSVersionTable.PSVersion.ToString(); path = (Get-Process -Id $PID).Path } | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 10000, encoding: 'utf8' }).then(({ stdout }) => {
   const info = JSON.parse(stdout.trim());
   if (!/^7\.(?:[6-9]|[1-9]\d)\./.test(info.version) || info.version.includes('-')) throw new Error('Install stable PowerShell 7.6 LTS or newer 7.x; found '+info.version);
   return { exe: info.path, args: POWERSHELL_ARGS };
  });
 return powerShell;
}

// npm's .cmd shim cannot be passed to spawn(shell:false). Invoke its actual
// Node entrypoint with an argv array; never interpolate model input into cmd.exe.
export function nativeInvocation(executable, args, platform = process.platform) {
 if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args };
 const text = readFileSync(executable, 'utf8');
 const match = text.match(/%dp0%[\\/]([^"\r\n]+\.(?:c?js|mjs))/i);
 if (!match || !/node(?:\.exe)?/i.test(text)) throw new Error('Use a native executable or standard npm Node shim: '+executable);
 const entry = resolve(dirname(executable), match[1].replaceAll('\\', '/'));
 if (!existsSync(entry)) throw new Error('npm shim entrypoint is missing: '+entry);
 return { executable: process.execPath, args: [entry, ...args] };
}

export function terminateOwnedProcess(child) {
 if (!child?.pid) return;
 if (process.platform === 'win32') {
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.on('error', () => child.kill());
  return;
 }
 try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

export function nativeWindowsMode(argv) {
 const options = argv.slice(0, argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--'));
 const unsupported = ['web', 'native-runtime'].includes(argv[0]) || options.some(arg => ['--resident-runtime', '--web', '--web-tailscale'].includes(arg) || arg.startsWith('--web='));
 if (unsupported) throw new Error('Native Windows preview supports foreground TUI/RPC only; resident/Web modes still require the WSL branch.');
 return argv;
}
