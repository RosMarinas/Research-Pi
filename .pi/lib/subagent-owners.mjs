// Share the latest ExtensionContext per owner Session. Job bindings contain
// only identity tokens, and an old asynchronous callback cannot erase a rebind.
export function createSubagentOwners() {
	const jobs = new Map(), sessions = new Map();
	return {
		remember(jobId, context) {
			const sessionId = context.sessionManager.getSessionId();
			const previous = jobs.get(jobId);
			if (previous && previous.sessionId !== sessionId && ![...jobs].some(([id, value]) => id !== jobId && value.sessionId === previous.sessionId)) sessions.delete(previous.sessionId);
			const token = { sessionId };
			jobs.set(jobId, token); sessions.set(sessionId, context);
			return token;
		},
		token(jobId) { return jobs.get(jobId); },
		context(jobId) { return sessions.get(jobs.get(jobId)?.sessionId); },
		release(jobId, expected = jobs.get(jobId)) {
			if (!expected || jobs.get(jobId) !== expected) return false;
			jobs.delete(jobId);
			if (![...jobs.values()].some(value => value.sessionId === expected.sessionId)) sessions.delete(expected.sessionId);
			return true;
		},
		clear() { jobs.clear(); sessions.clear(); },
		stats() { return { jobs: jobs.size, sessions: sessions.size }; },
	};
}
