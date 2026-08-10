# Local research ledger

`record_experiment` appends decision-changing observations to `experiments.jsonl` in the active workspace.

JSONL ledgers are ignored in this harness repository because they may contain prompts, absolute paths, run identifiers or other project-sensitive context. Promote a sanitized result into normal project documentation when it should be shared or versioned.
