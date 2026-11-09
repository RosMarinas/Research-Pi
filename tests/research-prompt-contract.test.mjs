import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { RESEARCH_PRINCIPLES, researchRolePrompt } from '../.pi/lib/research-prompts.mjs';
import { buildDelegationPrompt } from '../.pi/lib/codex-jobs.mjs';
import { buildPiRunnerArgs, createSubagentSessionManager } from '../.pi/lib/subagent-sessions.mjs';
import { subagentModelCard } from '../.pi/lib/subagent-message.mjs';
import { RESEARCH_COMPACTION_SYSTEM_PROMPT, RESEARCH_STATE_TOOL, buildResearchCompactionPrompt } from '../.pi/lib/research-compact.mjs';
import { buildPromotedHarnessContext } from '../.pi/extensions/deepseek-v4-pro-anchor.ts';
import { buildSystemPrompt } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import { applyResearchIdentity } from '../.pi/extensions/research-mode.ts';
import { createResearchSessionRuntime } from '../.pi/lib/native-runtime-factory.mjs';

const once = text => assert.equal(text.split(RESEARCH_PRINCIPLES).length - 1, 1, 'one shared contract per payload');
const schema = name => JSON.parse(readFileSync(new URL(`../.pi/schemas/${name}.json`, import.meta.url), 'utf8'));

test('Leader native system and DeepSeek research adapter preserve the same contract and project context', () => {
 const contextFiles = [{ path: '/synthetic/AGENTS.md', content: 'Use the current single-seed experiment.' }];
 const options = { cwd: '/synthetic', selectedTools: [], appendSystemPrompt: RESEARCH_PRINCIPLES, contextFiles, skills: [] };
 const native = applyResearchIdentity(buildSystemPrompt(options));
 once(native); assert.match(native, /computational research agent/); assert.match(native, /current single-seed/);
 const promoted = buildPromotedHarnessContext(options, 'research');
 once(promoted); assert.match(promoted, /current single-seed/);
});

for (const mode of ['advisor', 'executor']) for (const continuation of [false, true]) {
 test(`Codex ${mode} ${continuation ? 'resume' : 'start'} retains latest task, principles and authority`, () => {
  const text = buildDelegationPrompt({ mode, continuation, task: 'Use one seed and ten updates; no separate initial evaluation.',
   context: 'Historical plan: three seeds and 200 updates.', writeScope: ['training'], fullAccess: false });
  once(text); assert.ok(text.includes(researchRolePrompt(mode)));
  assert.match(text, /latest explicit user decision supersedes/);
  assert.match(text, /one seed and ten updates/); assert.match(text, /Historical plan/);
  assert.doesNotMatch(text, /targeted code bypasses to overcome|Offload all validity caveats/);
  if (mode === 'advisor') {
   assert.match(text, /Do not modify project source or external state/);
   assert.match(text, /scratch for inspection is allowed under \$TMPDIR/);
  }
  else { assert.match(text, /Write only: \["training"\]/); assert.match(text, /Do not default to extra budgets/); }
 });
}

test('Pi custom role guidance supplements rather than removes shared principles and advisor limits', () => {
 const args = buildPiRunnerArgs({ role: 'advisor', id: 'test', sessionId: 'test', sessionDir: '/tmp', systemPrompt: 'Compare capacity hypotheses.' });
 const prompt = args[args.indexOf('--append-system-prompt') + 1];
 once(prompt); assert.match(prompt, /Compare capacity hypotheses/);
 assert.match(prompt, /Do not modify project source or external state/);
 assert.match(prompt, /scratch for inspection is allowed under \$TMPDIR/);
 assert.equal(args.includes('--no-context-files'), false);
});

test('Pi child can select a model supplied by an installed provider without a model request', async () => {
 const root = mkdtempSync(join(tmpdir(), 'pi-provider-startup-'));
 const agentDir = join(root, 'agent');
 const packageDir = join(root, 'provider');
 mkdirSync(agentDir); mkdirSync(packageDir);
 writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'pi-fixture-provider', pi: { extensions: ['./index.ts'] } }));
 writeFileSync(join(packageDir, 'index.ts'), `export default function(pi) {
  pi.registerProvider('fixture-acp', { baseUrl: 'https://fixture.invalid', apiKey: 'fixture', api: 'openai-completions',
   models: [{ id: 'fixture-model', name: 'Fixture', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] });
 }`);
 writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageDir] }));
 const args = buildPiRunnerArgs({ role: 'advisor', id: 'provider-test', sessionId: 'provider-test',
  sessionDir: join(root, 'sessions'), model: 'fixture-acp/fixture-model', thinking: 'medium' });
 let runtime;
 try {
  await assert.rejects(createResearchSessionRuntime({ args: [...args, '--no-extensions'], cwd: root, agentDir }), /Model .* not found/);
  runtime = await createResearchSessionRuntime({ args, cwd: root, agentDir });
  assert.equal(runtime.session.model.provider, 'fixture-acp');
  assert.equal(runtime.session.model.id, 'fixture-model');
  assert.equal(runtime.session.thinkingLevel, 'medium');
 } finally { await runtime?.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('Pi startup failure reports the cause and redacts credentials from stderr', async () => {
 const root = mkdtempSync(join(tmpdir(), 'pi-startup-error-'));
 const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
 child.kill = () => true;
 const manager = createSubagentSessionManager({ stateRoot: root, spawn: () => child });
 try {
  const job = await manager.start({ actorId: 'pi:startup-error', backend: 'pi', role: 'advisor', cwd: root, task: 'Inspect only.' });
  child.stderr.write('Error: Model "fixture-acp/missing" not found.\nGEMINI_API_KEY=private-fixture-value\nBearer private-fixture-bearer-token\n');
  child.emit('close', 1, null);
  const result = await manager.wait(job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.reusable, false);
  assert.match(result.error, /Pi runner exited \(1\).*Model "fixture-acp\/missing" not found/);
  assert.doesNotMatch(result.error, /private-fixture-value|private-fixture-bearer-token/);
  assert.match(result.error, /REDACTED/);
 } finally { await manager.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('Antigravity actually receives shared principles and environment scope on its input stream', async () => {
 const root = mkdtempSync(join(tmpdir(), 'pi-prompt-transport-'));
 const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); const inputs = [];
 child.stdin = new Writable({ write(chunk, encoding, callback) { inputs.push(chunk.toString()); callback(); } });
 child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
 const manager = createSubagentSessionManager({ stateRoot: root, spawn: () => child });
 try {
  await manager.start({ id: 'prompt-test', actorId: 'antigravity:prompt', backend: 'antigravity', role: 'environment', cwd: root, task: 'Diagnose the actual dependency failure.' });
  const wire = inputs.map(s => JSON.stringify(JSON.parse(s))).join('\n');
  assert.match(wire, /latest explicit user decision supersedes/);
  assert.match(wire, /only the environment needed/); assert.match(wire, /actual dependency failure/);
 } finally { await manager.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('default result card retains scientific limitation and labels the next step as a suggestion', () => {
 const summary = 'GPU fixture passed; no real optimizer update occurred. Capacity comparison remains untested.';
 const card = subagentModelCard({ id: 'test', status: 'completed', result: { outcome: 'partial', summary,
  recommended_next_step: 'Obtain the first real update.', unverified_edge_cases_and_warnings: ['Optional portability check.'] } });
 assert.ok(card.includes(summary)); assert.match(card, /Suggested next decision:/); assert.doesNotMatch(card, /Next action:/);
 const delegate = schema('codex-delegate-result');
 assert.match(delegate.properties.summary.description, /limitation that changes/);
 assert.match(delegate.properties.unverified_edge_cases_and_warnings.description, /must also appear in summary/);
 assert.deepEqual(delegate.required, ['outcome', 'summary']);
 assert.match(schema('codex-advisor-result').properties.working_synthesis.description, /limitation that changes/);
});

test('compaction keeps research proposal optional and distinguishes stale plans from current decisions', () => {
 assert.equal(RESEARCH_STATE_TOOL.parameters.required.includes('nextExperiment'), false);
 assert.match(RESEARCH_COMPACTION_SYSTEM_PROMPT, /Remove cancelled budgets/);
 assert.match(RESEARCH_COMPACTION_SYSTEM_PROMPT, /suggestions become decisions only when accepted/);
 const prompt = buildResearchCompactionPrompt({ previousState: { nextExperiment: { intervention: '200 steps, three seeds' } },
  conversationText: 'USER: one seed, ten steps; cancel separate evaluation.', experiments: [], checkpoints: [], sourceCatalog: [] });
 assert.match(prompt, /fallible update input/); assert.match(prompt, /cancel separate evaluation/);
});

test('full access conveys capability without widening task authority', () => {
 const text = buildDelegationPrompt({ mode: 'executor', fullAccess: true, task: 'Inspect a log', writeScope: ['training'] });
 assert.match(text, /Tool access does not authorize additional tasks or cancellation/);
 assert.match(text, /Write only: \["training"\]/);
});
