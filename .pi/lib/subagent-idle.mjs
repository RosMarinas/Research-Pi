const SETTLED = new Set(["completed", "failed", "cancelled"]);

export function idleSubagentCandidates(jobs, { idleMs, warmLimit }, time = Date.now()) {
	if (!idleMs) return [];
	const warm = jobs.filter(job => job.backend === "pi" && !job.closed && !job.hibernateRequest
		&& SETTLED.has(job.status) && !job.pendingRequest && !job.nativeBlocked && !job.waiters?.length
		&& !(job.externalRuns ?? []).some(run => !SETTLED.has(run.status)))
		.sort((a, b) => (b.idleSince ?? 0) - (a.idleSince ?? 0));
	return warm.filter((job, rank) => {
		const age = time - (job.idleSince ?? time);
		return age >= idleMs || (rank >= warmLimit && age >= Math.min(idleMs, 60_000));
	});
}
