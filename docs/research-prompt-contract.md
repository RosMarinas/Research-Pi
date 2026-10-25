# Research prompt responsibilities

Research Pi keeps one common research contract in `.pi/APPEND_SYSTEM.md`.
`research-prompts.mjs` reads it and supplies role-specific responsibilities.
The native Leader loads that file as its CLI addendum; Codex delegations
(including continuations), Pi workers and Antigravity workers receive the same
contract through their respective transports. These transports have different
message roles; sharing text does not imply identical provider behavior.

The common contract covers research value, proportional verification, the latest
user decision, failure interpretation and completion. Leader role context owns
tradeoffs and delegation. Advisor/Analysis remain read-only. Tool descriptions
own permissions and operations; project context owns current experimental facts.
A custom Pi/Antigravity worker prompt supplements the common and role contracts
rather than silently dropping them.

## Behavioral changes

- A blocking framework check is investigated before alteration. No default
  instruction recommends bypasses, increased budgets or retries.
- Decision-changing limitations stay in the default-visible result summary.
  Optional warning fields hold only secondary, non-blocking concerns.
- Result cards label the worker's proposed next step as a suggestion.
- Compaction distinguishes current accepted user decisions from old plans and
  unaccepted agent proposals. Current ProjectView already used a fixed baseline;
  its text now distinguishes changes in authority from new factual observations.
- Existing state amendment supports explicit changes to steps, seeds and
  prerequisites. No new state registry, schema fields or approval loop was added.
- Project management loads for structural/workspace changes, integration and
  cleanup; routine delegation or adding a file alone is not its trigger.
- Truncated tool output calls for selective retrieval when needed, not an
  automatic rerun. Checkpoints require a meaningful state-loss cost.
- Full access describes tool capability, not permission to widen a task or cancel
  running jobs. Existing ownership, sandbox and resource mechanisms are unchanged.

## Validation

The committed regression test is:

```sh
node --test tests/research-prompt-contract.test.mjs
```

Ten tests cover native/DeepSeek research-context composition, fresh and continued
Codex tasks, custom Pi worker prompts, actual Antigravity input via a simulated
child process, default result cards, optional compaction fields and full-access
scope language. No external model, remote experiment or live worker is invoked.

125 targeted tests passed in the clean temporary worktree. Overlaying the main
checkout's existing related uncommitted changes and adding its git-init identity
tests passed 127. `npm run check` and syntax checking of the new module passed.

Two existing local assertions were excluded after reproducing their failures on
main before integration: `research compaction prefers one constrained
structured-state tool call` incorrectly requires optional `nextExperiment`, and
`research identity requires plain and traceable technical messages` expects
obsolete wording. The new committed tests cover the intended optional-field and
prompt-composition contracts. The rest of those test files was run. The local
suite is otherwise ignored by Git, as before; these are not full-suite claims.

These tests establish prompt delivery and runtime regression coverage, not that
an LLM now reliably exercises better research judgment. Historical decision-point
replays with an actual model remain unmeasured.

## Activation

No running KV_Holes process is reloaded or restarted by this change. Existing
processes may retain loaded text; existing Codex threads retain their original
dynamic-tool schemas. Use new sessions/worker contexts at an appropriate safe
boundary to get the complete new configuration. Continuation task text contains
the common contract, but that alone does not replace an old thread's tool schema.
