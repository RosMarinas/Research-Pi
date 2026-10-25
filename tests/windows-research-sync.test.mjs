import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDelegationPrompt } from '../.pi/lib/codex-jobs.mjs';
import { RESEARCH_PRINCIPLES } from '../.pi/lib/research-prompts.mjs';
import { assertWslFullAccess } from '../.pi/lib/project-boundary.mjs';

for (const mode of ['advisor', 'executor']) for (const continuation of [false, true]) {
 test(`WSL ${mode} ${continuation ? 'resume' : 'start'} preserves research and platform contracts`, () => {
  const prompt = buildDelegationPrompt({ mode, continuation, wslVersion: '2', task: 'Inspect evidence', writeScope: ['training'] });
  assert.equal(prompt.split(RESEARCH_PRINCIPLES).length - 1, 1);
  assert.match(prompt, /any host command is one-shot/);
  assert.match(prompt, /must not address \/mnt or launch Windows\/PowerShell executables/);
  if (mode === 'advisor') assert.match(prompt, /Do not modify files or external state/);
  else assert.match(prompt, /Write only: \["training"\]/);
 });
}
test('main full-access capability cannot remove the WSL boundary', () => {
 assert.throws(() => assertWslFullAccess(true, '2'), /does not support/);
 assert.doesNotThrow(() => assertWslFullAccess(false, '2'));
});
