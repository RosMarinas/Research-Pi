# Intermittent prompt-cache misses

Pi 1.0 migration note (2026-10-02): the synthetic flat `cached_tokens` replay now reports `cacheRead=90`, matching the wire value. No parser patch is needed. The investigation below documents Pi 0.84.2 and its observed sessions; it does not establish current GPT cache behavior. Research identity now uses the native structured-transcript hook rather than provider-specific payload rewriting.

## 2026-09-06 systematic investigation after the identity fix

### Question and competing explanations

The remaining question is why a tool continuation can report zero cached tokens even after the demonstrated client-side prefix mutations were removed. A passing prefix regression alone is not an answer. Inspect the complete path:

| Layer | Discriminating observation | Current evidence |
|---|---|---|
| Session / ProjectView / mailbox | Old content changes before provider conversion | Fixed-snapshot and immutable-mailbox regressions pass; current v2 requests are append-only |
| System identity / tool schemas / settings | Early instruction or schema changes | Current v2 records show no changes, including after tool results |
| SDK serialization / final headers / retries | Actual HTTP differs from the payload hook or Go session attribution changes | New opt-in transport observer closes this previously unmeasured boundary |
| Gateway / upstream cache | Stable final HTTP prefix but explicit zero cache in raw usage | Plausible; needs correlation with the newly observed real response |
| SSE usage / Pi parser | Raw cache count is positive but Pi reports zero, or a later usage update overwrites it | One parser blind spot reproduced offline; not yet attributed to the real Session |
| TUI warning / cost estimate | Warning treats unknown counters as zero or generation time as idle | Request-start-based idle heuristic is misleading; estimated re-billing is not an account invoice |

### Current Session evidence

After diagnostics were enabled again, v2 captured eleven completed requests from 04:47:25 to 04:52:46 UTC. Every comparable request retained the complete preceding message array, route, system fields, tools, and settings; Go session headers were present and matched. The sequence included both zero-cache responses and recoveries. For example:

| v2 sequence | Gap after previous response | Cached tokens | Old request prefix |
|---|---:|---:|---|
| 2 | 59 ms | 0 | unchanged |
| 6 | 394 ms | 189,696 | unchanged |
| 7 | 78,420 ms | 196,992 | unchanged |
| 8 | 31 ms | 0 | unchanged |
| 9 | 39 ms | 196,992 | unchanged |
| 10 | 129 ms | 201,856 | unchanged |
| 11 | 201 ms | 204,288 | unchanged |

This supports an intermittent failure/reporting problem, not a deterministic rule that every tool result invalidates the prefix. These are payload-hook and normalized-usage observations, not yet final-HTTP/raw-SSE evidence. The active launcher and native module path belong to this checkout; the v2 records confirm that the updated observer was loaded.

### Bounded synthetic transport controls

Eight successful requests used only synthetic data: 40 scripted tool-call/result pairs, a single synthetic tool schema, and about 188k input tokens. They passed through the pinned Pi Chat Completions adapter and native Go attribution headers. Each arm repeated the identical final HTTP body twice after its cold request, then appended another synthetic call/result pair. Both used the same session header within their arm. Raw SSE usage was compared directly with Pi's parsed counters.

| Requested output budget | Cold cache | Identical repeat 1 | Identical repeat 2 | Appended tool pair |
|---|---:|---:|---:|---:|
| 128 | 0 | 188,160 | 188,160 | 188,160 |
| 131,072 | 0 | 188,160 | 188,160 | 188,160 |

Input was 188,166 tokens, growing to 188,545. Each output was only 11 tokens. Raw cache counts and Pi's parsed counts agreed in all eight requests. This weakens explanations based solely on input length, tool history, HTTP serialization, or the output reservation. It does **not** test long generation, realistic multi-tool schemas, all sessions/backends, or the complete autonomous Runtime lifecycle. The static catalog lacks the active `glm-5.3-flash` alias, so the probe explicitly uses GLM-family adapter metadata while sending that exact observed alias; it does not silently switch served models or claim a catalog-based price estimate.

An offline SSE replay exposed a separate, concrete compatibility gap: `{prompt_tokens:100, cached_tokens:90}` produces `cacheRead:0` in the pinned adapter, which reads nested `prompt_tokens_details.cached_tokens` or `prompt_cache_hit_tokens` instead. The successful live controls returned the nested form. Do not apply a parser workaround to the real incident until its raw response establishes which form it uses.

### The next decisive measurement, not another context patch

With `/cache-audit on`, `research-cache-transport` entries now record the final outgoing prefix comparison, its agreement with the payload hook, actual Go header presence/match, output reservation, HTTP attempt number, and **all numerical raw SSE usage updates**. No raw body, credential, URL, or response text is persisted. The observer returns the original fetch response unchanged and consumes a clone for diagnostics. It observes Go Chat Completions only, and only while the Session has a pending audited request. Off/reload restores the fetch function; an explicit on/off preference now survives reload within that Session.

Interpret matching sequence numbers together:

1. Final HTTP differs from the hook: locate the downstream transport transform before changing memory.
2. Raw cache is positive but parsed cache is zero: fix and replay-test the usage parser/reporting path.
3. Raw cache field is absent: classify it as unknown, not evidence of an actual total miss.
4. Final prefix is stable and raw cache explicitly zero: investigate provider cache residency/routing; client prefix rewrites cannot repair a cache it does not control.

Until that measurement discriminates the remaining causes, do not add keepalives, force compaction, reduce output budgets, switch providers, or accumulate more context patches. Long-generation and multi-tool controls are the next synthetic interventions only if the real wire observation leaves them relevant.

Run the synthetic control from a checkout (billed, at most four requests per invocation):

```sh
node scripts/diagnose-cache-transport.mjs --live
node scripts/diagnose-cache-transport.mjs --live --native-output-budget
```

The native-budget arm cancels if streamed output exceeds 8192 characters; cancellation is not a guaranteed server billing cap. No live experiment uploads research transcripts or executes returned tool calls.

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

Disable it with `/cache-audit off`. It is off by default; an explicit on/off choice is stored as a non-model-visible Session entry and survives reload. It does not edit prompts, cache keys, headers, model settings, or delivery behavior.

While enabled, each completed Leader response adds a `research-cache-audit` custom entry to the local Session JSONL. The entry is not model-visible context. It records:

- Request size, message count, and the first changed message index; whether observed system, tool schemas, or request settings changed.
- Whether the Go session header exists and matches the current Session, without storing its value or authorization headers.
- HTTP status and Pi's reported input/output/cache token counts.
- Request start, response end, generation/request duration, and idle time since the preceding completed response (v2). The first request after enabling/reloading has no idle comparison.

Only fingerprints are kept in memory for comparison; prompt bodies, tool results, credential values, and per-message hashes are not persisted. The observer runs after bundled payload transformations. A later user-supplied extension could still rewrite the request. It supports message-array payloads, including Chat Completions, Anthropic, and Responses; unsupported shapes have no comparison.

For Go Chat Completions, the separate transport observer also compares the final HTTP body and extracts only numerical usage fields from raw SSE, covering downstream transformations that the payload hook cannot see. Missing transport entries mean that boundary was not observed, not that it matched.

Interpret consecutive records together. An unchanged observed prefix plus a reported zero-cache response narrows the problem toward transport/backend behavior; an early changed message or changed tools/system identifies a client-side investigation target. Model changes, compaction, tree navigation, and explicit role changes can intentionally change the prefix. A setting change is recorded separately and is not automatically evidence of cache invalidation.

## Re-run the synthetic probe from a source checkout

These commands make billed requests to the configured OpenCode account. They never upload Session/project content, make four requests per invocation, and do not retry failures. The output-budget comparison requests the native large output allowance but cancels the stream if generated text exceeds 8192 characters; cancellation is not a guaranteed server-side billing cap.

```sh
node scripts/probe-prompt-cache.mjs --live
node scripts/probe-prompt-cache.mjs --live --compare-output-budget
```

Set `OPENCODE_API_KEY`, or use the checkout's existing `.env`/Pi API-key credential. Output contains only status, model, timing, and raw usage counters—not response text or credentials.
