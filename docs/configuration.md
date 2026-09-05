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

Run `pi paths` to find the effective `agentDir` that owns those Pi-native files. Research Pi merges only its runtime-owned `pi.settings` defaults into native settings and preserves native provider/model/thinking/model-scope choices. An existing v1 Research Pi profile config is migrated once: its selected model seeds missing Pi defaults, the old generated `enabledModels` scope is removed, and the v2 config no longer contains profiles.

The optional credential file remains for API-key workflows and backward compatibility:

```dotenv
DEEPSEEK_API_KEY=...  # official DeepSeek API and/or bounded native Web Search
ZAI_API_KEY=...       # optional API-key provider route
OPENCODE_API_KEY=...  # optional OpenCode route
```

If native `/login` already manages authentication, the matching placeholder may remain empty. `DEEPSEEK_API_KEY` is still required when Research Pi's native DeepSeek search is explicitly enabled.

Explicit Pi CLI model/provider/thinking flags remain native Pi options and flow through unchanged.

## Pi Core defaults owned by Research Pi

`pi.settings` contains the small set of Core defaults Research Pi intentionally supplies, such as theme, TUI mode, retry policy and fallback compaction:

```json
{
  "pi": {
    "settings": {
      "theme": "research-pi",
      "tuiMode": "regular",
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

## Codex defaults

Advisor and executor defaults remain Research Pi settings because they configure delegated Codex Actors rather than the Leader model:

```json
{
  "codex": {
    "advisor": { "model": "gpt-5.6-sol", "reasoningEffort": "max" },
    "executor": { "model": "gpt-5.6-sol", "reasoningEffort": "max" }
  }
}
```

An individual `codex_delegate` call can override model or effort. Existing Codex Actors/threads retain the model recorded for their Action; config changes affect newly started Actions.

## Research compact and ProjectView

```json
{
  "research": {
    "compaction": {
      "softTokens": 278528,
      "hardTokens": 393216,
      "recentTailTokens": [24576, 32768, 40960],
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

The configured token values are caps. For a short-context Leader model, Research Pi derives earlier thresholds from the active model window. `pi.settings.compaction` remains the Pi Core fallback policy; it is not the structured research-state schema or ProjectView policy.

## Bounded search

```json
{
  "research": {
    "search": {
      "enabled": "auto",
      "model": "deepseek-v4-flash",
      "thinkingBudgetTokens": 1024,
      "maxSources": 12,
      "defaultMaxUses": 3
    }
  }
}
```

Search is independent of the Leader provider/model. `auto` loads the tool only when `DEEPSEEK_API_KEY` exists, `on` fails early when that key is absent, and `off` never loads it. Heavy research can still be delegated to Codex; this tool is intended for bounded direct lookup.

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

Manual Research Pi edits are re-read on launch and whenever `/config` opens. Invalid JSON, unknown top-level keys, impossible compact thresholds or credential-like fields fail clearly. A v1 config is rewritten to v2 on first launch; removed keys are not retained as compatibility behavior.

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
