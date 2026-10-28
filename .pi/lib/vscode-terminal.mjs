import { createConnection } from 'node:net';

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

export async function openVsCodeTerminal(options, { environment, exec, platform }) {
 if (!environment.RESEARCH_PI_VSCODE_TERMINAL) throw new Error('Install Research Pi Terminal in VS Code, then create a new integrated terminal for the Leader. Or use “Switch in this terminal”.');
 const { address, token } = JSON.parse(environment.RESEARCH_PI_VSCODE_TERMINAL);
 const ancestors = await terminalAncestors(exec, platform);
 return await new Promise((resolve, reject) => {
  const socket = createConnection(address); let buffer = '', received = false;
  socket.setTimeout(5000, () => socket.destroy(new Error('VS Code terminal bridge did not respond; reopen the Leader integrated terminal after reloading VS Code')));
  socket.on('error', reject);
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'watch', token, node: process.execPath, ...options, ancestors }) + '\n'));
  socket.on('data', chunk => {
   buffer += chunk;
   if (!buffer.includes('\n')) return;
   try { const result = JSON.parse(buffer.slice(0,buffer.indexOf('\n'))); received = true; resolve(result); socket.end(); }
   catch(error) { socket.destroy(error); }
  });
  socket.on('close', () => { if (!received) reject(new Error('VS Code terminal bridge disconnected')); });
 });
}
