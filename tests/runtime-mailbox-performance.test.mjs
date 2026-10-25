import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeLedgerCache } from '../.pi/lib/runtime-ledger-cache.mjs';
import { readRuntimeEvents, readRuntimeSnapshot, initializeResearchRuntime, registerSubagentRuntimeJob, settleRuntimeMessage } from '../.pi/lib/research-runtime.mjs';
import { createRuntimeMailboxWatcher } from '../.pi/lib/runtime-mailbox-watch.mjs';
import { drainSubagentMailbox, queueSubagentMessage } from '../.pi/lib/runtime-subagents.mjs';
import { registerSubagentRuntimeAdapter } from '../.pi/lib/research-runtime-adapters.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
 const end = Date.now() + 2000;
 while (!check()) { assert.ok(Date.now() < end, 'timed out'); await sleep(5); }
}
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-mailbox-performance-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 return { root, ledgerPath: join(root, 'events.jsonl'), projectKey: 'project-test', workspaceKey: 'workspace-test', workspaceRoot: root };
}
const event = (id, body = id) => JSON.stringify({ projectKey: 'project-test', id, type: 'message.queued', data: { id, body, to: 'research-leader' } });

test('unchanged ledger shares one immutable snapshot across concurrent readers and isolates workspace views', async t => {
 const runtime = await fixture(t);
 await writeFile(runtime.ledgerPath, event('one') + '\n');
 const snapshots = await Promise.all(Array.from({ length: 20 }, () => readRuntimeSnapshot(runtime)));
 assert.ok(snapshots.every(s => s === snapshots[0]));
 assert.throws(() => { snapshots[0].messages[0].body = 'corrupted'; }, TypeError);
 assert.throws(() => { snapshots[0].messages.push({}); }, TypeError);
 const other = await readRuntimeSnapshot({ ...runtime, workspaceKey: 'other' });
 assert.equal(other.workspaceKey, 'other'); assert.equal(snapshots[0].workspaceKey, 'workspace-test');
 assert.equal((await readRuntimeSnapshot(runtime)).messages[0].body, 'one');
 assert.deepEqual(await readRuntimeEvents({ ...runtime, projectKey: 'different' }), []);
});

test('cache notices append without project revision, partial tail, replacement, truncation and recreation', async t => {
 const runtime = await fixture(t);
 assert.equal((await readRuntimeSnapshot(runtime)).ledgerEventCount, 0);
 await writeFile(runtime.ledgerPath, event('one') + '\n');
 const first = await readRuntimeSnapshot(runtime);
 await appendFile(runtime.ledgerPath, event('two') + '\n');
 const second = await readRuntimeSnapshot(runtime);
 assert.equal(second.revision, first.revision); assert.equal(second.messages.length, 2);
 assert.equal(first.messages.length, 1, 'published snapshots remain stable');
 const third = event('three');
 await appendFile(runtime.ledgerPath, third.slice(0, 20));
 assert.equal((await readRuntimeSnapshot(runtime)).messages.length, 2);
 await appendFile(runtime.ledgerPath, third.slice(20)); // valid final JSON without newline
 assert.equal((await readRuntimeSnapshot(runtime)).messages.length, 3);
 await writeFile(runtime.ledgerPath + '.replacement', event('new') + '\n');
 await rename(runtime.ledgerPath + '.replacement', runtime.ledgerPath);
 assert.equal((await readRuntimeSnapshot(runtime)).messages[0].id, 'new');
 await writeFile(runtime.ledgerPath, '');
 assert.equal((await readRuntimeSnapshot(runtime)).messages.length, 0);
 await rm(runtime.ledgerPath);
 assert.equal((await readRuntimeSnapshot(runtime)).messages.length, 0);
 await writeFile(runtime.ledgerPath, event('back') + '\n');
 assert.equal((await readRuntimeSnapshot(runtime)).messages[0].id, 'back');
 await appendFile(runtime.ledgerPath, 'invalid\n');
 await assert.rejects(readRuntimeSnapshot(runtime), /invalid JSON/);
 await writeFile(runtime.ledgerPath, event('fixed') + '\n');
 assert.equal((await readRuntimeSnapshot(runtime)).messages[0].id, 'fixed');
});

test('same-size rewrite invalidates cache, concurrent cold reads load only once', async t => {
 const runtime = await fixture(t); let loads = 0;
 await writeFile(runtime.ledgerPath, event('aaa') + '\n');
 const read = createRuntimeLedgerCache(async r => { loads++; await sleep(10); return (await import('node:fs/promises')).readFile(r.ledgerPath, 'utf8'); });
 await Promise.all(Array.from({ length: 20 }, () => read(runtime)));
 assert.equal(loads, 1);
 await sleep(5); await writeFile(runtime.ledgerPath, event('bbb') + '\n');
 assert.match(await read(runtime), /bbb/); assert.equal(loads, 2);
});

test('a reader after a write cannot inherit a stale in-flight load', async () => {
 let generation = 'old', loads = 0, release;
 const gate = new Promise(r => { release = r; });
 const read = createRuntimeLedgerCache(async () => {
  const captured = generation;
  if (++loads === 1) await gate;
  return { generation: captured };
 }, { version: async () => generation });
 const runtime = { ledgerPath: '/synthetic', projectKey: 'test' };
 const oldRead = read(runtime); await until(() => loads === 1);
 generation = 'new'; const newRead = read(runtime); release();
 assert.equal((await oldRead).generation, 'old');
 assert.equal((await newRead).generation, 'new');
 assert.equal((await read(runtime)).generation, 'new'); assert.equal(loads, 2);
});

test('busy Leader with empty mailbox does not trigger periodic drains', async t => {
 const runtime = await fixture(t); await writeFile(runtime.ledgerPath, ''); let scans = 0;
 const watcher = createRuntimeMailboxWatcher({ intervalMs: 10, retryWhen: () => true,
  drain: async () => { scans++; return { delivered: 0, pending: false }; } });
 t.after(watcher.stop); watcher.start(runtime, {}); await until(() => scans > 0);
 await sleep(40); const settled = scans; await sleep(150); assert.equal(scans, settled);
 await appendFile(runtime.ledgerPath, 'new'); await until(() => scans > settled);
});

test('deferred backend backs off while idle and eventually delivers without another ledger write', async t => {
 const runtime = await fixture(t); await writeFile(runtime.ledgerPath, '');
 let scans = 0, ready = false, delivered = 0;
 const watcher = createRuntimeMailboxWatcher({ intervalMs: 10, maxRetryMs: 100, retryWhen: () => false,
  drain: async () => { scans++; if (ready) delivered++; return { delivered: ready ? 1 : 0, pending: !ready }; } });
 t.after(watcher.stop); watcher.start(runtime, {});
 await until(() => scans >= 3); await sleep(200); assert.ok(scans < 12, `unexpected hot loop: ${scans}`);
 ready = true; await until(() => delivered === 1); const stopped = scans;
 await sleep(150); assert.equal(scans, stopped);
});

test('busy-to-idle readiness bypasses long backoff and stop cancels retries', async t => {
 const runtime = await fixture(t); await writeFile(runtime.ledgerPath, '');
 let busy = true, scans = 0, delivered = 0;
 const watcher = createRuntimeMailboxWatcher({ intervalMs: 10, maxRetryMs: 1000, retryWhen: () => busy,
  drain: async () => { scans++; if (!busy) delivered++; return { delivered: busy ? 0 : 1, pending: busy }; } });
 t.after(watcher.stop); watcher.start(runtime, {}); await until(() => scans >= 5);
 const start = Date.now(); busy = false; await until(() => delivered === 1);
 assert.ok(Date.now() - start < 150, 'idle transition must bypass backoff');
 watcher.stop(); watcher.wake(); await sleep(30); assert.equal(delivered, 1);
});

test('same-round snapshot reuse preserves locked delivery recheck and reports deferred subagent mail', async t => {
 const { root } = await fixture(t);
 const runtime = await initializeResearchRuntime(root, { sessionId: 'leader' }, { runtimeRoot: join(root, 'runtime') });
 const ctx = { sessionManager: { getSessionId: () => 'leader' } };
 await registerSubagentRuntimeJob(runtime, { id: 'job', actorId: 'antigravity:test', backend: 'antigravity', status: 'running', workspaceKey: runtime.workspaceKey });
 let dispatches = 0, deferred = 0, ready = false;
 registerSubagentRuntimeAdapter('antigravity', { dispatch: async () => { dispatches++; return { status: ready ? 'delivered' : 'queued' }; } });
 const message = await queueSubagentMessage(runtime, { actorId: 'antigravity:test', body: 'wait' });
 const snapshot = await readRuntimeSnapshot(runtime);
 const options = { snapshot, onDeferred: () => { deferred++; } };
 assert.equal(await drainSubagentMailbox(runtime, ctx, options), 0); assert.equal(deferred, 1);
 await settleRuntimeMessage(runtime, message.id, 'superseded'); ready = true;
 assert.equal(await drainSubagentMailbox(runtime, ctx, options), 0);
 assert.equal(dispatches, 1, 'stale screening snapshot must not bypass locked fresh-state check');
});
