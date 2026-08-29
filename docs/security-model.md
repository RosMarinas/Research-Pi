# Security model and local research data

For vulnerability reporting and supported branches, see the repository-level
[security policy](../SECURITY.md).

This repository contains executable agent configuration. Treat its local runtime data as sensitive.

The source checkout is a fast-iteration development harness. Stable npm installs keep immutable package files separate from user configuration (`~/.config/research-pi` by default) and runtime state (`~/.local/state/research-pi` by default). Neither directory belongs in this repository or in a release tarball.

Never commit:

- `.env` or any real API key;
- local `.pi/config.json` or stable-install `credentials.env`; `config.json` is designed to be non-secret but remains a user-local preference file;
- `.npmrc`, private keys or credential files;
- `.pi/agent/*`, which contains generated Pi Core adapter settings, trust state, and traces for the current worktree;
- Pi sessions or traces, which contain prompts, reasoning, tool arguments and outputs;
- `.pi/memory/`, which is a rebuildable local search index derived from sensitive sessions and experiment records;
- `.pi/research/*.jsonl`, which may contain absolute paths, run IDs and project-sensitive observations;
- `.pi/codex/`, which contains delegated prompts, Codex JSON events, local process metadata and structured results;
- `.pi/runtime/`, which contains project Actor, Action and mailbox events and may include user or agent message text;
- model checkpoints, datasets or experiment artifacts unless deliberately versioned elsewhere.

`/watch` reads the existing bounded Codex audit stream and does not create another trace. Command output tails and subagent prompts are truncated and common credential patterns are replaced wholesale, but redaction is best-effort; do not make a delegated command print credentials merely because the panel is local.

Model-generated Pi shell commands use an OS sandbox runtime (Seatbelt on macOS, bubblewrap/seccomp on Linux); `codex_delegate` jobs use Codex permission profiles. The current project is writable, including Git objects, refs, index and config; `.git/hooks` remains read-only. Proxy-aware Web traffic is allowed without a domain allowlist, but raw TCP clients such as OpenSSH do not receive implicit host access. Other user directories, Unix sockets, SSH agent access and secret-named environment variables are unavailable to ordinary model tool subprocesses. Pi shell has no general system-temp write access; macOS retains only the narrow `xcrun_db` cache paths Apple Git requires. Direct Pi file tools require human approval for outside or protected paths. Human-entered `!` / `!!` commands intentionally bypass the agent sandbox and run with the user's normal account permissions.

`pi --full-access` is the explicit per-launch escape hatch. In a Leader Session it bypasses Pi's project sandbox and outside-path approval hook, and newly started Codex executor jobs receive a root-write/full-network permission profile. The TUI shows `🔓 full access`; the setting is not persisted. Analysis Sessions and Codex advisors remain read-only. Full access can expose host files, sockets and credentials to model-generated commands, so task scope, secret handling and exact destructive-target checks still apply even though the OS boundary is removed.

User-approved host capabilities are the escalation path shared by Pi and its Codex jobs. External reads resolve symlinks and reject known credential material. SSH grants bind one exact target and invoke the system SSH client with `BatchMode=yes` and strict known-host checking; credentials stay opaque. Host-command grants use structured argv with `shell:false`, require an in-project working directory, and may run any project entrypoint with the user's host authority. Once/session grants match the complete argv and session grants expire after 24 hours. Project grants persist by canonical project root: SSH grants match one exact target, while command grants match the explicitly displayed argv prefix and approved cwd. Supplying a grant ID restores that existing cwd but cannot change its argv authority; an omitted cwd is inferred only when all matching active grants identify one cwd, otherwise execution fails as ambiguous. Code-string forms such as `sh -c`, `python3 -c`, and `node -e` default to an exact full-argv project rule rather than a broad interpreter prefix. The older project-script mode remains available when exact SHA-256 plus exact argv pinning is desired.

Host-command is intentionally broader than opaque SSH: the process receives operational host environment such as `HOME`, `SSH_AUTH_SOCK`, virtual-environment and `UV_*` settings, while API-key/token-named variables are removed. Code run through an approved command can still read files and use credentials available to the user's account, so approve only reviewed project entrypoints and narrow prefixes. Persistent grants live in the user runtime-state capability ledger (or the Git-ignored `.pi/capabilities/` in source development mode), never in repository policy files, and can be revoked with `/boundary revoke`. A project cannot grant itself host authority by editing tracked files.

This broker does not make a remote account itself safe: after trusting an SSH target, remote commands have the authority of that account. It also does not make a trusted command intrinsically safe: changed project code behind a trusted prefix executes with host authority. Project trust is a user assertion about that project and entrypoint, not a content hash.

An Analysis Session adds a role-level read-only boundary above those project capabilities. It cannot claim the Leader attachment, consume the Leader mailbox, mutate Project State, use project write tools, or start or steer Codex work. It may run local shell commands inside an OS-enforced read-only project profile; only the project-local Runtime temp remains writable for ordinary tool compatibility, and shell network access is denied. Public evidence remains available through the structured Web tool. It may also read approved external files. Conservative SSH inspection commands are accepted automatically on a trusted target; a broader remote command can request an exact once/session grant from the user without promoting the Session, and that grant cannot broaden into target-wide trust. Credential-reading commands remain forbidden. Analysis may disable ProjectView injection with `/runtime context off` without changing its role.

This is a Harness policy, not a remote operating-system sandbox. The same SSH account may have write authority, so an approved exact Analysis command can have the side effects shown in the approval dialog. A hard remote read-only guarantee requires a separate read-only Unix account, forced-command wrapper, filesystem permissions, or an equivalent server-side control. Promotion is required for ongoing project execution ownership, not for a narrowly reviewed remote inspection command.

Codex CLI retains internal compatibility paths for system temporary directories even when a permission profile requests that system temp be denied. The Harness redirects `TMPDIR` into the project and instructs delegated work not to use outside temp paths. Other user directories remain OS-denied, but the Codex executor's system-temp boundary is currently defense in depth rather than a boundary as strong as the Pi shell's.

To keep normal commits usable without exposing `~/.gitconfig`, trusted harness startup reads only global `user.name` and `user.email` and injects those four author/committer environment fields. No credential helper, include, alias, signing-key or remote configuration is forwarded.

System runtime access is a separate read-only zone, compiled into both the Pi sandbox and Codex permission profiles. On macOS the trusted launcher resolves the active Developer directory with `xcode-select -p`, canonicalizes it, grants that directory read access, and injects `DEVELOPER_DIR`. Optional additional runtime roots require `RESEARCH_PI_RUNTIME_ROOTS`; roots under the user's home additionally require the explicit high-risk opt-in `RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS=1`, because read/execute permission also makes their contents model-readable.

Every Codex job performs a model-free sandbox preflight before App Server startup. The trusted launcher resolves the configured Codex executable through PATH and symlinks once, then uses that canonical path for both preflight and App Server startup. Preflight verifies that Codex can re-execute itself under the exact advisor/executor profile, then checks `git --version`, repository status, and an available `python3`. Failure stops the job before model execution. `pi doctor` and `/boundary doctor` expose the same checks for installation and incident diagnosis.

This is a capability boundary, not a guarantee that project-local code is benign. A permitted command may still delete project files, create commits, consume compute, contact public services, or modify scripts that a human later runs. Review the project and delegation objective accordingly.

Before every release or first push, inspect:

```sh
git status --short --ignored
git diff --cached --stat
git diff --cached
```

If a credential is ever staged or committed, remove it from history and revoke or rotate it immediately. Removing the file in a later commit is not sufficient.
