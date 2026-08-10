# Local research ledger

`record_experiment` appends decision-changing observations to `experiments.jsonl` in the active workspace.

JSONL ledgers are ignored in this harness repository because they may contain prompts, absolute paths, run identifiers or other project-sensitive context. Promote a sanitized result into normal project documentation when it should be shared or versioned.

Research Memory may index the ledger into the harness-local `.pi/memory/memory.sqlite`. That database is derived, rebuildable, and ignored by Git. Deleting it does not delete the authoritative JSONL ledger or Pi sessions.
