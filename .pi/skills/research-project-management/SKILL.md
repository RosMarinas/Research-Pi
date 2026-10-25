---
name: research-project-management
description: Establish and maintain a research project's layout, Git history, worktrees and environments when establishing or changing directory responsibilities, isolating conflicting work, integrating results or cleaning up a stage. Reuse known layout and ownership for routine delegation or new files; those alone do not trigger this skill. Leader owns structure and workspace lifecycles; executors maintain their assigned scope.
---

# Research Project Management

Keep the current implementation clear, the project readable and compact, and history in Git. Organize enough to support research; do not turn these principles into a checklist, approval ceremony or recurring report.

## Ownership and workspaces

The Leader owns branch and worktree creation, assignment, integration and removal. Executors use their assigned branch and workspace, may commit their own changes within scope, and discuss isolation needs through the available Leader/mailbox channel. They do not independently create, switch, merge or delete branches or worktrees.

Use a worktree only when conflicting parallel implementations, an independent research direction or preservation of a running baseline needs isolation. Multiple executors alone do not require multiple worktrees. Reuse suitable existing workspaces. Place new worktrees under the main project's ignored `.worktrees/`, never under a user-home scratch directory or nested inside another worktree.

When a temporary workspace's purpose ends, the Leader integrates useful changes or retains a committed branch, then promptly removes the worktree and unneeded branch. First account for active jobs and unique uncommitted or ignored results. Move worthwhile results to their intended project location; do not copy the entire worktree into a backup. Keep a branch only while its research purpose remains useful. Use existing task context and Git to track this, not a new registry.

## Git is the version store

Track core code in Git. Before replacing an uncommitted implementation worth retaining, commit the relevant work without sweeping in others' edits. After replacement, delete obsolete code and record the deletion. Recover old implementations from commits or retained branches, not `_old`, `_backup`, timestamped source copies, duplicated source directories or commented-out implementations.

Active baselines and algorithm alternatives may coexist when they answer a current research question. Give them meaningful names and reuse shared logic. Once retired, their code belongs in history. Git does not preserve untracked experiment outputs; handle those according to their research value.

## Readable code and purposeful directories

The Leader establishes the project's directory mapping when organizing implementation work and passes the relevant paths to executors. Use existing project guidance or task context, not a new registry or mandatory form. Executors may add ordinary files within that layout; new top-level directories or changes to directory responsibilities are Leader decisions.

Use the layout below by default, creating only directories actually needed. Reuse existing equivalents when their responsibilities are clear; an existing mixture of code, documents and outputs is not a convention to perpetuate. Correct affected placement as part of the work. Before moving existing files, inspect their callers and update affected imports, commands and references; do not disrupt live runs or reorganize unrelated files.

Code should expose the research concepts, entry points, data flow and experimental variables through clear names and focused functions. Centralize logic that represents the same concept and evolves together. Reuse existing modules rather than copying implementations into scripts or tests. Abstract demonstrated commonality, not hypothetical future requirements. Remove obsolete entry points and dead code when replacing an implementation.

| Location | Purpose and upkeep |
| --- | --- |
| `src/<package>/` or an established source directory | Current core implementation and active research alternatives. Keep one authoritative implementation of shared logic. |
| `configs/` | Experiment and run configuration. Express parameter variants here rather than copying source into a folder for each experiment. |
| `tests/` | Tests, test helpers and small fixtures. Update or remove invalidated and redundant tests as behavior changes; retain useful regression tests regardless of age. |
| `scripts/` | Genuine operational entry points such as processing, conversion, launch and batch work. Call core modules; remove superseded or unused scripts. |
| `tmp/` | Disposable probes, debugging intermediates and scratch files. Ignore in Git and clean after use. Never store the only copy of meaningful evidence here. |
| `output/<run>/` | Results, figures, logs and exports. No implementation code. Preserve decision-relevant evidence, including useful negative results; remove confirmed redundant or disposable output. |
| `docs/` | Current explanations and plans, plus research records with lasting value. No executable implementation or probe scripts. Update an existing topic rather than creating competing versions. Delete superseded plans once preserved in Git; retain independently useful findings. |
| `.worktrees/` | Leader-managed temporary isolated checkouts, not permanent copies of past implementations. |

An experiment name groups configurations and outputs, not a self-contained copy of source, scripts, docs and logs under `experiments/<name>/`. A new experiment normally reuses or changes core code, adds needed configuration and writes a run output directory. Do not create a per-task SPEC/RESULT/CHANGELOG bundle or source-hash/frozen-snapshot paperwork unless explicitly required by the task. Git stores code history; existing research records hold findings.

Temporary debugging code belongs in `tmp/`; promote a useful check into `tests/`, an operational entry point into `scripts/`, or a reusable algorithm into the source package. For example, `docs/research/<date>/debug_svd.py` belongs in `tmp/` while exploratory; a retained SVD regression check belongs in `tests/`. Test placement does not override a project's choice of whether tests are tracked.

Executors remove the obsolete code and disposable material created or replaced by their task as part of completion. The Leader integrates results, reclaims finished temporary workspaces and reviews accumulated tests, scripts, docs and outputs at research-stage integration. Do not defer all cleanup to an unspecified future task. These are natural cleanup opportunities, not mandatory full-tree scans on every turn. Age alone does not establish that a file is obsolete; preserve unique evidence and others' work.

## Environments

Prefer uv for Python projects and reuse a prepared project environment across compatible worktrees. The Leader coordinates changes to shared dependencies. Use an absolute `UV_PROJECT_ENVIRONMENT` path when sharing; relative paths resolve separately in each worktree. Run with `uv run --no-sync` when the environment is already prepared instead of repeatedly installing or syncing.

Sharing dependencies must not select another worktree's source. Editable installs can point to one checkout; use the project's existing source-loading mechanism to execute the assigned checkout. Do not alternate editable installs in a shared environment while other jobs use it. If dependencies, native builds or installation behavior cannot coexist, use a separate uv environment for that worktree and reclaim it after use. Reuse uv's cache; do not copy virtual environments, datasets or weights into every worktree.

Use the existing remote-workspace skill when remote synchronization or execution is actually involved. Local project organization does not itself require remote setup.
