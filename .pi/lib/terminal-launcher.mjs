import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const runFile = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
export const terminalCommand = (executable, args = []) => [executable, ...args].map(quote).join(' ');

const ghosttyScript = [
 'on run argv',
 'tell application "Ghostty"',
 'set cfg to new surface configuration',
 'set initial working directory of cfg to item 1 of argv',
 // Ghostty's surface API wraps this in exec itself on macOS.
 'set command of cfg to item 2 of argv',
 'set wait after command of cfg to false',
 'set sources to every terminal whose tty is (item 3 of argv)',
 'if (count of sources) is not 1 then error "The requesting Ghostty pane could not be identified by its TTY"',
 'set createdTerminal to split (item 1 of sources) direction right with configuration cfg',
 'focus createdTerminal',
 'return id of createdTerminal',
 'end tell',
 'end run',
].join('\n');
const itermScript = 'on run argv\ntell application "iTerm2"\nset win to create window with default profile command (item 1 of argv)\nactivate\nreturn id of win\nend tell\nend run';
const terminalScript = 'on run argv\ntell application "Terminal"\ndo script (item 1 of argv)\nactivate\nend tell\nend run';

// Selection is independent of OS defaults. Each adapter must open the selected
// application or report failure; a failed adapter never selects another one.
const adapters = [
 { id: 'tmux', name: 'tmux', programs: ['tmux'], async open(request, client) {
  const socket = client.environment.TMUX?.match(/^(.*),\d+,\d+$/)?.[1];
  const pane = client.environment.TMUX_PANE;
  if (!socket || !/^%\d+$/.test(pane ?? '')) throw new Error('The current tmux socket and pane could not be identified');
  const { stdout } = await client.exec('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, '#{session_id}']);
  const session = stdout.trim();
  if (!/^\$\d+$/.test(session)) throw new Error('The current tmux session could not be identified');
  await client.exec('tmux', ['-S', socket, 'new-window', '-t', `${session}:`, '-n', request.title, '-c', request.cwd, request.executable, ...request.args]);
 } },
 { id: 'vscode', name: 'the current IDE', programs: ['vscode', 'antigravity', 'cursor', 'windsurf', 'code-oss', 'vscodium'], async open(request, client) {
  if (!client.openIde) throw new Error('The IDE terminal bridge is unavailable');
  return await client.openIde(request);
 } },
 { id: 'ghostty', name: 'Ghostty', programs: ['ghostty'], async open(request, client) {
  if (client.platform === 'darwin') {
   const ttyResult = await client.exec('ps', ['-o', 'tty=', '-p', String(client.processId)]);
   const tty = ttyResult.stdout.trim();
   if (!tty || /^\?+$/.test(tty)) throw new Error('The requesting Ghostty pane has no controlling TTY');
   const sourceTty = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
   const { stdout } = await client.exec('osascript', ['-e', ghosttyScript, request.cwd, terminalCommand(request.executable, request.args), sourceTty]);
   return { terminalId: stdout.trim(), split: true, sourceTty };
  }
  if (client.platform !== 'linux') throw new Error('Ghostty terminal launching is available on macOS and Linux');
  const binary = client.environment.GHOSTTY_BIN_DIR ? join(client.environment.GHOSTTY_BIN_DIR, 'ghostty') : 'ghostty';
  await client.exec(binary, ['+new-window', `--working-directory=${request.cwd}`, `--title=${request.title}`, '-e', request.executable, ...request.args]);
 } },
 { id: 'iterm2', name: 'iTerm2', programs: ['iterm.app', 'iterm2'], async open(request, client) {
  if (client.platform !== 'darwin') throw new Error('iTerm2 requires macOS');
  const command = terminalCommand('/bin/sh', ['-c', `cd ${quote(request.cwd)} && exec ${terminalCommand(request.executable, request.args)}`]);
  const { stdout } = await client.exec('osascript', ['-e', itermScript, command]);
  return { windowId: stdout.trim() };
 } },
 { id: 'apple-terminal', name: 'Terminal.app', programs: ['apple_terminal'], async open(request, client) {
  if (client.platform !== 'darwin') throw new Error('Terminal.app requires macOS');
  await client.exec('osascript', ['-e', terminalScript, `cd ${quote(request.cwd)} && ${terminalCommand(request.executable, request.args)}`]);
 } },
 { id: 'wezterm', name: 'WezTerm', programs: ['wezterm'], async open(request, client) {
  const pane = client.environment.WEZTERM_PANE;
  const { stdout } = await client.exec('wezterm', ['cli', 'spawn', '--new-window', '--cwd', request.cwd, ...(pane ? ['--pane-id', pane] : []), '--', request.executable, ...request.args]);
  return { paneId: stdout.trim() };
 } },
 { id: 'kitty', name: 'kitty', programs: ['kitty'], async open(request, client) {
  const address = client.environment.KITTY_LISTEN_ON;
  if (!address) throw new Error('This kitty session has no KITTY_LISTEN_ON remote-control endpoint');
  const { stdout } = await client.exec('kitty', ['@', '--to', address, 'launch', '--type=os-window', '--cwd', request.cwd, '--title', request.title, '--', request.executable, ...request.args]);
  return { windowId: stdout.trim() };
 } },
];
const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
const byProgram = new Map(adapters.flatMap(adapter => adapter.programs.map(program => [program, adapter])));

export function captureTerminalContext({ environment = process.env, platform = process.platform } = {}) {
 const env = Object.freeze({ ...environment });
 const program = String(env.TERM_PROGRAM ?? '').trim();
 let adapter, error;
 if (env.TMUX) adapter = byId.get('tmux');
 else if (program) {
  adapter = byProgram.get(program.toLowerCase());
  if (!adapter) error = `Opening a new terminal in ${program} is not supported`;
 } else {
  const candidates = [
   (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR || env.TERM === 'xterm-ghostty') && 'ghostty',
   env.ITERM_SESSION_ID && 'iterm2',
   (env.WEZTERM_PANE || env.WEZTERM_UNIX_SOCKET) && 'wezterm',
   (env.KITTY_WINDOW_ID || env.KITTY_PID || env.KITTY_LISTEN_ON) && 'kitty',
   (env.RESEARCH_PI_VSCODE_TERMINAL || env.VSCODE_IPC_HOOK_CLI) && 'vscode',
  ].filter(Boolean);
  if (candidates.length === 1) adapter = byId.get(candidates[0]);
  else error = candidates.length ? 'The terminal environment identifies multiple applications; TERM_PROGRAM is needed to choose the current one' : 'The current terminal application could not be identified';
 }
 if (adapter && (env.SSH_CONNECTION || env.SSH_TTY) && !['vscode', 'tmux'].includes(adapter.id)) {
  error = 'This is a remote SSH terminal. Open another terminal on the same remote host or use tmux to open a remote window';
 }
 return Object.freeze({ provider: adapter?.id, appName: adapter?.name ?? program, platform, processId: process.pid, environment: env, error });
}

// The physical client supplies an immutable environment snapshot. Hosts and
// nested viewers forward requests to that client instead of choosing an app.
export async function launchTerminal(request, { context = captureTerminalContext(), exec = runFile, openIde } = {}) {
 const command = terminalCommand(request.executable, request.args);
 const result = { target: context.provider, appName: context.appName, command };
 if (context.error) return { ...result, opened: false, error: context.error };
 const adapter = byId.get(context.provider);
 if (!adapter) return { ...result, opened: false, error: 'No launcher is available for the current terminal application' };
 const client = { ...context, openIde, exec: (file, args) => exec(file, args, { cwd: request.cwd, env: context.environment }) };
 try {
  const opened = await adapter.open({ title: 'Pi subagent', ...request }, client);
  return { ...result, opened: true, ...opened };
 } catch (error) {
  return { ...result, opened: false, error: `Could not open a terminal in ${context.appName}: ${error.message}` };
 }
}
