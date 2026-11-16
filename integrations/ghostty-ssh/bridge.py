#!/usr/bin/env python3
"""Private per-SSH Ghostty bridge. Python standard library only; no PTY proxy."""
import argparse
import collections
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
LIMIT = 32768
SCRIPT = '''on run argv
tell application "Ghostty"
set cfg to new surface configuration
set initial working directory of cfg to item 1 of argv
set command of cfg to item 2 of argv
set wait after command of cfg to true
set sources to every terminal whose tty is (item 3 of argv)
if (count of sources) is not 1 then error "The requesting Ghostty pane could not be identified by its TTY"
set createdTerminal to split (item 1 of sources) direction right with configuration cfg
focus createdTerminal
return id of createdTerminal
end tell
end run'''


def private_json(path, value):
    with open(path, 'x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream)


def read_private(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Bridge state must be a private file owned by you')
    return json.loads(Path(path).read_text())


def parse_ssh(args):
    """Only plain interactive logins are augmented. All other calls pass through.

    Keep original argv verbatim; collect connection options separately so a
    second watch connection does not replay explicit port-forward arguments.
    """
    takes_value = set('BbcDEeFIiJLlmOoPpRSWw')
    flags = set('46AaCfGgKkMNnqsTtVvXxYyZ')
    blocked = set('fGMNnOQsTVWw')
    connection = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == '--':
            if i + 2 != len(args):
                return None
            return connection + ['--', args[i + 1]]
        if not arg.startswith('-') or arg == '-':
            return connection + [arg] if i + 1 == len(args) else None
        if arg.startswith('--') or arg == '-':
            return None
        index = 1
        while index < len(arg):
            flag = arg[index]
            if flag in blocked:
                return None
            if flag in takes_value:
                value = arg[index + 1:]
                if not value:
                    i += 1
                    if i == len(args):
                        return None
                    value = args[i]
                if flag == 'o':
                    key = re.split(r'[=\s]', value, maxsplit=1)[0].lower()
                    if key in {'remotecommand', 'sessiontype', 'requesttty', 'forkafterauthentication', 'stdinnull', 'controlpersist', 'clearallforwardings'}:
                        return None
                    if key not in {'localforward', 'remoteforward', 'dynamicforward'}:
                        connection += ['-o', value]
                elif flag not in 'LDR':
                    connection += ['-' + flag, value]
                break
            if flag not in flags:
                return None
            connection.append('-' + flag)
            index += 1
        i += 1
    return None


def validate_watch(watch):
    if not isinstance(watch, dict) or set(watch) != {'executable', 'launcher', 'cwd', 'stateRoot', 'actorId'}:
        raise ValueError('Only a structured Pi watch request is accepted')
    for key in ('executable', 'launcher', 'cwd', 'stateRoot'):
        value = watch[key]
        if not isinstance(value, str) or not value.startswith('/') or len(value) > 4096 or any(c in value for c in '\x00\r\n'):
            raise ValueError('Watch paths must be absolute remote paths')
    if not isinstance(watch['actorId'], str) or len(watch['actorId']) > 192 or not re.fullmatch(r'[a-z][a-z0-9._-]*:[a-z0-9._:-]+', watch['actorId']):
        raise ValueError('A concrete subagent actor ID is required')
    return watch


def watch_command(watch):
    validate_watch(watch)
    return shlex.join([watch['executable'], watch['launcher'], 'watch', '--workspace', watch['cwd'],
                       '--state-dir', watch['stateRoot'], watch['actorId']])


def bootstrap(plan, command=None):
    remote = plan['remoteSocket']
    # Keep an outer shell solely to unlink this session's remote socket on exit.
    body = 'export RESEARCH_PI_GHOSTTY_SOCKET={} RESEARCH_PI_GHOSTTY_TOKEN={}; '.format(
        shlex.quote(remote), shlex.quote(plan['token']))
    cleanup = 'rm -f -- ' + shlex.quote(remote)
    body += 'trap {} EXIT; '.format(shlex.quote(cleanup))
    body += (command if command else '"${SHELL:-/bin/sh}" -l')
    body += '; exit $?'
    return shlex.join(['/bin/sh', '-c', body])


def ssh_args(plan, original, command=None):
    # A private transport cannot outlive its client via an existing multiplexed
    # master. Existing host aliases, keys, ProxyJump, port and user still apply.
    return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes',
            '-t', '-R', plan['remoteSocket'] + ':' + plan['socket'], *original, bootstrap(plan, command)]


def create_plan(args, parent_pid, source_tty, command=None):
    connection = parse_ssh(args)
    if connection is None:
        raise ValueError('This SSH invocation is not an interactive login')
    directory = Path(tempfile.mkdtemp(prefix='rpi-g-', dir='/tmp'))
    os.chmod(directory, 0o700)
    plan = {'token': secrets.token_hex(32), 'socket': str(directory / 'bridge.sock'),
            'remoteSocket': '/tmp/rpi-g-' + secrets.token_hex(12) + '.sock',
            'sourceTty': source_tty, 'cwd': os.getcwd(), 'connection': connection,
            'parentPid': parent_pid}
    private_json(directory / 'plan.json', plan)
    argv = ssh_args(plan, args, command)
    with open(directory / 'argv', 'xb') as stream:
        os.chmod(stream.name, 0o600)
        stream.write(b''.join(os.fsencode(arg) + b'\0' for arg in argv))
    try:
        with open(directory / 'bridge.log', 'xb') as log:
            os.chmod(log.name, 0o600)
            process = subprocess.Popen([sys.executable, str(HERE / 'bridge.py'), 'serve', str(directory)],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(150):
            if (directory / 'ready').exists():
                return directory
            if process.poll() is not None:
                break
            time.sleep(0.02)
        raise RuntimeError('The local Ghostty bridge did not start')
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def split_watch(directory, plan, watch):
    launch = directory / ('watch-' + secrets.token_hex(12) + '.json')
    private_json(launch, {'connection': plan['connection'], 'watch': validate_watch(watch)})
    # Remote input can select remote Pi paths, never a local executable or an
    # AppleScript fragment. Only this installed helper runs on the Mac.
    command = shlex.join([sys.executable, str(HERE / 'bridge.py'), 'attach', str(launch)])
    try:
        result = subprocess.run(['/usr/bin/osascript', '-e', SCRIPT, plan['cwd'], command, plan['sourceTty']],
                                text=True, capture_output=True, timeout=20, check=True)
        return {'opened': True, 'terminalId': result.stdout.strip()}
    except subprocess.CalledProcessError as error:
        launch.unlink(missing_ok=True)
        raise RuntimeError('Ghostty Automation failed: ' + error.stderr.strip()[:1500]) from error
    except BaseException:
        launch.unlink(missing_ok=True)
        raise


class Bridge:
    def __init__(self, directory, plan, opener=split_watch):
        self.directory, self.plan, self.opener = directory, plan, opener
        self.results = collections.OrderedDict()

    def handle(self, request):
        if not isinstance(request, dict) or not isinstance(request.get('token'), str) or not hmac.compare_digest(request['token'], self.plan['token']):
            raise ValueError('Invalid bridge authentication')
        if request.get('version') != 1 or request.get('action') != 'open-watch' or set(request) != {'version', 'action', 'id', 'token', 'watch'}:
            raise ValueError('Unsupported bridge request')
        request_id = request.get('id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,200}', request_id):
            raise ValueError('Invalid request ID')
        validate_watch(request.get('watch'))
        fingerprint = json.dumps(request['watch'], sort_keys=True)
        if request_id in self.results:
            previous, result = self.results[request_id]
            if previous != fingerprint:
                raise ValueError('Request ID reused for a different watch')
            return result
        try:
            result = {'version': 1, 'id': request_id, **self.opener(self.directory, self.plan, request['watch'])}
        except Exception as error:
            result = {'version': 1, 'id': request_id, 'opened': False, 'error': str(error)[:2000]}
        self.results[request_id] = fingerprint, result
        while len(self.results) > 128:
            self.results.popitem(last=False)
        return result


def serve(directory, opener=split_watch):
    plan = read_private(directory / 'plan.json')
    server = socket.socket(socket.AF_UNIX)
    try:
        server.bind(plan['socket'])
        os.chmod(plan['socket'], 0o600)
        server.listen(8)
        server.settimeout(1)
        bridge = Bridge(directory, plan, opener)
        (directory / 'ready').touch(mode=0o600)
        while directory.exists():
            try:
                os.kill(plan['parentPid'], 0)
            except ProcessLookupError:
                break
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            with client:
                client.settimeout(2)
                data = b''
                request = None
                try:
                    while b'\n' not in data:
                        chunk = client.recv(4096)
                        if not chunk:
                            raise ValueError('Incomplete bridge request')
                        data += chunk
                        if len(data) > LIMIT:
                            raise ValueError('Bridge request too large')
                    request = json.loads(data.split(b'\n', 1)[0])
                    result = bridge.handle(request)
                except Exception as error:
                    result = {'version': 1, 'id': request.get('id') if isinstance(request, dict) else None,
                              'opened': False, 'error': str(error)[:2000]}
                try:
                    client.sendall(json.dumps(result).encode() + b'\n')
                except OSError:
                    pass
    finally:
        server.close()
        shutil.rmtree(directory, ignore_errors=True)


def attach(path):
    launch = read_private(path)
    Path(path).unlink()
    command = watch_command(launch['watch'])
    source_tty = os.ttyname(sys.stdin.fileno())
    directory = create_plan(launch['connection'], os.getpid(), source_tty, command)
    try:
        with open(directory / 'argv', 'rb') as stream:
            argv = [os.fsdecode(arg) for arg in stream.read().split(b'\0')[:-1]]
        # Inherited descriptors preserve OpenSSH's native TTY and key protocol.
        return subprocess.call(['/usr/bin/ssh', *argv])
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'serve', 'attach', 'cleanup', 'doctor'])
    parser.add_argument('args', nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    if opts.action == 'prepare':
        parent, tty, *args = opts.args
        if parse_ssh(args) is None:
            return 2  # Shell integration silently invokes the original command.
        print(create_plan(args, int(parent), tty))
    elif opts.action == 'serve':
        serve(Path(opts.args[0]))
    elif opts.action == 'attach':
        return attach(opts.args[0])
    elif opts.action == 'cleanup':
        directory = Path(opts.args[0])
        if directory.parent != Path('/tmp') or not directory.name.startswith('rpi-g-'):
            raise ValueError('Invalid bridge directory')
        read_private(directory / 'plan.json')
        shutil.rmtree(directory)
    else:
        if sys.platform != 'darwin':
            raise RuntimeError('Run doctor on the Mac inside Ghostty')
        app = [str(path) for path in (Path('/Applications/Ghostty.app'), Path.home() / 'Applications/Ghostty.app') if path.exists()]
        if not app:
            app = subprocess.check_output(['/usr/bin/mdfind', 'kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"'], text=True).splitlines()
        if not app:
            raise RuntimeError('Ghostty.app was not found')
        dictionary = subprocess.check_output(['/usr/bin/sdef', app[0]], text=True)
        if 'name="tty"' not in dictionary or 'name="split"' not in dictionary:
            raise RuntimeError('Upgrade Ghostty: its AppleScript dictionary needs terminal tty and split support')
        version = subprocess.check_output(['/usr/bin/osascript', '-e', 'tell application "Ghostty" to get version'], text=True)
        if sys.stdin.isatty():
            probe = '''on run argv
tell application "Ghostty"
set sources to every terminal whose tty is (item 1 of argv)
if (count of sources) is not 1 then error "Run the installer from a local Ghostty pane on this Mac"
return id of item 1 of sources
end tell
end run'''
            subprocess.check_output(['/usr/bin/osascript', '-e', probe, os.ttyname(sys.stdin.fileno())], text=True)
        print('Ghostty ' + version.strip() + ': native split API available. SSH reverse streamlocal forwarding must be allowed by the server.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('Research Pi Ghostty: ' + str(error), file=sys.stderr)
        sys.exit(1)
