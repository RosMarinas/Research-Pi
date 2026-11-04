# Subagent conversations

New Pi subagents run the same `AgentSessionRuntime` and `InteractiveMode` as the Leader, in their existing owned child process. `/watch` attaches to that process's private terminal socket. It does not create a second model session or replay a task. Native history, tools, streaming output, thinking visibility, editor, token/context footer and model menus therefore come from the original Pi UI.

## Use

- `/watch` on the Leader: search conversations by name, role or model. Choose the same terminal or a new terminal.
- `/agents` inside a native subagent: search and switch conversations. Leader is a fixed entry.
- `/leader` or `Ctrl+]`: return/detach. The subagent continues, retaining its editor draft and transcript position. A standalone watch terminal exits back to its shell.
- User-started discussion turns stay in the subagent conversation: completion, failure, cancellation and input requests do not automatically enqueue Leader messages. A User steering a still-running Leader task does not remove that original task’s completion notification. An explicit new Leader instruction restores reporting.
- `/leader <message>`: queue a message from **you** to the Leader. Its receipt identifies delivery; this does not impersonate the subagent.
- `/model`: the native model picker. History remains in the same session. An already running model call keeps its original model; subsequent calls use the new selection.
- Native Enter/steering, follow-up queuing, Escape/abort, tool expansion and thinking controls behave as on the Leader. Detach is distinct from cancellation.
- The subagent's `message_leader` tool sends its own questions/progress through the existing Runtime mailbox. Leader follow-ups enter the same live session.

The native footer reports the selected session's own usage and model. The conversation status identifies the target and provides return/switch shortcuts. Other agents' completion, failure and input requests appear as notifications/status. Host-capability requests, including an advisor's external-file reads, go to the owning Leader's permission policy and UI. Existing grants and explicitly enabled Leader full access are honored; otherwise the approval appears in the Leader session with the requesting agent's identity. Approval or denial resumes the same tool call. Cancellation dismisses its pending review. The advisor retains its read-only role. Other native input dialogs remain in the owning conversation and can be answered with `/watch`.

## Existing sessions and boundaries

Already-running legacy RPC agents and non-Pi backends retain the journal view. They cannot be retrofitted with a native terminal without restarting their process; no automatic restart is performed. The journal now renders recorded tool names, arguments and results instead of synthetic `activity {}` cards. Historical details that were never recorded cannot be reconstructed.

Multiple terminal clients mirror one native viewport, matching the existing Leader host. They do not have independent viewport sizes. The Leader still owns subagent lifetime and mailbox delivery; closing the Leader process ends its owned children as before. Terminal detachment alone does not do so.

Native advisors share the Leader's project-local artifact handling. Temporary scripts, caches and full tool output use the active project's `tmp/pi` directory; the shell receives this path through `TMPDIR`, `TMP` and `TEMP`. Reading these output references needs no host-capability grant. Advisor and Analysis source access stays read-only, with disposable scratch allowed in the designated temp directory.

## Validation

Run `node --test tests/subagent-native.test.mjs tests/subagent-sessions.test.mjs tests/subagent-watch.test.mjs tests/native-runtime.test.mjs tests/runtime-subagents.test.mjs tests/subagent-runners.test.mjs` and `npm run check` in this worktree. Tests are local validation artifacts under the repository's existing ignored tests policy.

The native integration test uses an offline synthetic provider and a real child process, real native UI and private socket. It checks tool arguments/output, thinking, model changes, direct User messages, User-to-Leader mail, detach while working, returning to the Leader, retained subagent drafts, and continuing the same session through Leader messages. It does not establish live-provider/OAuth interoperability.

## Performance monitoring

`/perf on` enables the built-in lightweight monitor; `/perf status` shows the current window and counters, and `/perf off` disables it. The footer updates every two seconds while locally enabled. Use it on the Leader to see that Node process plus samples from its live Pi subagents, or inside a subagent to inspect that process directly. Child samples include their age; allow roughly 4 seconds for the first child sample. Old processes without the plugin must be restarted normally before they can expose it; do not interrupt an existing experiment just to upgrade monitoring.

CPU is interval CPU time divided by wall time, with **100% meaning one fully used CPU core**. RSS/heap are current Node-process memory; event-loop p99 is measured with a 20ms histogram resolution. These values include model streaming, parsing, extensions and UI in that process. They do **not** include shell subprocesses, remote servers or GPU usage, and they do not isolate the harness's causal overhead.

Instrumented counters/rates:

- `ownerEvents`, `ownerBytes`: child-to-owner event IPC (including monitoring replies).
- `journalWrites`, `journalBytes`: successful display-journal appends only, not total OS disk I/O or native session/ledger writes.
- `toolSnapshotsCoalesced`: replaced intermediate tool snapshots in the journal batch.
- `renderRequests`, `rendersSuppressed`: requested redraws versus redraws skipped when no terminal is attached; not actual frame counts.
- `terminalWrites`, `terminalBytes`: bytes submitted to the headless terminal, not multiplied by client count.

Counters start when monitoring is enabled. Missing counters mean no instrumented events in that monitoring period; a missing child sample is unknown, not zero. The monitor has no automatic files, hashes or per-token disk writes. Disabled monitoring has no sampling timer/histogram; instrumented call sites only check an enabled flag. Enabled child sampling travels over the existing owner pipe and does not update the Runtime ledger.

To check a real workload, enable monitoring before it starts, inspect `/perf status` while watching a subagent, then detach with `Ctrl+]` and inspect again from the Leader. Compare CPU and terminal traffic at similar workload phases; these observational samples alone do not establish an exact UI overhead percentage. Turn monitoring off when finished. Leader-controlled sampling turns monitoring on/off in its children; a standalone child `/perf on` remains local until the Leader next changes its monitoring setting.

The optimized transport strips cumulative assistant snapshots and coalesces replaceable tool output over 100ms. Journal batches keep only the latest intermediate/final result per tool call per 400ms batch, retaining start arguments and final results. Native sessions still own the complete conversation. Hidden subagents retain conversation components but skip terminal redraws, progress animation and peer-state disk polling; attachment redraws their current state.

## Follow the Leader terminal

In VS Code, Antigravity and compatible editors, **Open a new terminal** uses the Research Pi Terminal bridge to open an integrated terminal in the originating IDE window, preferably split beside the requesting terminal. The bridge registers terminal PIDs so existing terminals can discover it after installation or an IDE reload. If it is missing, Pi identifies the originating IDE and installs the bundled extension through that IDE's own CLI. Automatic installation needs Python 3 for the bundled VSIX packager. If identification or activation fails, Pi explains the remaining setup step without switching applications.

Resident Hosts forward the request to the physical client, including when watching a subagent through another native session. The Host's startup IDE does not choose the destination. Existing tmux sessions still use tmux new-window. Same-terminal switching needs no IDE extension. Other terminal applications keep the existing platform launcher. These changes apply to newly started Hosts and subagents; an already-running native process retains its loaded implementation.
