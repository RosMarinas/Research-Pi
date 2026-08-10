# Local secrets and research data

This repository contains executable agent configuration. Treat its local runtime data as sensitive.

Never commit:

- `.env` or any real API key;
- `.npmrc`, private keys or credential files;
- `.pi/agent/*` except the reviewed `.pi/agent/models.json` compatibility configuration;
- Pi sessions or traces, which contain prompts, reasoning, tool arguments and outputs;
- `.pi/research/*.jsonl`, which may contain absolute paths, run IDs and project-sensitive observations;
- model checkpoints, datasets or experiment artifacts unless deliberately versioned elsewhere.

Before every release or first push, inspect:

```sh
git status --short --ignored
git diff --cached --stat
git diff --cached
```

If a credential is ever staged or committed, remove it from history and revoke or rotate it immediately. Removing the file in a later commit is not sufficient.
