# Runtime mailbox I/O fix

An attached, busy Leader previously retried the mailbox every 250 ms even when
there was no pending mail or ledger change. Each drain replayed the whole ledger
at least twice; a deferred subagent message also repeatedly created delivery and
ledger locks.

## Behavior

- Cache up to eight ledger/project entries per process. Each lookup checks file
  identity, size, nanosecond mtime and ctime. Unchanged ledgers reuse parsed events
  and immutable snapshots; workspace-specific snapshot metadata stays separate.
- Concurrent readers share an in-flight load. A reader arriving after a write
  rechecks file metadata after waiting. A file changed during loading is not
  cached. Replacement, truncation, deletion and recreation invalidate the cache.
- Snapshot screening is shared within a drain. Actual dispatch still performs
  fresh reads under the existing ownership/delivery locks.
- Empty mailboxes do not retry just because the Leader is busy. Deferred mail
  retries at 250 ms, 500 ms, 1 s, 2 s, 4 s, then at most once per 5 s while the
  ledger is unchanged. The 250 ms readiness check does not drain or acquire locks.
  File changes, explicit lifecycle wakes and blocked-to-ready transitions bypass
  backoff. A backend without readiness events has a fallback delay of up to about
  5 s plus polling/scheduling overhead, including when the Leader is already idle.
- Busy Leader deferral does not prevent subagent delivery. The existing file
  watcher remains a metadata poll; it does not read ledger contents.

This is unchanged-ledger caching, not incremental replay. After a ledger change,
parsing and reduction are still full-history operations. Shared events/snapshots
are read-only; callers needing an editable copy must explicitly copy it.

## Validation (2026-10-25)

Eight committed regression tests cover concurrent read sharing, immutable views,
workspace separation, append without scientific revision change, incomplete tails,
same-size rewrite, replacement/truncation/recreation, stale in-flight reads,
empty busy mailboxes, deferred backend fallback, idle transitions, shutdown and
locked delivery rechecks:

```sh
node --test tests/runtime-mailbox-performance.test.mjs
```

The existing local test suite is ignored by this repository. In the temporary
worktree, 83 targeted tests passed across mailbox, compaction, subagents, runtime,
board/dock, analysis bridge and watch. Overlaying the primary checkout's existing
related uncommitted changes and adding its git-init identity tests passed 85 tests.
Those unrelated changes are not part of this fix. `npm run check` and explicit
syntax checking of the new cache module also passed.

A synthetic ledger contained 15,603 `message.queued` events, each with an 850-byte
ASCII body, totaling 15,877,237 bytes. Both implementations were warmed once before
40 sequential snapshot reads in one local Node process. Baseline was c6bc834.

| Measurement | Before | After |
| --- | ---: | ---: |
| Cold snapshot wall time | 24.68 ms | 33.48 ms |
| 40 warm reads wall time | 912.38 ms | 0.64 ms |
| 40 warm reads process CPU time | 1141.15 ms | 0.74 ms |
| JSON.parse calls during warm reads | 624,120 | 0 |

These are one-run offline measurements, not end-to-end latency or disk-bandwidth
claims. Cold construction adds freezing cost. No live KV_Holes session was
restarted, reloaded or used as a write target. Merging source changes does not
replace modules already loaded by that process; use the fix on a later safe
restart/new session.
