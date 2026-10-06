// Reserve the settle boundary before ctx.compact() yields in Pi's abort().
// Both extensions share this module, keyed by the actual Session identity.
const reservations = new Map();
const keyFor = (ctx) => ctx.sessionManager?.getSessionId
	? `${ctx.cwd ?? ""}\0${ctx.sessionManager.getSessionId()}`
	: ctx;

export function reserveRuntimeCompaction(ctx) {
	const key = keyFor(ctx);
	const token = Symbol("compaction");
	reservations.set(key, token);
	return () => { if (reservations.get(key) === token) reservations.delete(key); };
}

export function runtimeCompactionReserved(ctx) {
	return reservations.has(keyFor(ctx));
}
