import { createConnection } from 'node:net';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// This runs in the physical SSH client, never in the resident Host. The socket
// is a private OpenSSH reverse streamlocal forward to that client's Mac.
export async function openGhosttySshWatch(options, { environment = process.env, requestId = randomUUID(), timeoutMs = 25000 } = {}) {
 const path = environment.RESEARCH_PI_GHOSTTY_SOCKET;
 const token = environment.RESEARCH_PI_GHOSTTY_TOKEN;
 if (!path?.startsWith('/tmp/rpi-g-') || !/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('The Ghostty SSH bridge environment is incomplete; reconnect after installing the Mac integration');
 const info = await lstat(path);
 if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('The Ghostty SSH bridge socket must be private and owned by the current user');
 const request = { version: 1, action: 'open-watch', id: requestId, token,
  watch: { executable: process.execPath, launcher: options.launcher, cwd: options.cwd, stateRoot: options.stateRoot, actorId: options.actorId } };
 return await new Promise((resolve, reject) => {
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  let buffer = '';
  const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => finish(new Error('The Mac Ghostty bridge did not reply; check Automation permissions and reconnect SSH')), timeoutMs);
  socket.on('error', error => finish(error));
  socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
  socket.on('data', data => {
   buffer += data.toString('utf8');
   if (Buffer.byteLength(buffer) > 65536) return finish(new Error('The Ghostty bridge reply is too large'));
   const end = buffer.indexOf('\n');
   if (end < 0) return;
   try {
    const reply = JSON.parse(buffer.slice(0, end));
    if (reply.id !== requestId || reply.version !== 1) throw new Error('The Ghostty bridge reply does not match this request');
    if (!reply.opened) throw new Error(reply.error || 'The Mac could not open a Ghostty split');
    finish(null, { split: true, terminalId: reply.terminalId });
   } catch (error) { finish(error); }
  });
  socket.on('end', () => { if (!socket.destroyed) finish(new Error('The Ghostty bridge closed before replying')); });
 });
}
