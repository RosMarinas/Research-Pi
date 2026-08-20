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

API keys, passwords, private keys and other credentials do not belong in this file. Credential-like field names are rejected. `pi setup` creates placeholders for `DEEPSEEK_API_KEY` and `OPENCODE_API_KEY` in the separate credentials file and preserves existing values when a later update adds another provider. Safety boundaries and recovery invariants are code policy rather than convenience toggles.

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
    },
    "opencode-go-flash": {
      "label": "OpenCode Go · DeepSeek V4 Flash",
      "description": "Recommended subscription route for routine research leadership.",
      "provider": "opencode-go",
      "model": "deepseek-v4-flash",
      "thinking": "max"
    },
    "opencode-go-luna": {
      "label": "OpenCode Go · GPT 5.6 Luna",
      "description": "Fast general project coordination with lower reasoning cost.",
      "provider": "opencode-go",
      "model": "gpt-5.6-luna",
      "thinking": "high"
    },
    "opencode-go-qwen": {
      "label": "OpenCode Go · Qwen3.7 Plus",
      "description": "Long-context alternative for routine coordination and handoffs.",
      "provider": "opencode-go",
      "model": "qwen3.7-plus",
      "thinking": "high"
    }
  }
}
```

Persistent switching:

```sh
pi config list
pi config use opencode-go-flash
```

One-launch override:

```sh
pi --profile opencode-go-luna
```

Inside the TUI, `/model` or `Ctrl+L` is the single model picker. It opens on the generated scoped catalog; selecting a known model or cycling with Ctrl+P persists the matching `activeProfile` and its configured thinking level. A later Shift+Tab change updates that profile's default thinking. Session restore does not rewrite the global default. `/config use <name>` remains a compatibility command, while `/config` itself now shows the non-model configuration summary.

Pi Core's lower-level `/scoped-models` command is hidden from Research Pi command completion because `profiles` already owns that list. Direct invocation still works as an escape hatch, but its generated-settings change is replaced from `config.json` at the next Research Pi launch. The native `/model` selector retains its `all/scoped` Tab as a Core escape hatch; ordinary Research Pi use stays on `scoped`.

Explicit Pi CLI `--provider`, `--model`, and `--thinking` arguments are appended after the selected profile and therefore win for that invocation.

The profile list is intentionally curated instead of mirroring every model in OpenCode Go. It contains the two official DeepSeek routes plus eleven Go routes requested for Research Pi: `mimo-v2.5`, `deepseek-v4-flash`, `qwen3.7-plus`, `minimax-m3`, `gpt-5.6-luna`, `deepseek-v4-pro`, `glm-5.2`, `qwen3.8-max`, `grok-4.5`, `kimi-k3`, and `hy3`. Muse Spark is excluded because the pinned Pi catalog does not define it and its provider terms permit training on prompts/completions. Pi Core owns endpoint/model metadata. To add another built-in Go model, copy a profile and change only `label`, `provider`, `model`, and `thinking`; use `provider: "opencode-go"` and a model ID supported by the pinned Pi Core.

Credentials remain provider-specific:

```dotenv
DEEPSEEK_API_KEY=...  # official DeepSeek leader and/or native Web Search
OPENCODE_API_KEY=...  # all OpenCode Go profiles
```

## Pi Core settings

`pi.settings` is passed through to the generated Pi Core `settings.json`. It can contain supported Pi settings such as theme, TUI mode, retry, cache notices, editor layout and core fallback compaction:

```json
{
  "pi": {
    "settings": {
      "theme": "research-pi",
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
      "enabled": "auto",
      "model": "deepseek-v4-flash",
      "thinkingBudgetTokens": 1024,
      "maxSources": 12,
      "defaultMaxUses": 3
    }
  }
}
```

These values configure Research Pi's structured compaction and bounded native Web Search. Search is independent of the active Leader profile: `auto` loads the tool only when `DEEPSEEK_API_KEY` exists, `on` fails early when that key is absent, and `off` never loads it. OpenCode Go is not assumed to implement DeepSeek's native search extension. Compact thresholds are caps: for a short-context model such as Hy3, Research Pi derives earlier soft/hard thresholds from the active model window. `pi.settings.compaction` remains the Pi Core fallback policy; it is not the research-state schema or dynamic tail schedule.

## Provider smoke test

After an update, run:

```sh
pi setup
pi config list
pi --profile opencode-go-flash
```

In the TUI, ask for a one-sentence response without tools, then open `/model` and switch once to `opencode-go/gpt-5.6-luna` or `opencode-go/qwen3.7-plus`. Confirm the footer shows the intended provider/model, `pi config show` reports the matching active profile after exit, and the next response succeeds. Typing `/sc` should not offer `/scoped-models`. If `DEEPSEEK_API_KEY` is also configured, ask for one current fact that requires `web_search`; if it is intentionally absent, confirm `web_search` is not listed among the tools. This is sufficient for ordinary route validation. Tool calls, long-context continuation, compaction and cache behavior should be judged during real project use rather than by an expensive synthetic matrix.

## Skills, UI and diagnostics

`resources.skills` is the complete default skill allowlist used with Pi's `--no-skills`. Missing paths are skipped. A one-off `--skill` argument remains possible.

Research Pi explicitly loads its bundled theme set, so all three palettes are available in both source and packaged installs. `pi.settings.theme` may still select `dark`, `light`, or another explicitly loaded Pi theme.

Three Research Pi palettes are bundled:

- `research-pi` (`Ocean`): cyan/indigo/violet;
- `research-graphite` (`Graphite`): restrained low-saturation aqua;
- `research-ember` (`Ember`): warm copper/amber with teal.

Pi Core's `dark` and `light` remain available. Persist a selection with `/config theme <name>` in the TUI or `pi config theme <name>` in the shell. `/config themes` and `pi config themes` list choices. Pi's native theme setting remains a session-local alternative, while Research Pi config is the next-launch authority.

The UI policy is intentionally semantic rather than pixel-based:

```json
{
  "ui": {
    "density": "balanced",
    "runtimeStrip": "auto",
    "showProfileStatus": false,
    "configPanelRows": 8
  }
}
```

`runtimeStrip=auto` shows the compact Project/Actor dock only while work is active or Runtime state needs attention; `always` keeps the single-line idle view and `off` removes it. `density` is `compact` or `balanced`. `showProfileStatus` controls the optional `◇ profile` footer item; it defaults off because Pi already renders the effective model and thinking level. Terminal breakpoints and Board columns adapt automatically and are not user-configured pixels. `configPanelRows` controls Research Pi selector height, currently used by the theme panel.

`diagnostics.trace` enables the sensitive Pi trace extension for ordinary `pi` startup; `pi-traced` remains the explicit one-shot override. `diagnostics.codexSqliteLogs` restores Codex App Server internal TRACE/DEBUG SQLite logging. Both defaults are false and should be returned to false after diagnosis.

## Precedence

From lowest to highest:

1. `.pi/config.defaults.json`;
2. user `config.json`;
3. a one-launch `--profile`;
4. explicit Pi CLI model/thinking flags;
5. explicit environment variables for diagnostic or operational overrides.

Manual edits are re-read on each launch and whenever `/config` opens. Invalid JSON, an unknown top-level key, an absent active profile, impossible compact thresholds or credential-like fields fail clearly instead of silently falling back.
