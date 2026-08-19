# Research Pi Configuration

Research Pi uses one user-facing, non-secret `config.json`.

## Locations

| Runtime | Config | Credentials |
|---|---|---|
| Source checkout | `<harness>/.pi/config.json` | `<harness>/.env` |
| Stable package | `~/.config/research-pi/config.json` | `~/.config/research-pi/credentials.env` |

Source worktrees intentionally have separate configs and state. The reviewed initial template is `.pi/config.defaults.json`; the local `config.json` is generated with mode `0600` and ignored by Git.

Find the effective path and configuration with:

```sh
pi config path
pi config show
```

API keys, passwords, private keys and other credentials do not belong in this file. Credential-like field names are rejected. Safety boundaries and recovery invariants are code policy rather than convenience toggles.

## Model profiles

`activeProfile` is the persistent default for the Research Leader. Every profile identifies one provider/model/thinking tuple:

```json
{
  "activeProfile": "deepseek-pro",
  "profiles": {
    "deepseek-pro": {
      "label": "DeepSeek V4 Pro",
      "description": "Best default quality for research leadership.",
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "thinking": "max"
    },
    "deepseek-flash": {
      "label": "DeepSeek V4 Flash",
      "description": "Lower latency for bounded work.",
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "thinking": "max"
    }
  }
}
```

Persistent switching:

```sh
pi config list
pi config use deepseek-flash
```

One-launch override:

```sh
pi --profile deepseek-pro
```

Inside the TUI, `/config` opens the profile overlay and persists the selected profile. `/config use <name>` does the same without the picker. Pi's native `Ctrl+L` and `/model` remain session-local overrides.

Explicit Pi CLI `--provider`, `--model`, and `--thinking` arguments are appended after the selected profile and therefore win for that invocation.

## Pi Core settings

`pi.settings` is passed through to the generated Pi Core `settings.json`. It can contain supported Pi settings such as theme, TUI mode, retry, cache notices, editor layout and core fallback compaction:

```json
{
  "pi": {
    "settings": {
      "theme": "dark",
      "tuiMode": "regular",
      "showCacheMissNotices": true,
      "retry": {
        "enabled": true,
        "maxRetries": 2,
        "provider": {
          "maxRetries": 0,
          "maxRetryDelayMs": 30000
        }
      }
    }
  }
}
```

Research Pi generates internal `settings.json` and `models.json` adapters in the runtime agent directory on startup. Do not edit those generated files; the next startup reconstructs them from `config.json`.

## Codex defaults

Advisor and executor defaults are independent:

```json
{
  "codex": {
    "advisor": { "model": "gpt-5.6-sol", "reasoningEffort": "max" },
    "executor": { "model": "gpt-5.6-sol", "reasoningEffort": "max" }
  }
}
```

An individual `codex_delegate` call can still override model or effort. Existing Codex Actors/threads retain the model recorded for their Action; changing config affects newly started Actions.

## Research compact and search

```json
{
  "research": {
    "compaction": {
      "softTokens": 278528,
      "hardTokens": 393216,
      "recentTailTokens": [32768, 40960, 49152]
    },
    "search": {
      "model": "deepseek-v4-flash",
      "thinkingBudgetTokens": 1024,
      "maxSources": 12,
      "defaultMaxUses": 3
    }
  }
}
```

These values configure Research Pi's structured compaction and bounded native Web Search. `pi.settings.compaction` remains the Pi Core fallback policy; it is not the research-state schema or dynamic tail schedule.

## Skills, UI and diagnostics

`resources.skills` is the complete default skill allowlist used with Pi's `--no-skills`. Missing paths are skipped. A one-off `--skill` argument remains possible.

`ui.showProfileStatus` controls the compact `◇ profile` status item. `ui.configPanelRows` controls the native profile overlay height.

`diagnostics.trace` enables the sensitive Pi trace extension for ordinary `pi` startup; `pi-traced` remains the explicit one-shot override. `diagnostics.codexSqliteLogs` restores Codex App Server internal TRACE/DEBUG SQLite logging. Both defaults are false and should be returned to false after diagnosis.

## Precedence

From lowest to highest:

1. `.pi/config.defaults.json`;
2. user `config.json`;
3. a one-launch `--profile`;
4. explicit Pi CLI model/thinking flags;
5. explicit environment variables for diagnostic or operational overrides.

Manual edits are re-read on each launch and whenever `/config` opens. Invalid JSON, an unknown top-level key, an absent active profile, impossible compact thresholds or credential-like fields fail clearly instead of silently falling back.
