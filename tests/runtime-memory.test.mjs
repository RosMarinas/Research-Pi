import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { indexSessionHistory, openLazySession } from '../.pi/lib/lazy-session-history.mjs';
import { createProviderIdleReclaimer, installPresentationWindow } from '../.pi/lib/runtime-memory.mjs';
import { createRuntimeLedgerCache } from '../.pi/lib/runtime-ledger-cache.mjs';
import { idleSubagentCandidates } from '../.pi/lib/subagent-idle.mjs';
import { retainEvent } from '../.pi/lib/runtime-memory-policy.mjs';
import { createSubagentActivityWriter } from '../.pi/lib/subagent-activity.mjs';
import { CodexActivityCursor } from '../.pi/lib/codex-activity.mjs';
import { createSubagentSessionManager } from '../.pi/lib/subagent-sessions.mjs';
import { spawn } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { createSubagentOwners } from '../.pi/lib/subagent-owners.mjs';
import { registerSubagentRuntimeAdapter, getSubagentRuntimeAdapter } from '../.pi/lib/research-runtime-adapters.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFile = promisify(execFileCallback);
async function until(check, timeout = 3000) {
 const end = Date.now() + timeout;
 while (!check()) { assert.ok(Date.now() < end, 'timed out'); await pause(5); }
}
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-memory-test-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: Date.now() });

test('lazy history preserves compaction, branch labels, exact entries and append behavior with bounded cache', async t => {
 const root = await fixture(t), original = SessionManager.create(root, join(root, 'sessions'));
 const first = original.appendMessage({ role: 'user', content: 'Initial question', timestamp: Date.now() });
 for (let i = 0; i < 60; i++) original.appendMessage(assistant('historical 科研 output ' + 'x'.repeat(12000)));
 original.appendLabelChange(first, 'research origin');
 original.appendCompaction('Earlier work was summarized; preserve the current experiment.', undefined, 200000);
 original.appendMessage({ role: 'user', content: 'Continue from the checkpoint', timestamp: Date.now() });
 original.appendMessage(assistant('Current response'));
 const path = original.getSessionFile(), before = await readFile(path);
 const lazy = openLazySession(SessionManager, path, join(root, 'sessions'), undefined, { cacheBytes: 32 * 1024 });
 assert.deepEqual(lazy.buildSessionContext(), original.buildSessionContext());
 assert.equal(lazy.getLabel(first), 'research origin');
 assert.ok(lazy.historyCache.stats().loads < 15, 'summarized message bodies stay unloaded during projection');
 for (let i = 0; i < original.getEntries().length; i++) assert.equal(JSON.stringify(lazy.getEntries()[i]), JSON.stringify(original.getEntries()[i]));
 assert.ok(lazy.historyCache.stats().cachedBytes <= 32 * 1024);
	assert.deepEqual(structuredClone(lazy.getEntries()), JSON.parse(JSON.stringify(original.getEntries())));
 assert.deepEqual(await readFile(path), before, 'opening and reading never rewrites history');
 lazy.appendMessage({ role: 'user', content: 'New question', timestamp: Date.now() });
 assert.deepEqual(lazy.buildSessionContext(), SessionManager.open(path).buildSessionContext());
 lazy.branch(first);
 assert.equal(lazy.buildSessionContext().messages.some(m => JSON.stringify(m).includes('Current response')), false);
});

test('lazy history rejects replaced/truncated backing files and falls back for legacy/unterminated history', async t => {
 const root = await fixture(t), path = join(root, 'history.jsonl');
 const header = { type: 'session', version: 3, id: 'fixture', cwd: root };
 await writeFile(path, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'custom', id: 'entry', parentId: null, data: 'preserved' }) + '\n');
 const indexed = indexSessionHistory(path, { cacheBytes: 0 });
 await writeFile(path, JSON.stringify(header) + '\n');
 assert.throws(() => indexed.entries[1].data, /changed|truncated/);
 await writeFile(path, JSON.stringify({ ...header, version: 2 }) + '\n');
 assert.equal(indexSessionHistory(path), null);
 await writeFile(path, JSON.stringify(header));
 assert.equal(indexSessionHistory(path), null);
});

test('provider release requires idle/unobserved state and gates a racing new run', async () => {
 let time = 0, idle = true, calls = 0, finish;
 const provider = { closeSession: async id => { assert.equal(id, 'session-one'); calls++; await new Promise(resolve => { finish = resolve; }); } };
 const pool = createProviderIdleReclaimer({ idleMs: 10, idle: () => idle, sessionId: () => 'session-one', provider: () => provider, clock: () => time });
 time = 11; idle = false; assert.equal(await pool.sweep(), false);
 idle = true; const closing = pool.sweep(); await until(() => calls === 1);
 let started = false; const run = pool.beforeRun().then(() => { started = true; });
 await pause(5); assert.equal(started, false);
 finish(); await closing; await run; assert.equal(started, true);
 assert.equal(await pool.sweep(), false, 'new run reset idle clock');
 await pool.stop(); time = 100; assert.equal(await pool.sweep(), false);
});

test('history window bounds presentation while keeping active tool widgets and source entries', async () => {
 const rendered = [], fullEntries = Array.from({ length: 100 }, (_, id) => ({ id }));
 const pending = { active: true };
 const mode = { session: { isIdle: true }, chatContainer: { children: [] }, pendingTools: new Map(),
  renderSessionEntries(items) { rendered.push(items); }, async handleEvent() {}, rebuildChatFromMessages() { this.renderSessionEntries(fullEntries); } };
 const window = installPresentationWindow(mode, { entries: 10, components: 10 });
 mode.renderSessionEntries(fullEntries); assert.equal(rendered[0].length, 10); assert.equal(fullEntries.length, 100);
 mode.chatContainer.children = Array.from({ length: 80 }, (_, id) => ({ id }));
 mode.chatContainer.children[5] = pending; mode.pendingTools.set('call', pending);
 await mode.handleEvent({}); assert.ok(mode.chatContainer.children.includes(pending));
 mode.pendingTools.clear(); await mode.handleEvent({}); assert.ok(mode.chatContainer.children.length <= 40);
 window.set(0); assert.equal(rendered.at(-1).length, 100);
});

test('ledger cache enforces an aggregate byte budget while retaining in-flight deduplication', async () => {
 let loads = 0;
 const read = createRuntimeLedgerCache(async r => { loads++; return { text: r.ledgerPath }; }, { version: async () => 'one', maxBytes: 10, weight: () => 6 });
 const a = { ledgerPath: '/fixture-a', projectKey: 'test' }, b = { ledgerPath: '/fixture-b', projectKey: 'test' };
 await Promise.all([read(a), read(a)]); assert.equal(loads, 1);
 await read(b); assert.equal(read.stats().retainedBytes, 6);
 await read(a); assert.equal(loads, 3);
	let hugeLoads = 0;
	const huge = createRuntimeLedgerCache(async () => { hugeLoads++; await pause(5); return 'huge'; }, { version: async () => 'one', maxBytes: 3, weight: () => 10 });
	assert.deepEqual(await Promise.all([huge(a), huge(a), huge(a)]), ['huge', 'huge', 'huge']);
	assert.equal(hugeLoads, 1); assert.equal(huge.stats().retainedBytes, 0);
});

test('event ring sheds heavy raw snapshots and remains byte bounded', () => {
 const events = [];
 for (let i = 0; i < 500; i++) retainEvent(events, { type: 'tool', text: 'x'.repeat(5000), result: 'large'.repeat(10000), raw: { image: 'large' }, args: { context: 'large' } }, 8192);
 assert.ok(Buffer.byteLength(JSON.stringify(events)) <= 8192);
 assert.ok(events.every(event => !event.result && !event.raw && !event.args));
});

test('owner contexts are shared and a late callback cannot erase a new binding', () => {
 const owners = createSubagentOwners();
 const context = id => ({ sessionManager: { getSessionId: () => id } });
 for (let i = 0; i < 100; i++) owners.remember(String(i), context('leader-one'));
 assert.deepEqual(owners.stats(), { jobs: 100, sessions: 1 });
 const stale = owners.token('0'); owners.remember('0', context('leader-two'));
 assert.equal(owners.release('0', stale), false);
 assert.equal(owners.context('0').sessionManager.getSessionId(), 'leader-two');
 for (let i = 1; i < 100; i++) owners.release(String(i));
 assert.deepEqual(owners.stats(), { jobs: 1, sessions: 1 });
 owners.release('0'); assert.deepEqual(owners.stats(), { jobs: 0, sessions: 0 });
});

test('adapter disposal releases the old manager without unregistering its replacement', () => {
 const first = { name: 'old' }, second = { name: 'new' };
 const releaseFirst = registerSubagentRuntimeAdapter('memory-fixture', first);
 const releaseSecond = registerSubagentRuntimeAdapter('memory-fixture', second);
 releaseFirst(); assert.equal(getSubagentRuntimeAdapter('memory-fixture'), second);
 releaseSecond(); assert.equal(getSubagentRuntimeAdapter('memory-fixture'), undefined);
});

test('display journal flushes bounded batches and preserves delta text without retaining raw results', async t => {
 const root = await fixture(t), path = join(root, 'activity.jsonl');
 const writer = createSubagentActivityWriter(path, { batchBytes: 1024 });
 const text = '科研'.repeat(9000);
 for (let i = 0; i < text.length; i += 3000) await writer.append({ turn: 1 }, { type: 'assistant_delta', text: text.slice(i, i + 3000) });
 await writer.append({ turn: 1 }, { type: 'tool', tool: 'read', summary: 'large tool result', result: { content: [{ type: 'text', text: 'x'.repeat(200000) }] } });
 await writer.flush();
 const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(records.filter(r => r.category === 'assistant_delta').map(r => r.text).join(''), text);
 assert.ok(records.filter(r => r.category === 'assistant_delta').every(r => r.text.length <= 16000));
 assert.ok(Buffer.byteLength(JSON.stringify(records.at(-1).result)) < 64 * 1024);
 assert.equal(writer.stats().bufferedBytes, 0);
});

test('activity cursor bounds each read, preserves split UTF-8, skips oversized lines and notices truncation', async t => {
 const root = await fixture(t), path = join(root, 'audit.jsonl');
 const record = text => JSON.stringify({ category: 'assistant', timestamp: 'fixture', text }) + '\n';
 await writeFile(path, record('科研🙂') + record('x'.repeat(1000)) + record('last 科研'));
 const cursor = new CodexActivityCursor(path, { chunkBytes: 7, pollBytes: 80, lineBytes: 150 });
 while (cursor.offset < (await stat(path)).size) await cursor.poll();
 assert.deepEqual(cursor.events.map(e => e.text), ['科研🙂', 'last 科研']);
 assert.ok(cursor.carry.length <= 150);
 await writeFile(path, record('replacement')); await cursor.poll();
 assert.deepEqual(cursor.events.map(e => e.text), ['replacement']);
});

test('idle selection excludes active/blocked jobs and uncompleted external runs', () => {
 const job = { id: 'warm', backend: 'pi', status: 'completed', idleSince: 0 };
 const policy = { idleMs: 10, warmLimit: 2 };
 assert.deepEqual(idleSubagentCandidates([job], policy, 11).map(j => j.id), ['warm']);
 for (const fields of [{ status: 'running' }, { status: 'input_required' }, { status: 'cancelling' }, { closed: true }, { nativeBlocked: true }, { pendingRequest: {} }, { waiters: [() => {}] }, { externalRuns: [{ status: 'running' }] }, { backend: 'antigravity' }]) {
  assert.deepEqual(idleSubagentCandidates([{ ...job, ...fields }], policy, 11), []);
 }
});

test('manager hibernates cooperatively, preserves the exact Session, and single-flights a racing wake', async t => {
 const root = await fixture(t), children = [], records = [];
 let time = 0;
 const manager = createSubagentSessionManager({ stateRoot: root, clock: () => time, memoryPolicy: { idleMs: 60000, warmLimit: 0 }, spawn: (_bin, args) => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  child.stdin.on('data', data => records.push(JSON.parse(data.toString()))); children.push({ child, args }); return child;
 } });
 t.after(() => manager.dispose());
 const first = await manager.start({ id: 'pi-memory-fixture', actorId: 'pi:memory-fixture', backend: 'pi', cwd: root, role: 'executor', task: 'First task' });
 const sessionDir = join(root, 'subagents/pi-sessions'), path = join(sessionDir, 'fixture.jsonl');
 await mkdir(sessionDir, { recursive: true });
 await writeFile(path, JSON.stringify({ type: 'session', version: 3, id: first.sessionId, cwd: root }) + '\n');
 children[0].child.stdout.write(JSON.stringify({ type: 'message_end', message: assistant('First result') }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n');
 await manager.wait(first.id); time = 60001;
 assert.deepEqual(await manager.sweepIdle(), [first.id]);
	const invalid = records.find(r => r.type === 'hibernate'); assert.ok(invalid);
	await writeFile(path, JSON.stringify({ type: 'session', version: 3, id: 'wrong-session', cwd: root }) + '\n');
	children[0].child.stdout.write(JSON.stringify({ type: 'hibernate_response', id: invalid.id, accepted: true, sessionFile: path }) + '\n');
	await until(() => manager.get(first.id).events.some(event => event.type === 'memory_warning'));
	assert.equal(manager.get(first.id).status, 'completed', 'a rejected memory optimization does not rewrite the work outcome');
	assert.equal(records.some(r => r.type === 'hibernate_commit'), false);
	await writeFile(path, JSON.stringify({ type: 'session', version: 3, id: first.sessionId, cwd: root }) + '\n');
	time += 60001; await manager.sweepIdle();
	const request = records.filter(r => r.type === 'hibernate').at(-1);
 children[0].child.stdout.write(JSON.stringify({ type: 'hibernate_response', id: request.id, accepted: true, sessionFile: path }) + '\n');
	await until(() => records.some(r => r.type === 'hibernate_commit'));
	children[0].child.stdout.write(JSON.stringify({ type: 'hibernate_committed', id: request.id, accepted: true }) + '\n');
	let rebound = false;
	const wake = manager.resume(first.id, { followUp: 'Second task', onReady() { rebound = true; assert.equal(manager.get(first.id).residency, 'cold'); } });
	await pause(5); assert.equal(rebound, false, 'new owner waits for old-process cleanup');
 children[0].child.emit('close', 0, null);
	await Promise.all([wake, manager.send(first.actorId, { from: 'research-leader', type: 'steer', body: 'Extra context' })]);
	assert.equal(rebound, true);
 assert.equal(children.length, 2);
 assert.equal(children[1].args[children[1].args.indexOf('--session') + 1], path);
 assert.equal(manager.get(first.id).sessionId, first.sessionId);
 assert.equal(manager.get(first.id).turn, 2);
 assert.equal(records.filter(r => r.type === 'prompt').length, 2);
 assert.equal(records.filter(r => r.type === 'steer').length, 1);
});

test('a new task wins a race with the asynchronous idle guard', async t => {
 const root = await fixture(t), records = [], child = new EventEmitter();
 child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
 child.stdin.on('data', data => records.push(JSON.parse(data.toString())));
 let time = 0, approve;
 const manager = createSubagentSessionManager({ stateRoot: root, clock: () => time, memoryPolicy: { idleMs: 60000, warmLimit: 0 },
  spawn: () => child, canHibernate: () => new Promise(resolve => { approve = resolve; }) });
 t.after(() => manager.dispose());
 const job = await manager.start({ actorId: 'pi:race', backend: 'pi', cwd: root, task: 'First task' });
 child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n'); await manager.wait(job.id);
 time = 60001; const sweep = manager.sweepIdle(); await until(() => approve);
 await manager.resume(job.id, { followUp: 'New task that must keep running' });
 approve(true); assert.deepEqual(await sweep, []);
 assert.equal(manager.get(job.id).status, 'running');
 assert.equal(records.some(r => r.type === 'hibernate'), false);
});

test('retirement drops heavy parent references while preserving the original result on disk', async t => {
 const root = await fixture(t), child = new EventEmitter();
 child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
 const manager = createSubagentSessionManager({ stateRoot: root, spawn: () => child });
 t.after(() => manager.dispose());
 const job = await manager.start({ id: 'pi-retire-fixture', actorId: 'pi:retire', backend: 'pi', cwd: root, task: 'Original task', systemPrompt: 'Assigned scope' });
 const summary = 'Decision evidence: ' + 'x'.repeat(50000);
 child.stdout.write(JSON.stringify({ type: 'message_end', message: assistant(summary) }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n');
 await manager.wait(job.id); await manager.retire(job.id);
 const compact = manager.get(job.id);
 assert.equal(compact.task, null); assert.equal(compact.reusable, false); assert.equal(compact.residency, 'retired');
 assert.equal(compact.events.length, 0); assert.ok(compact.result.summary.length <= 1200);
 const saved = await manager.readResult(job.id);
 assert.equal(saved.result.summary, summary); assert.equal(saved.task, 'Original task');
 assert.equal(saved.systemPrompt, undefined);
});

test('real native child saves and restores its conversation with an offline provider', { timeout: 25000 }, async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-memory-native-'));
 const project = join(root, 'project'), agentDir = join(root, 'agent'), packageDir = join(root, 'provider');
 await Promise.all([project, agentDir, packageDir].map(path => mkdir(path)));
 await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'pi-memory-fixture', pi: { extensions: ['./index.ts'] } }));
 const streamModule = new URL('../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', import.meta.url).href;
 await writeFile(join(packageDir, 'index.ts'), `import { AssistantMessageEventStream } from ${JSON.stringify(streamModule)};
export default function(pi) { pi.registerProvider('memory-fixture', {
 baseUrl: 'https://fixture.invalid', apiKey: 'fixture', api: 'memory-fixture-api',
 models: [{ id: 'offline', name: 'Offline fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
 streamSimple(model, context) {
  const stream = new AssistantMessageEventStream();
  const text = 'Persisted user turns: ' + context.messages.filter(m => m.role === 'user').length;
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text }], usage: ${JSON.stringify(usage)}, stopReason: 'stop', timestamp: Date.now() };
  queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); });
  return stream;
 }
}); }`);
 await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageDir] }));
 const children = [];
 let time = 0;
 const manager = createSubagentSessionManager({ stateRoot: join(root, 'state'), clock: () => time,
  memoryPolicy: { idleMs: 60000, warmLimit: 0 },
  environment: { ...process.env, PI_CODING_AGENT_DIR: agentDir, RESEARCH_PI_STATE_DIR: join(root, 'state'), RESEARCH_PI_PROVIDER_IDLE_MS: '0' },
  spawn(bin, args, options) { const child = spawn(bin, args, options); children.push(child); return child; },
 });
 try {
  const job = await manager.start({ actorId: 'pi:offline-fixture', backend: 'pi', role: 'executor', model: 'memory-fixture/offline', thinking: 'off', cwd: project, task: 'First offline request.' });
  let timeout;
  const wait = () => Promise.race([manager.wait(job.id), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Native fixture did not settle: ' + JSON.stringify(manager.get(job.id)))), 10000); })]).finally(() => clearTimeout(timeout));
  const first = await wait();
  assert.equal(first.status, 'completed', first.error);
  assert.match(first.result.summary, /Persisted user turns: 1/);
  const terminal = first.nativeTerminal;
  const observer = createConnection(terminal.terminalSocket);
  let observed = false;
  observer.on('data', data => { if (data.toString().includes('terminal_snapshot')) observed = true; });
  await new Promise((resolve, reject) => { observer.once('connect', resolve); observer.once('error', reject); });
  observer.write(JSON.stringify({ type: 'attach', observer: true, instance: terminal.instance }) + '\n');
  await until(() => observed);
  time += 60001; await manager.sweepIdle(); await pause(150);
  assert.equal(manager.get(job.id).residency, 'warm', 'an observed child refuses hibernation');
  observer.end(); await new Promise(resolve => observer.once('close', resolve));
  for (let i = 0; i < 30 && manager.get(job.id).residency !== 'cold'; i++) { time += 60001; await manager.sweepIdle(); await pause(100); }
  assert.equal(manager.get(job.id).residency, 'cold');
  assert.equal(children[0].exitCode, 0);
  await manager.resume(job.id, { followUp: 'Second offline request; retain the first exchange.' });
  const second = await wait();
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.status, 'completed', second.error);
  assert.match(second.result.summary, /Persisted user turns: 2/);
  assert.equal(children.length, 2);
 } finally {
  await manager.dispose();
  await Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => child.once('close', resolve))));
  await rm(root, { recursive: true, force: true });
 }
});

test('summarized history retains substantially less heap than eager Core loading in isolated processes', async t => {
 const root = await fixture(t), path = join(root, 'large-session.jsonl'), timestamp = new Date().toISOString();
 const line = value => JSON.stringify(value) + '\n';
 await writeFile(path, line({ type: 'session', version: 3, id: '00000000-0000-4000-8000-000000000001', cwd: root, timestamp }));
 let parentId = null;
 for (let i = 0; i < 512; i++) {
  const id = 'entry-' + i;
  await appendFile(path, line({ type: 'message', id, parentId, timestamp, message: assistant('x'.repeat(65536)) }));
  parentId = id;
 }
 await appendFile(path, line({ type: 'compaction', id: 'summary', parentId, timestamp, summary: 'Preserved scientific summary.', firstKeptEntryId: 'summary', tokensBefore: 1000000 }));
 await appendFile(path, line({ type: 'message', id: 'current', parentId: 'summary', timestamp, message: { role: 'user', content: 'Current task', timestamp: 0 } }));
 const script = `import {SessionManager} from '@earendil-works/pi-coding-agent';
import {openLazySession} from './.pi/lib/lazy-session-history.mjs';
global.gc();const baseline=process.memoryUsage();
const manager=process.argv[1]==='lazy'?openLazySession(SessionManager,process.argv[2]):SessionManager.open(process.argv[2]);
const projection=manager.buildSessionContext();global.gc();const memory=process.memoryUsage();
console.log(JSON.stringify({mode:process.argv[1],rssMiB:memory.rss/1048576,historyHeapMiB:(memory.heapUsed-baseline.heapUsed)/1048576,messages:projection.messages.length,cache:manager.historyCache?.stats()}));`;
 const results = [];
 for (const mode of ['eager', 'lazy']) {
  const result = await execFile(process.execPath, ['--expose-gc', '--input-type=module', '-e', script, mode, path], { cwd: new URL('..', import.meta.url), timeout: 15000 });
  results.push(JSON.parse(result.stdout));
 }
 assert.equal(results[0].messages, results[1].messages);
 assert.ok(results[1].historyHeapMiB < results[0].historyHeapMiB * 0.35, JSON.stringify(results));
 assert.ok(results[1].cache.loads < 10);
 t.diagnostic(JSON.stringify({ fixturePayloadMiB: 32, results }));
});
