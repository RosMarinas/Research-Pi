import { createConnection } from 'node:net';
import { watch } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { SYSTEM_TMPDIR } from './project-boundary.mjs';

const defaultRegistry = () => join(SYSTEM_TMPDIR, `pi-ide-bridges-${process.getuid?.() ?? userInfo().username}`);

export async function terminalAncestors(exec, platform = process.platform) {
 const result = [process.pid, process.ppid];
 if (platform === 'win32') return result;
 let pid = process.ppid;
 for (let depth = 0; depth < 16 && pid > 1; depth++) {
  const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)]);
  const next = Number(stdout.trim());
  if (!Number.isInteger(next) || next <= 0 || result.includes(next)) break;
  result.push(next); pid = next;
 }
 return result;
}

// The shell PID identifies the window, even when its terminal predates bridge
// installation or still carries an endpoint from before an IDE reload.
async function discoverBridge(ancestors, registryRoot) {
 const files = await readdir(registryRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
 for (const file of files.filter(name => name.endsWith('.json'))) {
  let bridge;
  try { bridge = JSON.parse(await readFile(join(registryRoot, file), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
  if (bridge.terminalPids?.some(pid => ancestors.includes(pid))) return bridge;
 }
}

async function requestTerminal(bridge, options, ancestors) {
 return await new Promise((resolve, reject) => {
  const socket = createConnection(bridge.address); let buffer = '', received = false;
  socket.setTimeout(5000, () => socket.destroy(new Error('The IDE terminal bridge did not respond')));
  socket.on('error', reject);
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'watch', token: bridge.token, node: process.execPath, ...options, ancestors }) + '\n'));
  socket.on('data', chunk => {
   buffer += chunk;
   if (!buffer.includes('\n')) return;
   try { const result = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); received = true; resolve(result); socket.end(); }
   catch (error) { socket.destroy(error); }
  });
  socket.on('close', () => { if (!received) reject(new Error('The IDE terminal bridge disconnected')); });
 });
}

async function originatingIde(environment, ancestors, exec, platform) {
 const roots = [];
 const askpass = environment.VSCODE_GIT_ASKPASS_MAIN;
 if (platform !== 'win32') {
  for (const pid of ancestors) {
   const { stdout } = await exec('ps', ['-o', 'comm=', '-p', String(pid)]);
   const executable = stdout.trim();
   const app = executable.match(/^(.*?\.app)\/Contents\//)?.[1];
   if (app) roots.push(join(app, 'Contents/Resources/app'));
   else if (executable.startsWith('/')) roots.push(join(dirname(executable), 'resources/app'));
  }
 }
 if (askpass?.includes('/extensions/git/')) roots.push(askpass.split('/extensions/git/')[0]);
 for (const root of new Set(roots)) {
  try {
   const product = JSON.parse(await readFile(join(root, 'product.json'), 'utf8'));
   if (!product.applicationName || platform === 'win32') continue;
   const cli = join(root, 'bin', product.applicationName);
   await access(cli);
   return { cli, appName: product.nameLong ?? product.nameShort ?? product.applicationName };
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
 }
}

// One bounded activation wait after installation; normal operation is entirely
// event-driven and never polls terminal state.
async function waitForBridge(ancestors, registryRoot) {
 return await new Promise((resolve, reject) => {
  let checking = false, again = false, settled = false;
  const finish = (bridge, error) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(bridge); };
  const check = async () => {
   if (checking) { again = true; return; }
   checking = true;
   try { do { again = false; const bridge = await discoverBridge(ancestors, registryRoot); if (bridge) return finish(bridge); } while (again && !settled); }
   catch (error) { finish(undefined, error); }
   finally { checking = false; }
  };
  const watcher = watch(registryRoot, () => { void check(); });
  const timer = setTimeout(() => finish(), 10000);
  watcher.on('error', error => finish(undefined, error));
  void check();
 });
}

export async function openVsCodeTerminal(options, { environment, exec, platform, registryRoot = defaultRegistry() }) {
 const ancestors = await terminalAncestors(exec, platform);
 let previousError;
 const bridge = await discoverBridge(ancestors, registryRoot);
 if (bridge) {
  try { return await requestTerminal(bridge, options, ancestors); }
  catch (error) { previousError = error; }
 }
 if (environment.RESEARCH_PI_VSCODE_TERMINAL) {
  try { return await requestTerminal(JSON.parse(environment.RESEARCH_PI_VSCODE_TERMINAL), options, ancestors); }
  catch (error) { previousError = error; }
 }
 const ide = await originatingIde(environment, ancestors, exec, platform);
 if (!ide) throw new Error(`Install Research Pi Terminal in the IDE running this terminal (Antigravity, VS Code or a compatible editor). Its CLI could not be identified.${previousError ? ` ${previousError.message}` : ''}`);
 const directory = await mkdtemp(join(tmpdir(), 'pi-terminal-install-'));
 try {
  const vsix = join(directory, 'research-pi-terminal.vsix');
  await exec('python3', [join(dirname(dirname(options.launcher)), 'scripts/package-vscode-terminal.py'), vsix]);
  // Never call a global "code" executable: that could install into another IDE.
  await exec(ide.cli, ['--install-extension', vsix, '--force'], { env: environment });
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const installed = await waitForBridge(ancestors, registryRoot);
  if (!installed) throw new Error(`Research Pi Terminal was installed in ${ide.appName}, but its bridge has not activated. Enable the extension in this IDE; if it asks for a window reload, wait until your running work can be safely detached.`);
  return await requestTerminal(installed, options, ancestors);
 } finally { await rm(directory, { recursive: true, force: true }); }
}
