import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runtimeMessageContextText } from '../.pi/lib/research-context.mjs';
import { subagentModelCard } from '../.pi/lib/subagent-message.mjs';
import { subagentConversationExtension } from '../.pi/lib/subagent-conversation-extension.mjs';
import { createSubagentSessionManager } from '../.pi/lib/subagent-sessions.mjs';
import {
 initializeResearchRuntime, readRuntimeSnapshot, runtimeActorAttachment, claimRuntimeActorAttachment,
 recordSubagentRuntimeEvent, acknowledgeDirectSubagentTerminalResult, unconsumedRuntimeMessages,
} from '../.pi/lib/research-runtime.mjs';

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-runtime-messages-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
const participant = { id: 'msg-progress', from: 'pi:worker', to: 'research-leader', type: 'ask',
 body: 'The training attempt failed before its first update. The checkpoint is unchanged.' };

test('participant asks preserve the report instead of generating unknown-job lookup instructions', () => {
 for (const metadata of [undefined, {}, { jobId: 'unknown' }, { jobId: 'pi-real-job' }]) {
  const card = runtimeMessageContextText({ ...participant, metadata });
  assert.ok(card.includes(participant.body));
  assert.match(card, /From: pi:worker/);
  assert.doesNotMatch(card, /action=status|jobId=unknown|Request: unknown/);
 }
});

test('participant results without a backend lifecycle remain self-contained', () => {
 const card = runtimeMessageContextText({ ...participant, type: 'result', metadata: { jobId: 'pi-real-job' } });
 assert.ok(card.includes(participant.body));
 assert.match(card, /No acknowledgement/);
 assert.doesNotMatch(card, /action=result/);
});

test('legacy blocking requests retain their body and exact backend identity', () => {
 const card = runtimeMessageContextText({ ...participant, metadata: { jobId: 'codex-real-job', requestId: 'request-real' } });
 assert.ok(card.includes(participant.body));
 assert.match(card, /Request: request-real/);
 assert.match(card, /action=status and jobId=codex-real-job/);
 assert.doesNotMatch(card, /unknown/);
});

test('legacy terminal and reconciliation cards preserve their diagnostics', () => {
 for (const status of ['failed', 'outcome_unknown']) {
  const card = runtimeMessageContextText({ ...participant, type: 'result', metadata: { jobId: 'codex-real-job', status } });
  assert.ok(card.includes(participant.body));
  assert.match(card, new RegExp('State: ' + status));
  if (status === 'outcome_unknown') assert.match(card, /Do not start overlapping work/);
 }
});

test('structured blocking cards still require a response to the exact request', () => {
 const body = subagentModelCard({ id: 'codex-real-job', status: 'input_required',
  pendingRequest: { id: 'request-real', question: 'Which implementation should continue?' } });
 assert.equal(runtimeMessageContextText({ ...participant, body, metadata: { modelCardVersion: 1 } }), body);
 assert.match(body, /action=respond, jobId=codex-real-job, and requestId=request-real/);
 const result = subagentModelCard({ id: 'pi-real-job', status: 'completed', result: { summary: participant.body } });
 assert.ok(result.includes(participant.body));
 assert.match(result, /No acknowledgement is required/);
});

test('message_leader defaults progress to notify, keeps blocking ask explicit, and records the real job', async t => {
 const root = await fixture(t), stateRoot = join(root, 'state'), cwd = join(root, 'project');
 await mkdir(cwd);
 const handlers = new Map(), tools = new Map(), commands = new Map();
 const pi = {
  on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
 };
 const runtime = await initializeResearchRuntime(cwd, { sessionId: 'leader' }, { runtimeRoot: join(stateRoot, 'runtime/projects') });
 subagentConversationExtension(pi, { stateRoot, id: 'pi-real-job', actorId: 'pi:worker', isObserved: () => false });
 t.after(async () => { for (const handler of handlers.get('session_shutdown') ?? []) await handler(); });
 const ctx = { cwd, ui: { setStatus() {}, notify() {} } };
 for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
 await tools.get('message_leader').execute('progress', { message: 'Still working.' });
 await tools.get('message_leader').execute('question', { message: 'Need a decision.', type: 'ask' });
 await commands.get('leader').handler('User asks for an update.', ctx);
 const snapshot = await readRuntimeSnapshot(runtime);
 assert.deepEqual(snapshot.messages.map(m => m.type), ['notify', 'ask', 'ask']);
 assert.equal(snapshot.messages[0].metadata.jobId, 'pi-real-job');
 for (const message of snapshot.messages) assert.doesNotMatch(runtimeMessageContextText(message), /jobId=unknown|action=status/);
});

test('direct terminal reads consume only that exact turn and retain blocking asks', async t => {
 const root = await fixture(t);
 const runtime = await initializeResearchRuntime(root, { sessionId: 'leader' }, { runtimeRoot: join(root, 'runtime') });
 const attachmentEpoch = runtimeActorAttachment(await readRuntimeSnapshot(runtime), 'research-leader').epoch;
 const job = { id: 'pi-real-job', actorId: 'pi:worker', backend: 'pi', status: 'completed', turn: 1, branchId: runtime.branchId, cwd: root,
  result: { summary: 'Implementation complete; no scientific result claimed.' } };
 await recordSubagentRuntimeEvent(runtime, job);
 const ack = await acknowledgeDirectSubagentTerminalResult({ runtime, job, sessionId: 'leader', attachmentEpoch });
 assert.equal(ack.status, 'consumed');
 await recordSubagentRuntimeEvent(runtime, job);
 assert.equal(unconsumedRuntimeMessages(await readRuntimeSnapshot(runtime), { to: 'research-leader' }).length, 0);
 await recordSubagentRuntimeEvent(runtime, { ...job, turn: 2 });
 assert.equal(unconsumedRuntimeMessages(await readRuntimeSnapshot(runtime), { to: 'research-leader' }).length, 1);
 const asking = { ...job, status: 'input_required', pendingRequest: { id: 'question-real', question: 'Continue?' } };
 await recordSubagentRuntimeEvent(runtime, asking);
 assert.equal(await acknowledgeDirectSubagentTerminalResult({ runtime, job: asking, sessionId: 'leader', attachmentEpoch }), null);
 assert.equal((await readRuntimeSnapshot(runtime)).messages.find(m => m.type === 'ask').status, 'queued');
});

test('a stale Leader cannot consume a direct result after takeover', async t => {
 const root = await fixture(t);
 const runtime = await initializeResearchRuntime(root, { sessionId: 'first' }, { runtimeRoot: join(root, 'runtime') });
 const attachmentEpoch = runtimeActorAttachment(await readRuntimeSnapshot(runtime), 'research-leader').epoch;
 const job = { id: 'pi-real-job', actorId: 'pi:worker', backend: 'pi', status: 'completed', turn: 1, branchId: runtime.branchId, cwd: root };
 await recordSubagentRuntimeEvent(runtime, job);
 await claimRuntimeActorAttachment(runtime, 'research-leader', { sessionId: 'second' }, { force: true });
 const result = await acknowledgeDirectSubagentTerminalResult({ runtime, job, sessionId: 'first', attachmentEpoch });
 assert.equal(result.status, 'stale_attachment');
 assert.equal((await readRuntimeSnapshot(runtime)).messages[0].status, 'queued');
});

async function fakeManager(t) {
 const root = await fixture(t), child = new EventEmitter();
 child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
 const manager = createSubagentSessionManager({ stateRoot: root, spawn: () => child });
 t.after(() => manager.dispose());
 const job = await manager.start({ id: 'pi-real-job', actorId: 'pi:worker', backend: 'pi', role: 'executor', cwd: root, task: 'Implement the requested change.' });
 const finish = async (text = 'Done.') => {
  child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: text, stopReason: 'stop' } }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
  return await manager.wait(job.id);
 };
 return { root, manager, job, finish };
}

test('reply and notify completion do not produce acknowledgement results; explicit work does', async t => {
 const { root, manager, job, finish } = await fakeManager(t);
 assert.equal((await finish()).reportToLeader, true);
 const runtime = await initializeResearchRuntime(root, { sessionId: 'leader' }, { runtimeRoot: join(root, 'runtime') });
 for (const type of ['reply', 'notify']) {
  await manager.send(job.actorId, { from: 'research-leader', type, body: 'Information received.' });
  const acknowledgement = await finish('Acknowledged.');
  assert.equal(acknowledgement.reportToLeader, false);
  assert.equal(await recordSubagentRuntimeEvent(runtime, { ...acknowledgement, branchId: runtime.branchId }), null);
 }
 await manager.resume(job.id, { followUp: 'Implement the next change.' });
 assert.equal((await finish()).reportToLeader, true);
 await manager.send(job.actorId, { from: 'research-leader', type: 'steer', body: 'Investigate the next issue.' });
 assert.equal((await finish()).reportToLeader, true);
});

test('a passive note during an active mission keeps its final reporting obligation', async t => {
 const { manager, job, finish } = await fakeManager(t);
 await manager.send(job.actorId, { from: 'research-leader', type: 'notify', body: 'Additional background.' });
 assert.equal((await finish()).reportToLeader, true);
 await manager.send(job.actorId, { from: 'user', type: 'notify', body: 'Discuss this with me.' });
 assert.equal((await finish()).reportToLeader, false);
});
