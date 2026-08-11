# Local secrets and research data

This repository contains executable agent configuration. Treat its local runtime data as sensitive.

The source checkout is a fast-iteration development harness. Stable npm installs keep immutable package files separate from user configuration (`~/.config/research-pi` by default) and runtime state (`~/.local/state/research-pi` by default). Neither directory belongs in this repository or in a release tarball.

Never commit:

- `.env` or any real API key;
- `.npmrc`, private keys or credential files;
- `.pi/agent/*` except the reviewed, credential-free `.pi/agent/models.json` and `.pi/agent/settings.json` configurations;
- Pi sessions or traces, which contain prompts, reasoning, tool arguments and outputs;
- `.pi/memory/`, which is a rebuildable local search index derived from sensitive sessions and experiment records;
- `.pi/research/*.jsonl`, which may contain absolute paths, run IDs and project-sensitive observations;
- `.pi/codex/`, which contains delegated prompts, Codex JSON events, local process metadata and structured results;
- model checkpoints, datasets or experiment artifacts unless deliberately versioned elsewhere.

Model-generated Pi shell commands use an OS sandbox runtime (Seatbelt on macOS, bubblewrap/seccomp on Linux); `codex_delegate` jobs use Codex permission profiles. The current project is writable, including Git objects, refs, index and config; `.git/hooks` remains read-only. Proxy-aware Web traffic is allowed without a domain allowlist, but raw TCP clients such as OpenSSH do not receive implicit host access. Other user directories, Unix sockets, SSH agent access and secret-named environment variables are unavailable to ordinary model tool subprocesses. Pi shell has no general system-temp write access; macOS retains only the narrow `xcrun_db` cache paths Apple Git requires. Direct Pi file tools require human approval for outside or protected paths. Human-entered `!` / `!!` commands intentionally bypass the agent sandbox and run with the user's normal account permissions.

User-approved host capabilities are the narrow escalation path shared by Pi and its Codex jobs. External reads resolve symlinks and reject known credential material. SSH grants bind one exact target and invoke the system SSH client with `BatchMode=yes` and strict known-host checking; the broker retains `HOME`/`SSH_AUTH_SOCK` only for that process while removing API-key/token variables. Project-script grants bind an in-project canonical path, SHA-256 and exact argv before executing outside the ordinary shell sandbox. Once grants are consumed before execution; session grants expire after 24 hours and can be revoked with `/boundary revoke`. The local ledger is Git-ignored and never stores credential contents. This broker does not make a remote account itself safe: after approving an SSH target, remote commands have the authority of that account, so approve only intended research hosts.

Codex CLI 0.146 的 permission-profile 仍保留自身的系统临时目录兼容路径，即使 profile 请求拒绝系统 temp。Harness 会把 `TMPDIR` 重定向到项目内，并在委派约定中禁止主动使用项目外 temp；因此 Codex executor 对其他用户目录仍是 OS 级拒绝，但其系统 temp 边界目前属于纵深防御，不与 Pi shell 的硬边界等强。

To keep normal commits usable without exposing `~/.gitconfig`, trusted harness startup reads only global `user.name` and `user.email` and injects those four author/committer environment fields. No credential helper, include, alias, signing-key or remote configuration is forwarded.

System runtime access is a separate read-only zone, compiled into both the Pi sandbox and Codex permission profiles. On macOS the trusted launcher resolves the active Developer directory with `xcode-select -p`, canonicalizes it, grants that directory read access, and injects `DEVELOPER_DIR`. Optional additional runtime roots require `RESEARCH_PI_RUNTIME_ROOTS`; roots under the user's home additionally require the explicit high-risk opt-in `RESEARCH_PI_ALLOW_HOME_RUNTIME_ROOTS=1`, because read/execute permission also makes their contents model-readable.

Every Codex job performs a model-free sandbox preflight before App Server startup. A Git repository must support `git --version` and `git status` under the exact advisor/executor profile; an available `python3` is also probed. Failure stops the job before model execution. `pi doctor` and `/boundary doctor` expose the same checks for installation and incident diagnosis.

This is a capability boundary, not a guarantee that project-local code is benign. A permitted command may still delete project files, create commits, consume compute, contact public services, or modify scripts that a human later runs. Review the project and delegation objective accordingly.

Before every release or first push, inspect:

```sh
git status --short --ignored
git diff --cached --stat
git diff --cached
```

If a credential is ever staged or committed, remove it from history and revoke or rotate it immediately. Removing the file in a later commit is not sufficient.
