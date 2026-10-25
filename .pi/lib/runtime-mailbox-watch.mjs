import { unwatchFile, watchFile } from "node:fs";

export function createRuntimeMailboxWatcher({ intervalMs = 250, maxRetryMs = 5000, drain, onDelivered, onWarning, retryWhen }) {
	let watch = null;

	const stop = () => {
		if (!watch) return;
		unwatchFile(watch.path, watch.listener);
		clearTimeout(watch.retryTimer);
		watch = null;
	};

	// While delivery is deferred, poll readiness cheaply. Do not drain the
	// mailbox just because the Leader is busy. Backoff covers backends that
	// become ready without appending a ledger event.
	const schedule = (owner) => {
		if (watch !== owner || owner.retryTimer) return;
		owner.retryTimer = setTimeout(() => {
			owner.retryTimer = null;
			const blocked = Boolean(retryWhen?.(owner.ctx));
			const becameReady = owner.blocked && !blocked;
			owner.blocked = blocked;
			if (becameReady || Date.now() >= owner.retryAt) void scanNow(owner);
			else schedule(owner);
		}, intervalMs);
		owner.retryTimer.unref?.();
	};

	const scanNow = async (owner) => {
		if (watch !== owner) return;
		if (owner.running) {
			owner.rescanRequested = true;
			return;
		}
		clearTimeout(owner.retryTimer);
		owner.retryTimer = null;
		owner.running = true;
		owner.rescanRequested = false;
		let pending = false;
		try {
			const result = await drain(owner.runtime, owner.ctx);
			if (watch !== owner) return;
			if (result === null) { stop(); return; }
			const delivered = typeof result === "number" ? result : result.delivered;
			pending = typeof result === "number" ? Boolean(retryWhen?.(owner.ctx)) : result.pending;
			if (delivered) {
				owner.retryDelay = intervalMs;
				await onDelivered?.(owner.ctx, delivered);
			}
			owner.lastWarning = "";
		} catch (error) {
			if (watch !== owner) return;
			pending = true;
			const message = `Runtime mailbox wake failed: ${error instanceof Error ? error.message : String(error)}`;
			if (message !== owner.lastWarning) await onWarning?.(owner.ctx, message);
			owner.lastWarning = message;
		} finally {
			owner.running = false;
			if (watch === owner) {
				if (owner.rescanRequested) queueMicrotask(() => void scanNow(owner));
				else if (pending) {
					owner.blocked = Boolean(retryWhen?.(owner.ctx));
					owner.retryAt = Date.now() + owner.retryDelay;
					owner.retryDelay = Math.min(maxRetryMs, owner.retryDelay * 2);
					schedule(owner);
				}
			}
		}
	};

	const start = (activeRuntime, ctx) => {
		stop();
		const owner = { path: activeRuntime.ledgerPath, runtime: activeRuntime, ctx,
			running: false, rescanRequested: false, retryTimer: null, lastWarning: "", listener: null,
			retryDelay: intervalMs, retryAt: 0, blocked: Boolean(retryWhen?.(ctx)) };
		owner.listener = (current, previous) => {
			if (current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs
				&& current.size === previous.size && current.ino === previous.ino) return;
			owner.retryDelay = intervalMs;
			void scanNow(owner);
		};
		watch = owner;
		watchFile(owner.path, { persistent: false, interval: intervalMs }, owner.listener);
		// Cover writes between subscription and fs.watchFile's first stat sample.
		schedule(owner);
	};

	// Explicit lifecycle wakes bypass backoff, but occur on a later tick because
	// native compact events precede the transition to idle.
	const wake = () => {
		if (!watch) return;
		watch.retryDelay = intervalMs;
		watch.retryAt = 0;
		if (watch.running) watch.rescanRequested = true;
		else schedule(watch);
	};
	return { start, stop, wake };
}
