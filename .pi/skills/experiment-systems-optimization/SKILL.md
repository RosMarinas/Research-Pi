---
name: experiment-systems-optimization
description: Speed up research experiments by identifying available resources and whole-system bottlenecks, then improving experiment code, data movement, batching and scheduling. Use for slow experiments, underused resources, or performance planning before substantial runs; GPU use does not imply a GPU bottleneck.
---

# Experiment Systems Optimization

Shorten the time to valid experimental results. Optimize the experiment's code and execution plan; mature public library internals are the lowest priority. A faster equivalent algorithm, fewer repeated computations or a better CPU implementation may matter more than GPU tuning.

## Start with resources and the whole system

Establish the target execution environment and what this experiment may use: CPU cores, RAM, GPUs and per-device VRAM, relevant storage/data location, sharing, and time or cost limits. Reuse known allocations and permissions. Inspect accessible state; when missing information would change the plan, ask the user directly or through the Leader. Do not confuse total capacity or momentary idle capacity with the experiment's allocation. Continue independent code analysis while an answer is pending.

Actively use available capacity to accelerate the experiment. Existing small batches, few workers, tiny caches or streaming one record at a time may be historical defaults, not constraints. Consider RAM preloading/caching, device residency, larger chunks and batches, CPU parallelism and independent-run concurrency. Account for intermediates, worker copies, queued inputs and variable-size peaks; choose headroom from the workload rather than an arbitrary large reserve. Seek useful throughput, not minimum memory usage or filling every device.

Map the complete experiment: reads, CPU preprocessing/simulation, task construction, IPC, device transfers, compute, CPU postprocessing, aggregation and storage. Identify dependencies, repeated work, data sizes, queue waits and overlap. Locate the critical path or the stage limiting sustained throughput before choosing a device or profiler. A long library call may reflect excessive calls, poor inputs or waiting for earlier asynchronous work.

## Investigate and change the limiting mechanism

Form a few competing explanations when the cause is unclear. Include alternatives that change the calculation or execution structure, not just current parameters. Prefer the cheapest discriminating observation: existing timings, call counts, stage/queue timing, a bounded CPU sample or a short device trace when needed. Full profiling is not mandatory.

Search proactively when choosing an approach or encountering an unfamiliar bottleneck. Look for efficient equivalent formulations, documented batch APIs, profiling methods and relevant prior optimizations in official docs, source and papers. Match versions and hardware; treat published speedups as hypotheses for this workload. Use the backend's available search tools; do not install a new search stack merely to follow this skill. Searching does not authorize uploading private code or traces.

Prioritize experiment-owned work:

- Remove redundant computation; hoist invariants; improve algorithms and data structures; replace repeated scalar/object work with suitable bulk operations.
- Reuse model, environment and worker lifetimes. Batch independent samples, candidates or runs where their state and semantics remain independent.
- Reduce copies, conversions, serialization and CPU–GPU round trips. Place data and computation together when the complete cost supports it.
- Tune worker count, per-worker threads, batch/chunk size, caching and prefetch against the actual allocation. Expand relevant settings until throughput flattens or a real constraint binds; examine coupled settings only when there is evidence of interaction.
- Use compiler/graph facilities or change device execution only when evidence points there. Optimizing how we call a mature library is in scope; rewriting its internals or replacing a framework needs specific evidence and comes last.

A structural rewrite is welcome when it answers the question better. Multiple processes are a candidate, not the default: startup, serialization, memory replication and contention can outweigh concurrency. Avoid low-information patch loops; after a change, reconsider the bottleneck rather than stacking knobs.

## Measure valid work and decide

Compare the same useful workload and outputs. Check only semantics that the intervention could affect: sample coverage/order mapping, cache validity, independent seeds/states, numerical decisions, or training gradient normalization and update frequency. Effective batch equality alone does not establish training equivalence. Approximation, precision changes, fewer candidates and asynchronous policy lag are scientific tradeoffs, not automatically equivalent speedups.

Use unprofiled end-to-end timing for acceptance; traces explain mechanisms. Wait for asynchronous work at measurement boundaries without adding synchronization after every operation. Include startup, input preparation, transfers, compilation, postprocessing and saving when the real experiment pays them. Concurrent stage/kernel times cannot simply be summed into wall time. CPU/GPU utilization is diagnostic, not the objective.

Report relevant before/after resources alongside wall time and effective throughput. More allocated cores/cards may be a good trade, but distinguish resource scaling from same-resource implementation efficiency. Repeat or broaden checks only when noise or an unresolved validity issue changes the decision. Stop when the gain cannot repay optimization/setup cost across expected reuse, the budget is reached, or further interventions lack useful evidence.

Keep useful changes and remove superseded paths within your scope. A supported negative result or isolated bottleneck can finish the task. Return the finding, intervention, measured result, resource tradeoff and limitations concisely; retain only decision-changing evidence in the project's existing records. Follow existing workspace/run ownership and remote-execution rules; this skill grants no extra resources or authority.
