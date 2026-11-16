import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { captureTerminalContext, launchTerminal } from '../.pi/lib/terminal-launcher.mjs';
import { openGhosttySshWatch } from '../.pi/lib/ghostty-ssh-bridge.mjs';
import { createDesktopTerminal } from '../.pi/lib/web-terminal.mjs';
import { attachNativeTerminal } from '../.pi/lib/native-terminal-client.mjs';

const exec = promisify(execFile);
const integration = resolve('integrations/ghostty-ssh');
const python = async (code, args = []) => await exec('python3', ['-B', '-c', `import sys\nsys.path.insert(0, sys.argv[1])\nimport bridge as b\n${code}`, integration, ...args]);
const watch = { executable: process.execPath, launcher: '/remote/Pi/bin/pi.mjs', cwd: "/remote/work tree/研究's", stateRoot: '/remote/Pi/.pi', actorId: 'pi:actor-1234' };
const token = 'a'.repeat(64);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
 const root = await mkdtemp('/tmp/rpi-g-test-');
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
async function until(check) {
 for (let i = 0; i < 150; i++) { if (await check()) return; await pause(20); }
 throw new Error('Timed out waiting for bridge fixture');
}

test('plain SSH parsing preserves connection arguments and bypasses commands/noninteractive operations', async () => {
 await python(String.raw`
assert b.parse_ssh(['host']) == ['host']
assert b.parse_ssh(['-vCp2222', '-J', 'jump', '-i', '/key with spaces', 'user@host']) == ['-v', '-C', '-p', '2222', '-J', 'jump', '-i', '/key with spaces', 'user@host']
args = ['-L', '1234:localhost:1234', '-R/tmp/a:/tmp/b', '-D1080', '-o', 'LocalForward=8080 localhost:8080', '-F', '/config file', 'host']
assert b.parse_ssh(args) == ['-F', '/config file', 'host']
assert b.parse_ssh(['--', 'user@host']) == ['--', 'user@host']
for args in [[], ['-G', 'host'], ['-N', 'host'], ['-T', 'host'], ['-f', 'host'], ['-W', 'host:22', 'jump'], ['-O', 'check', 'host'], ['host', 'uptime'], ['-o', 'RemoteCommand=foo', 'host'], ['-o', 'ClearAllForwardings=yes', 'host'], ['-p']]:
    assert b.parse_ssh(args) is None, args
plan = {'remoteSocket': '/tmp/rpi-g-r.sock', 'socket': '/tmp/rpi-g-l/bridge.sock', 'token': 'a' * 64}
original = ['-p', '2222', '-J', 'jump', 'host']
argv = b.ssh_args(plan, original)
assert argv[-6:-1] == original
assert argv[argv.index('-R') + 1] == plan['remoteSocket'] + ':' + plan['socket']
assert argv[:4] == ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
`);
});

test('watch validation, quoting, authentication, bounded deduplication and failure replies', async () => {
 await python(String.raw`
import json
from pathlib import Path
w = json.loads(sys.argv[2])
assert b.shlex.split(b.watch_command(w)) == [w['executable'], w['launcher'], 'watch', '--workspace', w['cwd'], '--state-dir', w['stateRoot'], w['actorId']]
for actor in ['antigravity:actor-123', 'codex:mission-abc:advisor', 'custom-backend:actor-123']:
    b.validate_watch({**w, 'actorId': actor})
calls = []
bridge = b.Bridge(Path('/unused'), {'token': 'a' * 64}, lambda *args: calls.append(args) or {'opened': True, 'terminalId': 'pane-1'})
request = dict(version=1, action='open-watch', id='request-1', token='a' * 64, watch=w)
assert bridge.handle(request) == bridge.handle(request)
assert len(calls) == 1
for update in [{'token': 'bad'}, {'action': 'exec'}, {'id': 'invalid\n'}, {'watch': {**w, 'actorId': 'leader'}}, {'watch': {**w, 'cwd': 'relative'}}, {'watch': {**w, 'launcher': '/pi\n'}}, {'command': 'touch /tmp/never'}]:
    try:
        bridge.handle({**request, **update})
        raise AssertionError(update)
    except ValueError:
        pass
try:
    bridge.handle({**request, 'watch': {**w, 'cwd': '/another'}})
    raise AssertionError('Request ID reuse accepted')
except ValueError:
    pass
for i in range(140):
    bridge.handle({**request, 'id': str(i)})
assert len(bridge.results) == 128
def failed(*args):
    raise RuntimeError('Automation denied')
bridge.opener = failed
assert bridge.handle({**request, 'id': 'failed'})['error'] == 'Automation denied'
`, [JSON.stringify(watch)]);
});

test('Mac split command binds the source TTY and runs only the installed local helper', async t => {
 const root = await fixture(t);
 await python(String.raw`
from pathlib import Path
from unittest.mock import patch
import json
root = Path(sys.argv[2])
w = json.loads(sys.argv[3])
w['cwd'] = "/remote/$(touch NEVER); 'quote'"
plan = {'connection': ['-p', '2222', 'alias'], 'cwd': '/local/project', 'sourceTty': '/dev/ttys017'}
def run(argv, **kwargs):
    assert argv[:2] == ['/usr/bin/osascript', '-e']
    assert argv[-1] == '/dev/ttys017'
    assert 'direction right' in argv[2] and 'every terminal whose tty' in argv[2]
    local = b.shlex.split(argv[-2])
    assert local[:3] == [sys.executable, str(b.HERE / 'bridge.py'), 'attach']
    assert str(root) in local[3]
    assert b.read_private(local[3]) == {'connection': plan['connection'], 'watch': w}
    assert w['cwd'] not in argv[2] and w['cwd'] not in argv[-2]
    return b.subprocess.CompletedProcess(argv, 0, stdout='pane-id\n')
with patch.object(b.subprocess, 'run', run):
    assert b.split_watch(root, plan, w)['terminalId'] == 'pane-id'
`, [root, JSON.stringify(watch)]);
});

test('installer is repeatable, retains startup content and restores it on uninstall', async t => {
 const root = await fixture(t);
 await python(String.raw`
from pathlib import Path
import install
root = Path(sys.argv[2])
rc = root / '.zshrc'
original = '# existing Ghostty integration\nexport KEEP_ME=yes\n'
rc.write_text(original)
target = root / "Application Support/Research Pi"
install.configure(b.HERE, rc, 'install', target)
first = rc.read_text()
install.configure(b.HERE, rc, 'install', target)
assert first == rc.read_text()
assert first.count(install.START) == 1 and original in first
assert rc.with_name('.zshrc.before-research-pi-ghostty').read_text() == original
assert (target / 'bridge.py').stat().st_mode & 0o077 == 0
install.configure(b.HERE, rc, 'uninstall', target)
assert rc.read_text() == original and not target.exists()
`, [root]);
});

test('Mac doctor reads the bundled dictionary without requiring Xcode sdef', async () => {
 await python(String.raw`
from unittest.mock import patch
def dictionary(path, **kwargs):
    assert str(path) == '/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef'
    return '<property name="tty"/><command name="split"/>'
def command(argv, **kwargs):
    assert argv == ['/usr/bin/osascript', '-e', 'tell application "Ghostty" to get version']
    return '1.4.0\n'
with patch.object(sys, 'platform', 'darwin'), patch.object(sys, 'argv', ['bridge.py', 'doctor']), \
     patch.object(b.Path, 'exists', return_value=True), \
     patch.object(b.Path, 'read_text', autospec=True, side_effect=dictionary), \
     patch.object(b.subprocess, 'check_output', side_effect=command), \
     patch.object(sys.stdin, 'isatty', return_value=False):
    assert b.main() == 0
`);
});

test('bootstrap exports the bridge without sshd AcceptEnv and cleans its own remote socket', async t => {
 const root = await fixture(t);
 await python(String.raw`
from pathlib import Path
import json
root = Path(sys.argv[2])
remote = root / "rpi-g-remote ' socket"
remote.touch()
output = root / 'argv.json'
program = root / "watch ' executable.py"
program.write_text('#!/usr/bin/env python3\nimport sys,os,json\njson.dump([sys.argv[1:],os.environ["RESEARCH_PI_GHOSTTY_SOCKET"],os.environ["RESEARCH_PI_GHOSTTY_TOKEN"]],open(sys.argv[1],"w"))\n')
program.chmod(0o700)
plan = {'remoteSocket': str(remote), 'token': 'b' * 64}
command = b.shlex.join([str(program), str(output), 'watch', '--workspace', "/work/研究 ' $(literal)"])
b.subprocess.run(b.shlex.split(b.bootstrap(plan, command)), check=True)
argv, path, token = json.loads(output.read_text())
assert argv == [str(output), 'watch', '--workspace', "/work/研究 ' $(literal)"]
assert path == str(remote) and token == 'b' * 64 and not remote.exists()
`, [root]);
});

test('physical SSH context takes bridge precedence and preserves other terminal adapters', async () => {
 const context = captureTerminalContext({ platform: 'linux', environment: { SSH_CONNECTION: 'test', TERM_PROGRAM: 'ghostty', RESEARCH_PI_GHOSTTY_SOCKET: '/tmp/rpi-g-x.sock', RESEARCH_PI_GHOSTTY_TOKEN: token } });
 assert.equal(context.provider, 'ghostty-ssh');
 assert.equal(context.error, undefined);
 assert.equal(captureTerminalContext({ environment: { TERM_PROGRAM: 'ghostty', SSH_CONNECTION: 'test' } }).error.includes('remote SSH'), true);
 assert.equal(captureTerminalContext({ environment: { TERM_PROGRAM: 'ghostty' }, platform: 'darwin' }).provider, 'ghostty');
 const result = await launchTerminal({ executable: '/bin/echo', args: [], cwd: '/tmp' }, { context });
 assert.equal(result.opened, false);
 assert.match(result.error, /only accepts subagent watch/);
});

test('Node physical client and Python bridge exchange authenticated watch requests over real private sockets', async t => {
 const root = await fixture(t), socket = join(root, 'bridge.sock');
 await writeFile(join(root, 'plan.json'), JSON.stringify({ socket, token, sourceTty: '/dev/ttys007', cwd: root, parentPid: process.pid }), { mode: 0o600 });
 const child = spawn('python3', ['-B', '-c', `import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport bridge\ndef opened(directory,plan,watch):\n (directory/'received.json').write_text(json.dumps([plan['sourceTty'],watch]))\n return {'opened':True,'terminalId':'native-pane'}\nbridge.serve(Path(sys.argv[2]),opened)`, integration, root], { stdio: ['ignore', 'pipe', 'pipe'] });
 t.after(() => child.kill());
 await until(() => stat(join(root, 'ready')).then(() => true, () => false));
 const environment = { RESEARCH_PI_GHOSTTY_SOCKET: socket, RESEARCH_PI_GHOSTTY_TOKEN: token };
 const options = { ...watch };
 const reply = await openGhosttySshWatch(options, { environment, requestId: 'integration-1' });
 assert.equal(reply.terminalId, 'native-pane');
 const received = JSON.parse(await readFile(join(root, 'received.json'), 'utf8'));
 assert.equal(received[0], '/dev/ttys007');
 assert.deepEqual(received[1], watch);
 await assert.rejects(openGhosttySshWatch(options, { environment: { ...environment, RESEARCH_PI_GHOSTTY_TOKEN: 'c'.repeat(64) } }), /authentication/);
 await chmod(socket, 0o666);
 await assert.rejects(openGhosttySshWatch(options, { environment }), /private/);
 await rm(root, { recursive: true });
 await once(child, 'exit');
});

test('bridge reply mismatch, oversized data, stale endpoints and missing replies fail with a manual fallback', async t => {
 const root = await fixture(t), socket = join(root, 'bridge.sock');
 let response;
 const server = createServer(client => client.once('data', () => { if (response) client.end(response); }));
 await new Promise(resolve => server.listen(socket, resolve));
 await chmod(socket, 0o600);
 t.after(() => server.close());
 const environment = { RESEARCH_PI_GHOSTTY_SOCKET: socket, RESEARCH_PI_GHOSTTY_TOKEN: token };
 response = JSON.stringify({ version: 1, id: 'wrong', opened: true }) + '\n';
 await assert.rejects(openGhosttySshWatch(watch, { environment }), /does not match/);
 response = 'x'.repeat(70000);
 await assert.rejects(openGhosttySshWatch(watch, { environment }), /too large/);
 response = null;
 await assert.rejects(openGhosttySshWatch(watch, { environment, timeoutMs: 30 }), /did not reply/);
 const context = captureTerminalContext({ environment });
 response = JSON.stringify({ version: 1, id: 'fallback', opened: false, error: 'Automation denied' }) + '\n';
 const result = await launchTerminal({ executable: process.execPath, args: ['/pi', 'watch'], cwd: root, watch, requestId: 'fallback' }, { context });
 assert.equal(result.opened, false);
 assert.match(result.error, /Automation denied/);
 assert.match(result.command, /watch/);
 await rm(socket);
 await assert.rejects(openGhosttySshWatch(watch, { environment }), /ENOENT/);
});

test('shell integration preserves an existing SSH function, normal argv, exit status and helper cleanup', async t => {
 const root = await fixture(t);
 const shellList = ['/bin/bash'];
 if (process.env.RESEARCH_PI_TEST_ZSH) shellList.push(process.env.RESEARCH_PI_TEST_ZSH);
 for (const shell of shellList) {
  await python(String.raw`
import pty
import json
from pathlib import Path
root = Path(sys.argv[2])
shell = sys.argv[3]
output = root / 'args.json'
dumper = root / 'dump.py'
dumper.write_text('import sys,json\njson.dump(sys.argv[2:],open(sys.argv[1],"w"))\n')
script = root / 'shell-test.sh'
script.write_text('''if [ -n "$ZSH_VERSION" ] && [ -n "$RESEARCH_PI_TEST_ZSH_MODULES" ]; then module_path=("$RESEARCH_PI_TEST_ZSH_MODULES" $module_path); fi
function ssh { python3 ''' + b.shlex.quote(str(dumper)) + ' ' + b.shlex.quote(str(output)) + ''' "$@"; return 17; }
export TERM_PROGRAM=ghostty
export RESEARCH_PI_GHOSTTY_HOME=''' + b.shlex.quote(str(b.HERE)) + '''
export RESEARCH_PI_GHOSTTY_PYTHON=''' + b.shlex.quote(sys.executable) + '''
. "$RESEARCH_PI_GHOSTTY_HOME/shell-integration.sh"
. "$RESEARCH_PI_GHOSTTY_HOME/shell-integration.sh"
# Simulate Ghostty defining its own ssh after the user's startup file.
function ssh { python3 ''' + b.shlex.quote(str(dumper)) + ' ' + b.shlex.quote(str(output)) + ''' "$@"; return 17; }
_research_pi_install_ssh_once
_research_pi_install_ssh_once
ssh -p 2222 -J jump -i '/identity file' user@alias
test "$?" = 17 || exit 91
''')
pid, fd = pty.fork()
if pid == 0:
    os = b.os
    os.execv(shell, [shell, '-f', '-i', str(script)] if shell.endswith('zsh') else [shell, '--noprofile', '--norc', '-i', str(script)])
chunks = b''
while True:
    try:
        chunk = b.os.read(fd, 4096)
        if not chunk: break
        chunks += chunk
    except OSError:
        break
_, status = b.os.waitpid(pid, 0)
b.os.close(fd)
assert b.os.waitstatus_to_exitcode(status) == 0, chunks.decode(errors='replace')
argv = json.loads(output.read_text())
assert argv[:4] == ['-o','ControlMaster=no','-o','ControlPath=none'], (argv,chunks)
assert argv[-8:-1] == ['-p','2222','-J','jump','-i','/identity file','user@alias']
local_socket = argv[argv.index('-R')+1].split(':',1)[1]
assert not Path(local_socket).parent.exists(), local_socket
`, [root, shell]);
 }
});

test('resident and nested viewers discover capabilities from the physical client without stopping its terminal', async t => {
 const root = await fixture(t);
 const keys = ['RESEARCH_PI_GHOSTTY_SOCKET', 'RESEARCH_PI_GHOSTTY_TOKEN'];
 const before = keys.map(key => process.env[key]);
 process.env[keys[0]] = '/tmp/rpi-g-physical.sock'; process.env[keys[1]] = token;
 t.after(() => keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }));
 let inputSocket, input, starts = 0, stops = 0;
 const desktop = await createDesktopTerminal({ path: join(root, 'terminal.sock'), instance: 'fixture',
  terminal: { snapshot: async () => ({ data: '', seq: 0 }), write: (_data, socket) => { inputSocket = socket; }, resize() {} }, state: () => ({}), stop() {} });
 t.after(() => desktop.close());
 const physical = { columns: 100, rows: 30, write() {}, start(fn) { input = fn; starts++; }, stop() { stops++; }, async drainInput() {} };
 const attached = attachNativeTerminal({ terminalSocket: join(root, 'terminal.sock'), instance: 'fixture' }, { terminal: physical });
 await until(() => input);
 input('fixture'); await until(() => inputSocket);
 // Host process values or later environment changes cannot retarget the client.
 delete process.env[keys[0]]; delete process.env[keys[1]];
 assert.equal((await desktop.requestAction(inputSocket, 'terminal-capabilities')).provider, 'ghostty-ssh');
 assert.equal(starts, 1); assert.equal(stops, 0);
 input('\x1d'); await attached;
 assert.equal(stops, 1);
 let forwarded;
 input = undefined; inputSocket = undefined;
 const nested = attachNativeTerminal({ terminalSocket: join(root, 'terminal.sock'), instance: 'fixture' }, { terminal: physical,
  onAction: async event => { forwarded = event; return { provider: 'ghostty-ssh' }; } });
 await until(() => input); input('fixture'); await until(() => inputSocket);
 assert.equal((await desktop.requestAction(inputSocket, 'terminal-capabilities')).provider, 'ghostty-ssh');
 assert.equal(forwarded.action, 'terminal-capabilities');
 input('\x1d'); await nested;
});

test('real OpenSSH reverse streamlocal forwarding delivers watch to the Mac helper and cleans remote state', { timeout: 20000 }, async t => {
 if (process.platform !== 'linux') return t.skip('Disposable loopback sshd fixture runs on Linux');
 try { await stat('/usr/sbin/sshd'); } catch { return t.skip('OpenSSH server is not installed'); }
 const root = await fixture(t);
 const portServer = createServer();
 await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
 const port = portServer.address().port;
 await new Promise(resolve => portServer.close(resolve));
 await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')]);
 await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'identity')]);
 const username = (await exec('id', ['-un'])).stdout.trim();
 await writeFile(join(root, 'sshd_config'), `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/identity.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${username}\nAllowStreamLocalForwarding yes\n`);
 const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
 t.after(() => daemon.kill());
 let log = ''; daemon.stderr.on('data', data => { log += data; });
 await until(() => { if (daemon.exitCode !== null) throw new Error(log); return log.includes('Server listening'); });
 const options = ['-F', '/dev/null', '-i', join(root, 'identity'), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-p', String(port), username + '@127.0.0.1'];
 const code = String.raw`
from pathlib import Path
import threading
import json
import socket
import os
root = Path(sys.argv[2])
options = json.loads(sys.argv[3])
plan = {'token': 'a' * 64, 'socket': str(root / 'mac.sock'), 'remoteSocket': str(root / 'remote.sock')}
server = socket.socket(socket.AF_UNIX)
server.bind(plan['socket'])
server.listen(1)
server.settimeout(8)
def respond():
    client,_ = server.accept()
    with client:
        request = json.loads(client.makefile('rb').readline())
        assert request['token'] == plan['token']
        assert request['watch']['cwd'] == "/research/work tree/研究's"
        client.sendall(json.dumps({'version':1,'id':request['id'],'opened':True,'terminalId':'ssh-pane'}).encode()+b'\n')
worker = threading.Thread(target=respond)
worker.start()
node = sys.argv[4]
module = sys.argv[5]
program = root / 'physical.mjs'
program.write_text("import {openGhosttySshWatch} from " + json.dumps(module) + ";\nconsole.log(JSON.stringify(await openGhosttySshWatch({launcher:'/pi/bin/pi.mjs',cwd:\"/research/work tree/研究's\",stateRoot:'/pi/.pi',actorId:'pi:actor-test'})));\n")
command = b.shlex.join([node,str(program)])
try:
    result = b.subprocess.run(['/usr/bin/ssh',*b.ssh_args(plan,options,command)],capture_output=True,text=True,timeout=12)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['terminalId'] == 'ssh-pane'
    assert not Path(plan['remoteSocket']).exists()
finally:
    server.close()
worker.join(timeout=1)
assert not worker.is_alive()
`;
 await python(code, [root, JSON.stringify(options), process.execPath, resolve('.pi/lib/ghostty-ssh-bridge.mjs')]);
});
