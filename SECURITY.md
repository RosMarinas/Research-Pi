# Local secrets and research data

This repository contains executable agent configuration. Treat its local runtime data as sensitive.

Never commit:

- `.env` or any real API key;
- `.npmrc`, private keys or credential files;
- `.pi/agent/*` except the reviewed, credential-free `.pi/agent/models.json` and `.pi/agent/settings.json` configurations;
- Pi sessions or traces, which contain prompts, reasoning, tool arguments and outputs;
- `.pi/memory/`, which is a rebuildable local search index derived from sensitive sessions and experiment records;
- `.pi/research/*.jsonl`, which may contain absolute paths, run IDs and project-sensitive observations;
- `.pi/codex/`, which contains delegated prompts, Codex JSON events, local process metadata and structured results;
- model checkpoints, datasets or experiment artifacts unless deliberately versioned elsewhere.

`codex_delegate` executor jobs intentionally run the local Codex CLI with automatic `danger-full-access`. They inherit the current user's filesystem, Git, SSH and remote-service capabilities. The adapter removes `DEEPSEEK_API_KEY` from the child environment, but it is not a general secret sandbox: target repositories, Codex auth and other user credentials remain accessible to Codex when the operating system permits it.

Before every release or first push, inspect:

```sh
git status --short --ignored
git diff --cached --stat
git diff --cached
```

If a credential is ever staged or committed, remove it from history and revoke or rotate it immediately. Removing the file in a later commit is not sufficient.
