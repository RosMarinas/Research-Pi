import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
 buildSandboxRuntimeConfig, codexPermissionConfigArguments, codexRuntimePolicy,
 projectSandboxSpawn, projectTemporaryEnvironment, resolveExecutablePath,
 resolveSandboxDependencies, runCodexSandboxPreflight, sanitizeBoundaryEnvironment,
} from '../.pi/lib/project-boundary.mjs';

const execute = promisify(execFile);
async function executeSandbox(command, args, options) {
 try { return await execute(command, args, options); }
 catch (error) { throw new Error(`Sandbox exited ${error.code}: ${error.stderr || 'no stderr'}`); }
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const runtime = { root: '/home/test/project', runtimeTmp: '/home/test/project/tmp/pi' };

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-boundary-test-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}

test('Linux mount repair preserves the script and restores scratch before credential masks', () => {
 const socket = '/tmp/pi-proxy.sock';
 const script = "printf '%s\\n' 'a b' \"$(printf quoted)\"; # --ro-bind stays script data";
 const original = ['bwrap', '--bind', socket, socket, '--ro-bind', '/', '/',
  '--bind', runtime.runtimeTmp, runtime.runtimeTmp, '--tmpfs', '/home',
  '--ro-bind', runtime.root, runtime.root, '--ro-bind', '/dev/null', join(runtime.runtimeTmp, '.env'),
  '--tmpfs', '/tmp', '--unshare-user', '--cap-drop', 'ALL', '--', '/bin/sh', '-c', script];
 const wrapped = { argv: ['/bin/sh', '-c', original.map(quote).join(' ')], env: {} };
 const result = projectSandboxSpawn(wrapped, runtime, { platform: 'linux', networkSockets: [socket, socket] });
 assert.equal(result.argv.at(-1), script);
 const rootMount = result.argv.indexOf(runtime.root);
 assert.deepEqual(result.argv.slice(rootMount + 2, rootMount + 5), ['--bind', runtime.runtimeTmp, runtime.runtimeTmp]);
 assert.ok(result.argv.indexOf('/dev/null') > rootMount + 5, 'credential masks remain above the scratch bind');
 assert.deepEqual(result.argv.slice(-7, -4), ['--bind', socket, socket]);
 assert.ok(result.argv.includes('--cap-drop'), 'capability restrictions survive the repair');
 assert.deepEqual(wrapped.argv, ['/bin/sh', '-c', original.map(quote).join(' ')], 'input is unchanged');
});

test('mount repair rejects unknown wrappers, unbound sockets, and external scratch', () => {
 assert.throws(() => projectSandboxSpawn({ argv: ['sh', '-c', 'echo unconfined'] }, runtime, { platform: 'linux' }), /Unexpected Linux/);
 const wrapped = { argv: ['sh', '-c', ['bwrap', '--', '/bin/sh', '-c', 'true'].map(quote).join(' ')] };
 assert.throws(() => projectSandboxSpawn(wrapped, runtime, { platform: 'linux', networkSockets: ['/tmp/unbound'] }), /not present/);
 assert.throws(() => projectSandboxSpawn(wrapped, { ...runtime, runtimeTmp: '/tmp/outside' }, { platform: 'linux' }), /inside the project/);
 assert.equal(projectSandboxSpawn(wrapped, runtime, { platform: 'darwin' }), wrapped);
});

test('npm Codex can read its hoisted native package without granting the home directory', async t => {
 const root = await fixture(t);
 const packageRoot = join(root, 'node_modules/@openai/codex');
 const nativeRoot = join(root, 'node_modules/@openai/codex-linux-x64');
 await mkdir(join(packageRoot, 'bin'), { recursive: true });
 await mkdir(nativeRoot, { recursive: true });
 const bin = join(packageRoot, 'bin/codex.js');
 await writeFile(bin, '// fixture');
 await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', optionalDependencies: { '@openai/codex-linux-x64': '*' } }));
 await writeFile(join(nativeRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-linux-x64' }));
 const policy = codexRuntimePolicy({ readRoots: ['/trusted/runtime'] }, bin);
 assert.ok(policy.readRoots.includes(bin));
 assert.ok(policy.readRoots.includes(packageRoot));
 assert.ok(policy.readRoots.includes(nativeRoot));
 assert.ok(!policy.readRoots.includes(root));
 assert.ok(!policy.readRoots.includes(dirname(root)));
 assert.ok(policy.readRoots.includes('/trusted/runtime'));
});

test('a standalone Codex binary grants only its exact path', async t => {
 const root = await fixture(t);
 const bin = join(root, 'codex');
 assert.deepEqual(codexRuntimePolicy({}, bin).readRoots, [bin]);
});

const live = process.platform === 'linux' && process.env.RESEARCH_PI_TEST_SANDBOX === '1';
const checkFiles = `import os
from pathlib import Path
assert Path('source.txt').read_text() == 'source fixture'
for path in [Path('.env'), Path(os.environ['TMPDIR']) / '.env', Path('.aws/credentials'), Path('.codex/auth.json'), Path('.config/gh/hosts.yml'), Path('.docker/config.json')]:
    try: credential = path.read_text()
    except OSError: pass
    else: assert credential != 'credential fixture'
scratch = Path(os.environ['TMPDIR']) / 'scratch-check'
scratch.write_text('scratch fixture')
assert scratch.read_text() == 'scratch fixture'
scratch.unlink()
if os.environ['PROBE_ACCESS'] == 'read':
    try: Path('source.txt').write_text('unexpected write')
    except OSError: pass
    else: raise AssertionError('Analysis source became writable')
try: Path('.git/hooks/boundary-test').write_text('unexpected hook')
except OSError: pass
else: raise AssertionError('Git hooks became writable')
print('filesystem-boundary=ok')`;

async function projectFixture(t) {
 // System temp is intentionally hidden by the production sandbox. Use an
 // isolated home fixture so the integration test models a normal checkout.
 const scratch = join(homedir(), '.cache/research-pi-sandbox-tests');
 await mkdir(scratch, { recursive: true });
 const root = await mkdtemp(join(scratch, 'boundary-test-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const runtimeTmp = join(root, 'tmp/pi');
 await mkdir(runtimeTmp, { recursive: true });
 await execute('git', ['init', '-q', root]);
 await writeFile(join(root, 'source.txt'), 'source fixture');
 await writeFile(join(root, '.env'), 'credential fixture');
 await writeFile(join(runtimeTmp, '.env'), 'credential fixture');
 return { root, runtimeTmp };
}

test('live Pi Analysis and executor keep filesystem boundaries and can use the network', { skip: !live }, async t => {
 const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
 const project = await projectFixture(t);
 const savedCwd = process.cwd();
 process.chdir(project.root);
 t.after(() => process.chdir(savedCwd));
 const helperRoot = await realpath(fileURLToPath(new URL('../node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp', import.meta.url)));
 const server = createServer((_request, response) => response.end('network-boundary=ok\n'));
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 const saved = process.env.CLAUDE_CODE_TMPDIR;
 process.env.CLAUDE_CODE_TMPDIR = project.runtimeTmp;
 t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = saved; });
 for (const access of ['read', 'write']) {
  let networkAllowed = false;
  try {
   await SandboxManager.initialize({
    ...buildSandboxRuntimeConfig(project.root, {}, { readRoots: [helperRoot] }, { access, runtimeTmp: project.runtimeTmp }),
    ...await resolveSandboxDependencies(),
   }, async () => { networkAllowed = true; return true; }, false);
   const command = `set -eu\nPROBE_ACCESS=${access} python3 - <<'PY'\n${checkFiles}\nPY\ncurl --noproxy '' -fsS --max-time 10 http://127.0.0.1:${server.address().port}/`;
   const generated = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh', undefined, undefined, project.root);
   const wrapped = projectSandboxSpawn(generated, project, {
    networkSockets: [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()],
   });
   const result = await executeSandbox(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: project.root, timeout: 20_000,
    env: { ...sanitizeBoundaryEnvironment({ ...process.env, ...wrapped.env }), ...projectTemporaryEnvironment(project.runtimeTmp) },
   });
   assert.match(result.stdout, /filesystem-boundary=ok/);
   assert.match(result.stdout, /network-boundary=ok/);
   assert.equal(networkAllowed, true, `${access} network request reached the approval callback`);
  } finally { SandboxManager.cleanupAfterCommand(); await SandboxManager.reset(); }
 }
});

test('live Codex advisor and executor can re-exec, use scratch, and enforce source and hook permissions', { skip: !live }, async t => {
 const project = await projectFixture(t);
 const codexBin = await resolveExecutablePath('codex');
 const policy = codexRuntimePolicy({}, codexBin);
 // Both missing and populated credential directories must produce valid mounts.
 for (const mode of ['advisor', 'executor']) {
  assert.equal((await runCodexSandboxPreflight({ codexBin, mode, cwd: project.root, runtimeTmp: project.runtimeTmp })).ok, true);
 }
 for (const relative of ['.aws/credentials', '.codex/auth.json', '.config/gh/hosts.yml', '.docker/config.json']) {
  await mkdir(dirname(join(project.root, relative)), { recursive: true });
  await writeFile(join(project.root, relative), 'credential fixture');
 }
 for (const mode of ['advisor', 'executor']) {
  const access = mode === 'advisor' ? 'read' : 'write';
  const command = `set -eu\nPROBE_ACCESS=${access} python3 - <<'PY'\n${checkFiles}\nPY\n` +
   (mode === 'executor' ? 'git add source.txt\ngit -c user.name="Boundary Test" -c user.email="test@research-pi.invalid" commit -q -m "permission fixture"\ngit rev-parse --verify HEAD >/dev/null\n' : '');
  const result = await executeSandbox(codexBin, [
   ...codexPermissionConfigArguments(mode, project.root, project.runtimeTmp, null, policy),
   'sandbox', '-P', mode === 'advisor' ? 'research_pi_advisor' : 'research_pi_executor',
   '-C', project.root, '/bin/sh', '-c', command,
  ], { cwd: project.root, timeout: 20_000,
   env: { ...sanitizeBoundaryEnvironment(process.env), ...projectTemporaryEnvironment(project.runtimeTmp) } });
  assert.match(result.stdout, /filesystem-boundary=ok/);
  const probe = await runCodexSandboxPreflight({ codexBin, mode, cwd: project.root, runtimeTmp: project.runtimeTmp });
  assert.equal(probe.ok, true);
 }
});
