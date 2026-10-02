# Research Pi Configuration

Research Pi has one non-secret configuration for the research runtime. Leader model discovery, provider authentication, model scope and thinking controls belong to Pi Core rather than a second Research Pi profile system.

## Locations

| Runtime | Research Pi config | Optional environment credentials |
|---|---|---|
| Source checkout | `<harness>/.pi/config.json` | `<harness>/.env` |
| Stable package | `~/.config/research-pi/config.json` | `~/.config/research-pi/credentials.env` |

Source worktrees intentionally have separate config and state. `.pi/config.defaults.json` is the reviewed template. The local `config.json` is ignored by Git and written with mode `0600`.

Inspect the effective paths and Research Pi settings with:

```sh
pi paths
pi config path
pi config show
```

API keys, passwords, private keys and other credentials do not belong in `config.json`; credential-like field names are rejected. Safety boundaries and recovery invariants are code policy rather than convenience toggles.

## Leader models and providers: use Pi directly

Research Pi does not keep `activeProfile`, a curated provider catalog, generated model definitions, or a second `/model` implementation. Use the native Pi commands:

| Need | Command |
|---|---|
| Authenticate a provider/subscription | `/login` and `/logout` |
| Select the active model | `/model` or `Ctrl+L` |
| Choose which models enter cycling | `/scoped-models` |
| Adjust thinking and other Core settings | `/settings` |
| Refresh Pi's model catalog after an update | `pi update --models` |

This has two practical consequences:

- a newly available subscription model can be selected as soon as Pi Core/provider metadata exposes it; Research Pi need not add another profile;
- native `settings.json`, authentication state and `models.json` remain authoritative and are not reconstructed on every Research Pi launch.

Run `pi paths` to find the effective `agentDir` that owns those Pi-native files. Research Pi merges only its runtime-owned `pi.settings` defaults into native settings and preserves native provider/model/thinking/model-scope choices. An existing v1 Research Pi profile config is migrated once: its selected model seeds missing Pi defaults, the old generated `enabledModels` scope is removed, and the v3 config no longer contains profiles. Existing v2 Codex advisor/executor settings are also migrated into the unified subagent roles.

The optional credential file remains for API-key workflows and backward compatibility:

```dotenv
DEEPSEEK_API_KEY=...  # official DeepSeek API and/or bounded native Web Search
ZAI_API_KEY=...       # optional API-key provider route
OPENCODE_API_KEY=...  # optional OpenCode route
```

If native `/login` already manages authentication, the matching placeholder may remain empty. `DEEPSEEK_API_KEY` is still required when Research Pi's native DeepSeek search is explicitly enabled.

Explicit Pi CLI model/provider/thinking flags remain native Pi options and flow through unchanged.

For GPT subscription use, `/login openai-codex` keeps the existing Codex route. Pi 1.0's newer `/login openai` offers Sign in with ChatGPT; the Codex provider is now labelled legacy upstream. Choose the matching provider in `/model`. Delegated workers still use the independently authenticated Codex CLI (`codex login`), not Pi's `auth.json`. Never copy OAuth tokens between stores. See [Pi 1.0 migration](pi-1-migration.md).

## Pi Core defaults owned by Research Pi

`pi.settings` contains the small set of Core defaults Research Pi intentionally supplies, such as theme, TUI mode, retry policy and fallback compaction:

```json
{
  "pi": {
    "settings": {
      "theme": "research-pi",
      "tuiMode": "regular",
      "defaultTools": ["+codemode"],
      "retry": {
        "enabled": true,
        "maxRetries": 2,
        "provider": {
          "maxRetries": 0,
          "maxRetryDelayMs": 30000
        }
      },
      "compaction": {
        "enabled": true,
        "reserveTokens": 16384,
        "keepRecentTokens": 32768
      }
    }
  }
}
```

These values do not define or filter models. Research Pi never creates or overwrites native `models.json`.

Research Pi explicitly loads `builtin:codemode` and `builtin:tool-search` because Pi 1.0's `--no-extensions` disables built-ins too. Codemode is enabled by default; the `on` mode retains direct tool calls as well. MCP and llama.cpp remain opt-in (`-e builtin:mcp` or `-e builtin:llama.cpp`). Analysis Sessions keep their read-only tool allowlist and do not expose codemode's model operations.

## Subagent runners

All delegated workers enter through one `subagent` tool and one Runtime Actor model. A role provides the default routing policy; each Action still records the concrete backend, model, and thinking level so the user can supervise what actually ran.

```json
{
  "subagents": {
    "advisor": { "backend": "codex", "model": "gpt-5.6-sol", "thinking": "max", "speed": "inherit" },
    "executor": { "backend": "codex", "model": "gpt-5.6-sol", "thinking": "max", "speed": "inherit" },
    "environment": { "backend": "antigravity", "model": "gemini-3.1-pro-high", "thinking": "high" },
    "general": { "backend": "pi", "model": "inherit", "thinking": "inherit" }
  },
  "codex": {
    "maxExecutors": 4,
    "internalSubagent": { "model": "inherit", "thinking": "inherit" },
    "retention": { "terminalDays": 30, "keepTerminalJobs": 200 }
  }
}
```

The defaults deliberately make Codex advisor/executor the main design, implementation, and verification routes; Antigravity is the environment/toolchain specialist; Pi is the general alternate runner. These are defaults, not separate tool types. The Leader may select another backend for an Action by supplying `role`, `backend`, `model`, and `thinking`, and the user can change each role's defaults with `/models`.

The Pi runner launches Pi Core in a separate RPC Session. It reuses the same Pi provider catalog and authentication directory as the Leader, while retaining an independent model, thinking level, conversation, and Runtime Actor. It loads the project boundary; any approval dialog that cannot be represented in the isolated RPC channel is declined and reported rather than hanging or silently widening authority. The Antigravity runner uses its documented [bidirectional streaming JSON protocol](https://antigravity.google/docs/cli/headless/) and keeps the same process for follow-up messages; launch `agy` interactively once for [first-time authentication](https://antigravity.google/docs/cli/install/). Because headless mode cannot display permission prompts, non-advisor Antigravity Actions auto-approve tools inside the CLI's explicit `--sandbox`; advisor remains plan mode without that override. Neither runner creates a handoff file; task context and later steering travel through their live message stream and the Runtime mailbox.

### Unified model settings

Codex jobs are durable and may recover across Leader Sessions. Pi and Antigravity runners currently belong to the Pi process that started them: follow-up messages reuse their live backend Session, shutdown closes them, and a new Pi process does not automatically restore them. Runtime records remain inspectable. The shared interface does not extend Codex's scoped concurrency, resource scheduler, or host broker to the other backends.

`/models` (also `/config models`) opens the role → setting → value selector. `/models show` displays current settings. Leader and Pi-runner choices use Pi's authenticated catalog, Codex choices use `model/list`, and Antigravity choices use `agy models`; catalog reads do not create a model turn. Native `/model`, `/thinking`, `/scoped-models` and `/login` remain available.

```text
/models leader model openai-codex/gpt-6-astra
/models executor model gpt-6-astra
/models advisor thinking high
/models environment model gemini-3.1-pro-high
/models general model opencode-go/kimi-k2.5
/models general thinking high
/models internal model gpt-6-luna
/models executor speed fast
/fast on
/fast off
```

Leader model/thinking choices apply immediately and persist in native Pi `settings.json`; no duplicate model profile is created. Native Pi menus reload their saved-default indicators after `/reload` or restart. Runner changes apply to new Actions immediately in this Pi process and persist in Research Pi config. An individual `subagent` call can override backend, model, thinking, or Codex speed. Resuming an Actor retains its captured settings unless explicitly overridden. Running Actions are never changed by the settings panel.

`inherit` leaves native Codex/Pi configuration untouched; `standard` explicitly requests normal speed, and `fast` requests `priority`. Enabling Fast asks for confirmation because it consumes extra quota; it does not lower reasoning effort. `/fast` without arguments toggles the current GPT Leader; `status` inspects and `inherit` removes its override. Leader speed is stored per `provider/model` under `pi.modelServiceTiers`, and applies only to native GPT Responses/Codex requests, not unrelated providers. Account/model eligibility still applies; this is a request, not a guarantee of latency. See [Codex speed and current quota rates](https://learn.chatgpt.com/docs/agent-configuration/speed).

The `/models internal` role is intentionally separate: it configures agents spawned **inside a Codex worker**, not a top-level Research Pi subagent. The worker passes native `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort` overrides to its own Codex process, never edits global `~/.codex/config.toml`, and leaves permissions unchanged. Internal-agent speed inherits its parent; explicit spawn settings and custom agent files retain native precedence. See [Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Every top-level subagent appears in `/actors`, the Runtime Dock, and `/watch` with `backend · role · model · thinking`. The user may bypass the Leader for operational control with `/message notify @actor ...`, `/message reply @actor ...`, or `/steer @actor ...`; the same Runtime message protocol routes the input to the owning backend.

`maxExecutors` caps concurrent executors in each exact workspace, including jobs paused for input. Start independent background jobs with different missions and literal workspace-relative `writeScope` paths. Disjoint paths may run together; identical or ancestor/descendant paths conflict. Omitted scope means `["."]`, an exclusive whole-workspace writer. Resume inherits the prior scope unless the caller explicitly supplies a new one. A capacity error returns immediately: dispatch remaining work after a result instead of polling.

Executors have `research_pi_collaborate`: `peers` discovers active same-workspace/same-track collaborators, `send` queues a directed message (at most 2,000 characters), and `inbox` reads recent messages/receipts. Delivery uses the recipient's existing active turn; it does not restart a finished worker. `queued` is not delivered; `applied` means submitted to the turn, not acknowledged or acted upon. Peer input cannot change task authority or write ownership. The Leader can inspect receipts with `subagent action=messages, jobId=...`; conversations are not broadcast into Leader context. Advisors cannot send executor messages. Old dynamic-tool threads refresh once on their next explicit resume; running jobs are not interrupted by this upgrade.

For shared compute or run directories, optionally supply `resourceClaims`, such as `["gpu:server-a:0", "run:server-a:/runs/ablation"]`. Keys must match exactly across dispatchers using the same Research Pi state store, including different workspaces. Conflicts return immediately; this is coordination, not an OS/cluster lock. An optional `experiment` brief contains `question`, `distinguishingOutcomes`, `validityChecks`, and `budgetAndStop`; omit it for ordinary code tasks. The budget is worker guidance, not automatic remote cancellation.

`research_pi_run` registers a real external run ID, target, and existing log/manifest references. Its state is independent of worker completion and scientific validity. Registered live runs keep their resource claims after the worker ends. Workers can settle their own runs after inspecting terminal evidence; the Leader uses `subagent action=settle_run` with `jobId`, `runId`, `outcome`, and `note`. Failed/cancelled workers that entered execution conservatively retain resources; after inspecting external state and settling registered runs, use `action=release_resources` with an evidence `note`. Neither operation kills processes. To resume only to inspect an earlier still-running experiment, pass `resourceClaims: []`; the same Actor can use `ownerJobId` to inspect/settle its earlier same-track run. Active runs and held resources are exempt from terminal-job retention.

Scopes coordinate the declared ownership of writes; the OS sandbox still covers the whole project. Workers must not write outside their assigned paths. The Leader coordinates shared GPU/run resources and integration; scoped workers must not commit or modify shared Git state. `outcome_unknown` blocks overlapping scopes until explicit reconciliation; legacy jobs with no scope conservatively block the whole workspace. Restart old Research Pi Leaders before using the new scheduler: older schedulers cannot see the new per-job claims.

Once per day at launch, Research Pi archives a terminal job only when it is both older than `terminalDays` and outside the newest `keepTerminalJobs`. Active, input-required and `outcome_unknown` jobs are never archived. The structured job/result remains readable by exact job ID from one `codex/archive/jobs.jsonl`; per-job token events, stderr and worker files are removed. Codex thread/context SQLite is not changed.

## Project-local experiment records

`record_experiment` appends one canonical memo to `<project>/.pi/research/experiments.jsonl`; it does not create Markdown or copy artifacts. On first Git-backed launch Research Pi adds `/.pi/` to the repository's local `.git/info/exclude` when no existing ignore rule covers it. This leaves shared `.gitignore` and the working tree unchanged, including in linked worktrees.

Ordinary questions, fixes, probes, and successful commands need no permanent memo or new document. Decision-changing results use one short ledger record (normally 5–8 statements plus evidence references), not duplicate Markdown. Workers return concise structured results; the Leader decides whether to record them. Documents are created only for an actual document deliverable, preferably updating its existing canonical path. A protocol/settlement pair is not mandatory for each batch. Existing documents and raw evidence are preserved; summary length limits never truncate the original artifacts.

## Research compact and ProjectView

```json
{
  "research": {
    "compaction": {
      "softTokens": 368640,
      "hardTokens": 393216,
      "summaryTargetTokens": 8192,
      "summaryMaxTokens": 16384
    }
  }
}
```

Research compaction now produces two deliberately different forms of project memory:

ProjectView adds a user-owned layer before those compact-generated forms:

1. **Project Anchor** is the optional regular file `<project>/RESEARCH.md`. Research Pi links its relative path and captures at most the first 3600 characters. It is never generated or rewritten by compaction. Edits appear in the next snapshot, not by rewriting the current Session prefix; explicitly read the file or communicate urgent changes in conversation.
2. **Project Brief** is captured only at a successful compact boundary. It contains a short project overview, final goal, overall approach, durable user priorities, and concise closed phases in `goal -> approach -> result` form. It excludes the active run, current claim, newest route, Git state and next experiment. Its compact-generated portion remains stable until the next successful compact.
3. **Project frontier** contains current route/freshness, latest handoff, newest evidence, Actions, structured current frontier and candidate next experiment. Together with Anchor and Brief it forms one persisted snapshot at project-context initialization and after successful local compaction. Explicit role/context changes establish a new snapshot. Ordinary user turns, tool continuations, UI refreshes, and Session resume retain the exact snapshot; there is no automatic request-tail Delta. Later progress travels through ordinary conversation, tool results, and directed messages. Consuming a delivered mailbox message prevents redelivery, not retention in conversation history.

`amend_project_state`, research transitions, evidence records and completed work update the stored records and inspectable live view, not the injected snapshot. Retrieve current records when needed. The next successful compact may update the Brief and move a genuinely closed phase into its short history. The compaction schema requires the complete `projectBrief`; live state-amendment tooling cannot edit it. Analysis compaction refreshes its local snapshot without writing shared Project State. Prefix stability is client-side behavior, not a guarantee of provider cache retention or routing.

There is deliberately no global ProjectView-clear command. `/runtime new clean` creates a clean Session without deleting Project data; `/runtime context off` pauses injection for an Analysis Session. Removing `RESEARCH.md` removes only the Anchor. Canonical Project State changes remain explicit amendments, transitions, or compaction rather than hidden context deletion.

Defaults are 360k soft / 384k hard (368,640 / 393,216 tokens, using 1k = 1,024). Automatic research compaction runs when the current agent run settles, without interrupting tool calls; crossing the hard threshold upgrades a pending soft request. For a short-context Leader, both thresholds scale down with the same configured ratio to stay within its window. `pi.settings.compaction` remains the Pi Core fallback policy; it is not the structured research-state schema or ProjectView policy.

On Pi 1.0, Core also owns the retained history boundary through `pi.settings.compaction.keepRecentTokens`. Research Pi uses the native preparation so context edits and nested tool operations survive correctly. The unused v2 `research.compaction.recentTailTokens` schedule is removed during configuration migration. Historical compaction records remain readable; no raw history is re-sliced.

## Prompt-cache diagnostics

For intermittent cache warnings, enable `/cache-audit on` or launch with `pi --cache-audit`. This opt-in observer records redacted request-prefix comparisons and reported usage in local Session metadata; it does not rewrite the request. See [cache diagnostics](cache-diagnostics.md) for interpretation and synthetic probes.

## Optional DeepSeek search

```json
{
  "research": {
    "search": {
      "enabled": "off",
      "model": "deepseek-v4-flash",
      "thinkingBudgetTokens": 1024,
      "maxSources": 12,
      "defaultMaxUses": 3
    }
  }
}
```

This setting controls only Research Pi's optional DeepSeek-backed `web_search` tool. It is independent of the Leader provider/model and defaults to `off`: `auto` loads it only when `DEEPSEEK_API_KEY` exists, `on` fails early when that key is absent, and `off` never loads it. Codex subagents are separate and always receive [native live web search](https://learn.chatgpt.com/docs/config-file/config-basic); there is no Research Pi search router or per-task search policy to configure. Pi and Antigravity retain their own backend-native capabilities, and an explicitly configured MCP search server remains available.

The DeepSeek V4 Pro anchor is no longer in the default extension loadout. Its existing opt-in experiment remains available with `pi --v4-pro-anchor`, or load its command with `RESEARCH_PI_DEEPSEEK_ANCHOR=1 pi`. It still requires the exact supported provider/model and a fresh Session; it does not modify GPT requests.

## Skills, UI and diagnostics

Research Pi uses Pi's `--no-skills`, always loads the packaged `research-briefing` skill, and then loads the external allowlist in `resources.skills`. Missing external paths are skipped. One-off `--skill` and explicitly trusted `--extension` paths remain available.

Three Research Pi palettes are bundled:

- `research-pi` (`Ocean`);
- `research-graphite` (`Graphite`);
- `research-ember` (`Ember`).

Pi Core's `dark` and `light` remain available. Persist a Research Pi theme with `/config theme <name>` or `pi config theme <name>`. `/config themes` lists choices.

```json
{
  "ui": {
    "density": "balanced",
    "runtimeStrip": "auto",
    "configPanelRows": 8
  },
  "diagnostics": {
    "trace": false,
    "codexSqliteLogs": false
  }
}
```

`runtimeStrip=auto` shows the Project/Actor dock only while work is active or Runtime state needs attention; `always` keeps an idle view and `off` removes it. `density` is `compact` or `balanced`.

`diagnostics.trace` enables sensitive prompt/tool tracing. `diagnostics.codexSqliteLogs` restores Codex App Server TRACE/DEBUG SQLite logging. Both default to false because they can cause substantial disk writes and should only be enabled briefly for diagnosis.

## Precedence and migration

For Research Pi-owned fields:

1. `.pi/config.defaults.json`;
2. user `config.json`;
3. explicit diagnostic/operational environment variables.

For Leader model/auth/thinking, Pi Core's native precedence applies; Research Pi adds no profile layer and no forced startup model arguments.

Manual Research Pi edits are re-read on launch and whenever `/config` opens. Invalid JSON, unknown top-level keys, impossible compact thresholds or credential-like fields fail clearly. A v1 or v2 config is rewritten to v3 on first launch; removed keys are not retained as compatibility behavior.

## Minimal smoke test

After an update:

```sh
pi setup
pi paths
pi
```

In the TUI:

1. run `/login` if the desired provider is not authenticated;
2. select any available model with `/model`;
3. optionally adjust `/scoped-models` and `/settings`;
4. ask for one short response, exit, relaunch, and confirm Pi retained the native selection;
5. run `/runtime view` to inspect the current ProjectView; the model's automatic snapshot stays fixed until compaction or an explicit context/role change.

This is sufficient for an ordinary route check. Long-context continuation, compact quality and cache behavior are best judged during real project use.
