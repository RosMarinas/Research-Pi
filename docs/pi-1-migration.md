# Research Pi → Pi 1.0.0

Updated 2026-10-02. Core and TUI are pinned to 1.0.0. This migration keeps the research runtime while adopting Pi's native authentication, model selection, structured transcript, and codemode.

## GPT and subscription login

The two execution paths have separate authentication stores:

| Path | Login | Model selection |
|---|---|---|
| Pi Leader using the existing Codex subscription provider | `/login openai-codex` inside Pi | `/model`; saved native defaults are preserved |
| Pi Leader using the new subscription path | `/login openai` → Sign in with ChatGPT | Select the matching `openai` model in `/model` |
| Codex subagent backend | `codex login` in the terminal | `config.json` → `subagents.<role>`, `/models`, or an Action override |
| Antigravity subagent backend | launch `agy` interactively once to establish its cached sign-in | `subagents.environment` by default, or `/models` |
| Pi subagent backend | same native Pi `agentDir` and `/login` as Leader | `subagents.general`; independent model/thinking via `/models` |

Pi labels `openai-codex` as **legacy** starting in 0.99.0, but still supports it. There is no need to move existing OAuth tokens or supply an OpenAI API key to use a subscription. Switching the Leader's model does not silently change delegated workers' configured models or existing Codex threads. `/model` exposes the authenticated native catalog; Research Pi does not install a second GPT catalog.

`pi paths` identifies the actual `agentDir`. Source development (`run-pi.sh`) and installed-package mode have separate settings and authentication. Signing in to one does not sign in to the other. Check readiness without printing credentials using `pi auth check --provider openai-codex --no-refresh --json` (or `--provider openai` for the new path).

## Extension decisions

| Component | Decision | Reason |
|---|---|---|
| Native codemode and tool search | Explicitly load Pi built-ins; enable codemode by default | `--no-extensions` now disables built-ins as well as discovered extensions. Native scripts can batch tools and reduce returned text. |
| Research identity | Move from provider-specific HTTP rewriting to `context_with_system` | Pi 1.0 uses structured system sections. Preserve section patches, tool additions, custom roles, and mailbox wakes. Forced full-prompt overrides are normalized too. |
| Custom compaction history slicing | Remove; consume Pi's native preparation | Respect omitted/replaced context, previous compaction boundaries, and nested tool file operations. `pi.settings.compaction.keepRecentTokens` owns the tail; migration removes the unused staged-tail configuration. |
| Unified subagents | One Runtime layer over Codex, Antigravity, and Pi runners | Every Actor exposes backend/model/thinking. Codex remains the mature design/development/verification route; Antigravity defaults to environment work; Pi supplies any model connected through Pi. |
| Project State, experiment records, memory, transitions, research compaction | Retain | These describe evidence, provenance, and research decisions that Pi's conversation transcript does not own. |
| Project boundary, Analysis role, opaque host grants | Retain | Nested codemode tool calls pass through Pi's normal policy hooks; Analysis retains its restricted allowlist. |
| Runtime board, watch, tool activity, side conversations | Retain | Useful for independent workers and bounded discussion without merging all intermediate output into Leader context. |
| DeepSeek search | Default off; existing explicit preferences survive config merging | GPT subscription use has no mandatory DeepSeek key. Enable this search explicitly if wanted. |
| DeepSeek V4 Pro anchor experiment | Remove from default loadout; retain opt-in source | `--v4-pro-anchor` or `RESEARCH_PI_DEEPSEEK_ANCHOR=1` loads it when intentionally testing that provider. |
| Cache audit | Retain as an opt-in diagnostic | No runtime parser workaround is needed for the flat `cached_tokens` field: Pi 1.0 handles it. Historical cache investigations remain historical evidence. |
| MCP, llama.cpp, trace | Explicit opt-in | Use `-e builtin:mcp`, `-e builtin:llama.cpp`, or `pi-traced` when needed. |

Research Pi keeps its existing regular terminal mode; Pi 1.0's upstream fullscreen default is available by changing `pi.settings.tuiMode`. Codemode stays in the default `on` mode so direct tool calls remain available. It is tool orchestration, not a second model context; use `subagent` for subagents.

## Concurrent executor scheduling

Codex executors retain the mature scoped scheduler. The relevant defaults are:

```json
{
  "subagents": {
    "executor": { "backend": "codex", "model": "gpt-5.6-sol", "thinking": "max", "speed": "inherit" }
  },
  "codex": { "maxExecutors": 4 }
}
```

The Leader can dispatch these two background jobs before yielding:

```json
{
  "action": "start",
  "role": "executor",
  "mission": "model-implementation",
  "task": "Implement the agreed model change. Coordinate interface assumptions with the Leader.",
  "successCriteria": ["The changed model passes its targeted checks"],
  "writeScope": ["src/model"],
  "background": true
}
```

```json
{
  "action": "start",
  "role": "executor",
  "mission": "model-tests",
  "task": "Prepare tests for the agreed interface. Leave final integration validation to the Leader.",
  "successCriteria": ["Tests cover the agreed model behavior"],
  "writeScope": ["tests/model"],
  "background": true
}
```

Scopes are literal files or directories relative to the workspace root, not globs. Existing symlink parents resolve to their real destinations. Directory/descendant overlap is a conflict. Omission means `["."]`, preserving exclusive ownership for tasks that need unrestricted project edits. Resume inherits the previous scope unless explicitly changed.

Admission is serialized briefly; the workers themselves run concurrently. At capacity, dispatch returns a clear error rather than silently starting extra work or waiting inside a tool call. Dispatch later tasks when results arrive. Jobs paused for input retain their claim. The existing mailbox drives continuation, so no autonomous status polling is needed.

An `outcome_unknown` job blocks reuse of its scope until evidence-backed reconciliation. Older unknown jobs with no scope still block the whole workspace. One job's completion releases only its own claim. Whole-workspace Git snapshots may include sibling edits and must not be treated as per-worker attribution; use each worker's explicit handoff and owned paths.

The scope is a scheduling/ownership contract, **not a per-file OS sandbox**. All executors retain the existing project sandbox. The Leader coordinates shared GPUs, remote run directories, dependency installation, Git index changes, and integration. Scoped workers must preserve other agents' changes and must not stage, commit, reset, or switch branches.

Restart older Research Pi Leader processes before starting concurrent work. An older scheduler does not understand per-job claims. Existing sessions, research records, and completed jobs do not need to be deleted. Use a fresh process for the Core dependency upgrade; `/reload` alone does not upgrade an already loaded Core.

## Validation and limits

Offline validation uses Pi 1.0 itself and a synthetic provider: the exact extension loadout, a real Session with a mailbox wake and tool continuation, codemode nested-call policy hooks, and independent Codex app-server workers. Scheduler checks cover concurrent starts, overlaps, capacity, symlink scopes, independent settlement, resume, and scoped unknown outcomes. Existing tests continue to cover Runtime ownership, mailbox delivery, grants, and retention.

Synthetic workers establish transport and scheduling behavior; they do not measure GPT research quality or prove account-specific model access. Native auth readiness and a real provider request are separate checks. No research experiment is rerun or reinterpreted by this migration.

Acceptance on 2026-10-02:

- All 234 tests passed after removing four redundant or retired cases; syntax checks, package-manifest checks, and `git diff --check` passed. Shared command registration is checked in the real Core loadout test, and compaction checks use Core's actual prepared context instead of the removed staged-tail schedule.
- The active source launch reports Pi `1.0.0`. Its `openai-codex` OAuth readiness check returned `ready`; the independent Codex CLI reported ChatGPT login.
- A real Pi 1.0 request through `openai-codex/gpt-6-astra` at low effort, with tools and session persistence disabled, returned the expected `PI_1_LOGIN_OK`. This verifies the subscription transport. Concurrent worker lifecycle validation used synthetic app-server workers, not a live multi-model research run.

## Upstream references

- [Pi 1.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0)
- [Pi changelog, including 0.87 transcript and 0.99 authentication changes](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)
- [Pi provider authentication](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/providers.md)
- [Pi codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)
- [Pi extension API](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md)
- [OpenAI's Codex authentication guidance](https://developers.openai.com/codex/auth/)
