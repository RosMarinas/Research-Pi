const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Environment collection is per VS Code window/extension host. No polling,
// command URI handler, workspace-file mutation, or shell command injection.
async function startBridge(vscode, context) {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-vscode-'));
 await fs.chmod(directory, 0o700);
 const address = process.platform === 'win32' ? `\\\\.\\pipe\\pi-vscode-${randomUUID()}` : path.join(directory, 'terminal.sock');
 const token = randomUUID(), clients = new Set();
 const server = net.createServer(socket => {
  clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
  socket.setTimeout(5000, () => socket.destroy());
  let buffer = '', handled = false;
  socket.on('data', async chunk => {
   if (handled) return;
   buffer += chunk;
   if (buffer.length > 65536) return socket.destroy();
   if (!buffer.includes('\n')) return;
   handled = true;
   try {
    const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
    if (request.token !== token) throw new Error('Invalid terminal bridge session');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace before opening a subagent');
    if (request.type !== 'watch' || !['node','launcher','cwd','stateRoot'].every(k => typeof request[k] === 'string' && path.isAbsolute(request[k]) && !request[k].includes('\0'))
      || typeof request.actorId !== 'string' || !request.actorId || request.actorId.startsWith('--')) throw new Error('Invalid subagent terminal request');
    const ancestors = new Set(request.ancestors ?? []);
    const terminals = await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
    const parent = terminals.find(t => ancestors.has(t.pid))?.terminal;
    const terminal = vscode.window.createTerminal({ name: 'Pi · subagent', cwd: request.cwd,
     shellPath: request.node, shellArgs: [request.launcher, 'watch', '--workspace', request.cwd, '--state-dir', request.stateRoot, request.actorId],
     location: parent ? { parentTerminal: parent } : vscode.TerminalLocation.Panel,
     isTransient: true });
    terminal.show(true);
    socket.end(JSON.stringify({ opened: true, target: 'vscode', split: Boolean(parent) }) + '\n');
   } catch (error) { socket.end(JSON.stringify({ opened: false, error: error.message }) + '\n'); }
  });
 });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
 if (process.platform !== 'win32') await fs.chmod(address, 0o600);
 context.environmentVariableCollection.persistent = false;
 context.environmentVariableCollection.description = 'Open Pi subagents in this VS Code window';
 context.environmentVariableCollection.replace('RESEARCH_PI_VSCODE_TERMINAL', JSON.stringify({ address, token }));
 const dispose = async () => {
  context.environmentVariableCollection.delete('RESEARCH_PI_VSCODE_TERMINAL');
  for (const socket of clients) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
 };
 return { dispose };
}
let bridge;
exports.activate = async context => { bridge = await startBridge(require('vscode'), context); };
exports.deactivate = async () => { await bridge?.dispose(); bridge = undefined; };
exports.startBridge = startBridge;
