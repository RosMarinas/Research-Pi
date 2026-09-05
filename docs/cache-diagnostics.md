# Intermittent prompt-cache misses

## 2026-09-06 follow-up: Runtime wake resets the system identity

The opt-in wire audit captured **two different cases** in the subsequent occurrence:

- Several requests preserved all old messages, tools, settings, and route, with a matching Go session header, yet reported zero cached tokens. One started only 36 ms after the preceding response ended.
- Later requests changed `message[0]` immediately after a Runtime mailbox wake's first tool result, then changed it again when a user submitted a new turn. Both transitions reported zero cached tokens. No compaction or model switch was involved.

The pinned Core provides a reproducible client-side explanation for the second case. A normal user turn runs `before_agent_start`, where Research Pi replaces the native coding identity. Core clears that override when the run settles. A `sendCustomMessage(..., { triggerTurn: true })` wake skips `before_agent_start`: its first request inherits the previous prompt, but the next-turn refresh after a tool result falls back to the native base prompt. A subsequent user turn restores the research identity. The audit did not store prompt text; this mechanism was independently reproduced with Core's real custom-message, run-finally, and tool-continuation paths using synthetic responses, without network calls.

Research Pi now applies its fixed identity transform at the provider-request boundary as well. It is idempotent and edits only the known native identity in instruction fields; it does not freeze or restore a saved whole system prompt. New resources, tool definitions, explicit custom roles, conversation history, and cache-control metadata remain intact. On main, the full-access explanation receives the same treatment using the current authorization policy; Windows does not gain full-access support. The regression failed before the fix and passes afterward, with byte-identical system prompts across user → mailbox wake → tool continuation → user.

The TUI's “after 7m idle” label is also misleading in this occurrence. Core 0.84.2 computes it from two assistant message timestamps, which mark request starts: about seven minutes were spent generating the previous response, followed by only 39 ms before the next request. This is not seven minutes of user inactivity, and is not evidence of an idle cache-expiration threshold. Audit v2 records request start, response end, duration, and the actual gap after the preceding response separately; the native TUI label itself is unchanged.

This closes the reproduced client-side identity reset. The unchanged-prefix zero-cache responses remain a separate observation and cannot be explained by that reset alone. No keepalive, forced compaction, model output cap, header change, or hidden retry was added.

## 2026-09-06 investigation

The fixed ProjectView snapshot change removes a demonstrated client-side prefix mutation. It does not establish that every subsequent cache warning has the same cause.

The newly reported case used `opencode-go/glm-5.3-flash` with a persisted v7 snapshot. There was no compaction or model switch during the miss sequence:

| Request | Reported prompt tokens | Reported cached tokens |
|---|---:|---:|
| Before the miss sequence | 128,520 | 126,336 |
| 1 | 134,349 | 0 |
| 2 | 136,050 | 0 |
| 3 | 137,187 | 0 |
| 4 | 139,707 | 0 |
| 5 | 143,140 | 0 |
| Recovery | 143,410 | 133,760 |

Reconstructing the active Session branch, applying the current ProjectView projection, and replaying it through Pi's Chat Completions adapter preserved every previous message through this sequence. This is **message-history evidence, not a historical full-wire capture**: the original system prompt, tool schemas, headers, and raw response usage were not recorded.

Pi Core 0.84.2 already adds `x-opencode-session` and `x-opencode-client` in `sdk.js` through `mergeProviderAttributionHeaders`. Testing the lower-level pi-ai adapter alone bypasses this layer and can incorrectly suggest that the application omits these headers. Generic `sendSessionAffinityHeaders` is a different setting.

Two bounded live probes used only synthetic text, not project data:

- Growing input from about 135k to 153k tokens produced cached-token counts of 131,072, 153,024, and 153,024 after the first request. Exceeding 128k is not, by itself, a deterministic cache failure.
- With an identical approximately 135k prefix, changing the requested output budget from 32 to 131,072 and back retained 135,040 cached tokens. This did not support adding an output cap as a cache fix.

These probes did **not** reproduce the five-miss sequence. They do not prove the intermittent problem is solved.

OpenCode's published gateway implementation uses a session-based sticky provider, but may select another upstream based on provider availability, budget, and throughput preferences. Upstream response formatting and cache retention can also differ. This makes gateway/upstream behavior a plausible explanation, not a confirmed attribution for this individual Session. The gateway's own normalized billing usage can differ from raw upstream usage, so the TUI's “re-billed” estimate is not an independently verified account charge.

Sources: [Go session requirements](https://opencode.ai/docs/go/#where-can-i-use-it), [gateway routing](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/handler.ts), [sticky provider tracking](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/stickyProviderTracker.ts), [gateway usage normalization](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/provider/openai-compatible.ts). These links track upstream development, not a verified deployment revision.

## Capture the next occurrence without full prompt tracing

After updating/reloading the harness, enable diagnostics in the affected Session:

```text
/cache-audit on
```

Alternatively, start with `pi --cache-audit`. Continue normal work, then inspect the last completed request:

```text
/cache-audit status
```

Disable it with `/cache-audit off`. It is off by default and does not edit prompts, cache keys, headers, model settings, or delivery behavior.

While enabled, each completed Leader response adds a `research-cache-audit` custom entry to the local Session JSONL. The entry is not model-visible context. It records:

- Request size, message count, and the first changed message index; whether observed system, tool schemas, or request settings changed.
- Whether the Go session header exists and matches the current Session, without storing its value or authorization headers.
- HTTP status and Pi's reported input/output/cache token counts.
- Request start, response end, generation/request duration, and idle time since the preceding completed response (v2). The first request after enabling/reloading has no idle comparison.

Only fingerprints are kept in memory for comparison; prompt bodies, tool results, credential values, and per-message hashes are not persisted. The observer runs after bundled payload transformations. A later user-supplied extension could still rewrite the request. It supports message-array payloads, including Chat Completions, Anthropic, and Responses; unsupported shapes have no comparison.

Interpret consecutive records together. An unchanged observed prefix plus a reported zero-cache response narrows the problem toward transport/backend behavior; an early changed message or changed tools/system identifies a client-side investigation target. Model changes, compaction, tree navigation, and explicit role changes can intentionally change the prefix. A setting change is recorded separately and is not automatically evidence of cache invalidation.

## Re-run the synthetic probe from a source checkout

These commands make billed requests to the configured OpenCode account. They never upload Session/project content, make four requests per invocation, and do not retry failures. The output-budget comparison requests the native large output allowance but cancels the stream if generated text exceeds 8192 characters; cancellation is not a guaranteed server-side billing cap.

```sh
node scripts/probe-prompt-cache.mjs --live
node scripts/probe-prompt-cache.mjs --live --compare-output-budget
```

Set `OPENCODE_API_KEY`, or use the checkout's existing `.env`/Pi API-key credential. Output contains only status, model, timing, and raw usage counters—not response text or credentials.
