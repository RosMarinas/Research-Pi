const integer = (value, fallback) => {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error("Runtime memory limits must be non-negative integers");
	return number;
};

// Captured by each new Host. Updating a checkout never changes a running Host.
export function runtimeMemoryPolicy(env = process.env) {
	return {
		idleMs: integer(env.RESEARCH_PI_SUBAGENT_IDLE_MS, 15 * 60_000),
		warmLimit: integer(env.RESEARCH_PI_WARM_SUBAGENTS, 4),
		providerIdleMs: integer(env.RESEARCH_PI_PROVIDER_IDLE_MS, 60_000),
		eventBytes: integer(env.RESEARCH_PI_EVENT_CACHE_BYTES, 256 * 1024),
		ledgerBytes: integer(env.RESEARCH_PI_LEDGER_CACHE_BYTES, 16 * 1024 * 1024),
		historyEntries: integer(env.RESEARCH_PI_HISTORY_WINDOW, 200),
		sessionBytes: integer(env.RESEARCH_PI_SESSION_CACHE_BYTES, 8 * 1024 * 1024),
	};
}

export function retainEvent(events, event, byteLimit, maxEvents = 240) {
	// The canonical transcript and display journal own full tool output. The
	// owner's recent-event ring only needs progress and a journal reference.
	const retained = Object.fromEntries(Object.entries(event).filter(([key]) => !["raw", "result", "args"].includes(key)));
	for (const key of ["text", "summary"]) if (typeof retained[key] === "string") retained[key] = retained[key].slice(0, 4000);
	const size = item => Buffer.byteLength(JSON.stringify(item));
	if (byteLimit && size(retained) <= byteLimit) events.push(retained);
	let bytes = events.reduce((total, item) => total + size(item), 0);
	while (events.length > maxEvents || bytes > byteLimit) bytes -= size(events.shift());
	return events;
}
