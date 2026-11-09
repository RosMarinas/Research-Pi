import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_ADVISOR_PROFILE, CODEX_FULL_ACCESS_PROFILE, codexPermissionProfile } from '../.pi/lib/project-boundary.mjs';
import { buildAntigravityRunnerArgs, createSubagentSessionManager } from '../.pi/lib/subagent-sessions.mjs';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/pi.mjs', import.meta.url));
const core = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));

async function launch(t, args = [], overrides = {}) {
 const root = await mkdtemp(join(tmpdir(), 'pi-launch-permissions-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const coreStub = join(root, 'core.mjs');
 const residentStub = join(root, 'resident.mjs');
 const preload = join(root, 'preload.mjs');
 await writeFile(coreStub, `process.stdout.write(JSON.stringify({
  kind: 'core', fullAccess: process.env.RESEARCH_PI_FULL_ACCESS,
  sessionMode: process.env.RESEARCH_PI_INITIAL_SESSION_MODE, args: process.argv.slice(2)
 }));`);
 await writeFile(residentStub, `let stopped = false;
 export async function findNativeRuntime() {
  return process.env.PI_TEST_RESIDENT === '1' && !stopped ? { state: { sessionId: 'existing-session' } } : null;
 }
 export async function stopNativeRuntime() { stopped = true; }
 export async function launchNativeRuntime(options) {
  process.stdout.write(JSON.stringify({ kind: 'resident', fullAccess: options.env.RESEARCH_PI_FULL_ACCESS,
   analysis: options.analysis, args: options.args, stopped, hasSessionOptions: options.hasSessionOptions }));
 }`);
 // Exercise the real launcher while replacing only the actual Core/Host startup.
 // Configuration and state stay in this fixture; no model or live Host is used.
 await writeFile(preload, `import childProcess from 'node:child_process';
 import { registerHooks, syncBuiltinESMExports } from 'node:module';
 const spawn = childProcess.spawn;
 childProcess.spawn = (command, args, options) => spawn(command,
  args[0] === ${JSON.stringify(core)} ? [${JSON.stringify(coreStub)}, ...args.slice(1)] : args, options);
 syncBuiltinESMExports();
 registerHooks({ resolve(specifier, context, next) {
  return specifier.endsWith('/native-runtime-launcher.mjs')
   ? { url: ${JSON.stringify(pathToFileURL(residentStub).href)}, shortCircuit: true } : next(specifier, context);
 } });`);
 const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('RESEARCH_PI_') && !name.startsWith('PI_RESEARCH_') && !['PI_CODING_AGENT_DIR', 'PI_TRACE_DIR'].includes(name)));
 const { stdout } = await execute(process.execPath, ['--import', preload, launcher, ...args, '--workspace', root, '--no-web'], {
  cwd: root, timeout: 15_000,
  env: { ...environment, RESEARCH_PI_DEV_MODE: '0', RESEARCH_PI_CONFIG_DIR: join(root, 'config'),
   RESEARCH_PI_STATE_DIR: join(root, 'state'), ...overrides },
 });
 return JSON.parse(stdout);
}

const cases = [
 { name: 'default', args: [], env: {}, fullAccess: '1' },
 { name: 'environment opt-out', args: [], env: { RESEARCH_PI_FULL_ACCESS: '0' }, fullAccess: '0' },
 { name: 'explicit enable overrides environment', args: ['--full-access'], env: { RESEARCH_PI_FULL_ACCESS: '0' }, fullAccess: '1' },
 { name: 'explicit disable overrides inherited full access', args: ['--no-full-access'], env: { RESEARCH_PI_FULL_ACCESS: '1' }, fullAccess: '0' },
 { name: 'last flag disables', args: ['--full-access', '--no-full-access'], env: {}, fullAccess: '0' },
 { name: 'last flag enables', args: ['--no-full-access', '--full-access'], env: {}, fullAccess: '1' },
];

for (const restart of [false, true]) for (const scenario of cases) {
 test(`${restart ? 'pi restart' : 'pi'}: ${scenario.name}`, async t => {
  const result = await launch(t, [...(restart ? ['restart'] : []), ...scenario.args], {
   ...scenario.env, PI_TEST_RESIDENT: restart ? '1' : '0',
  });
  assert.equal(result.fullAccess, scenario.fullAccess);
  assert.equal(result.kind, restart ? 'resident' : 'core');
  assert.ok(!result.args.includes('--full-access') && !result.args.includes('--no-full-access'), 'Core must not receive launcher flags');
  if (restart) {
   assert.equal(result.stopped, true);
   assert.equal(result.args[result.args.indexOf('--session') + 1], 'existing-session', 'restart preserves the Session');
  }
 });
}

test('explicit sandbox selection is a resident launch option', async t => {
 const result = await launch(t, ['--resident-runtime', '--no-full-access']);
 assert.equal(result.fullAccess, '0');
 assert.equal(result.hasSessionOptions, true, 'an existing Host must not silently ignore the access flag');
});

for (const restart of [false, true]) test(`Analysis role survives ${restart ? 'restart' : 'launch'} with default full access`, async t => {
 const result = await launch(t, [...(restart ? ['restart'] : []), '--analysis']);
 if (restart) assert.equal(result.analysis, true);
 else assert.equal(result.sessionMode, 'analysis');
});

test('Codex and Antigravity advisor permissions remain restricted under full access', () => {
 assert.equal(codexPermissionProfile('executor', { fullAccess: true }), CODEX_FULL_ACCESS_PROFILE);
 assert.equal(codexPermissionProfile('advisor', { fullAccess: true }), CODEX_ADVISOR_PROFILE);
 const executor = buildAntigravityRunnerArgs({ role: 'environment', fullAccess: true });
 assert.ok(!executor.includes('--sandbox'));
 assert.ok(executor.includes('--dangerously-skip-permissions'));
 const bounded = buildAntigravityRunnerArgs({ role: 'environment', fullAccess: false });
 assert.ok(bounded.includes('--sandbox'));
 const advisor = buildAntigravityRunnerArgs({ role: 'advisor', fullAccess: true });
 assert.ok(advisor.includes('--sandbox'));
 assert.equal(advisor[advisor.indexOf('--mode') + 1], 'plan');
 assert.ok(!advisor.includes('--dangerously-skip-permissions'));
});

for (const [role, fullAccess, expected] of [['general', true, '1'], ['general', false, '0'], ['advisor', true, '0']]) {
 test(`Pi ${role} child access with fullAccess=${fullAccess}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let childEnvironment;
  const manager = createSubagentSessionManager({ stateRoot: root, spawn: (command, args, options) => {
   childEnvironment = options.env;
   const child = new EventEmitter();
   child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
   child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
   return child;
  } });
  try {
   await manager.start({ actorId: 'pi:permissions', backend: 'pi', role, fullAccess, cwd: root, task: 'Inspect the assigned scope.' });
   assert.equal(childEnvironment.RESEARCH_PI_FULL_ACCESS, expected);
   assert.equal(childEnvironment.RESEARCH_PI_INITIAL_SESSION_MODE, role === 'advisor' ? 'analysis' : 'project');
  } finally { await manager.dispose(); }
 });
}
