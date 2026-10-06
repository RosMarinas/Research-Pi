import { unwatchFile, watchFile } from "node:fs";

export function createRuntimeMailboxWatcher({ intervalMs = 250, drain, onDelivered, onWarning, retryWhen }) {
	let watch = null;

	const stop = () => {
		if (!watch) return;
		unwatchFile(watch.path, watch.listener);
		clearTimeout(watch.retryTimer);
		watch = null;
	};

	const schedule = (owner) => {
		if (watch !== owner || owner.retryTimer) return;
		owner.retryTimer = setTimeout(() => {
			owner.retryTimer = null;
			void scanNow(owner);
		}, intervalMs);
		owner.retryTimer.unref?.();
	};

	const scanNow = async (owner) => {
		if (watch !== owner) return;
		if (owner.running) {
			owner.rescanRequested = true;
			return;
		}
		owner.running = true;
		owner.rescanRequested = false;
		try {
			const delivered = await drain(owner.runtime, owner.ctx);
			if (watch !== owner) return;
			if (delivered === null) {
				stop();
				return;
			}
			if (delivered) await onDelivered?.(owner.ctx, delivered);
			owner.lastWarning = "";
		} catch (error) {
			if (watch !== owner) return;
			const message = `Runtime mailbox wake failed: ${error instanceof Error ? error.message : String(error)}`;
			if (message !== owner.lastWarning) await onWarning?.(owner.ctx, message);
			owner.lastWarning = message;
		} finally {
			owner.running = false;
			if (watch === owner) {
				if (owner.rescanRequested) queueMicrotask(() => void scanNow(owner));
				else if (retryWhen?.(owner.ctx)) schedule(owner);
			}
		}
	};

	const start = (activeRuntime, ctx) => {
		stop();
		const owner = { path: activeRuntime.ledgerPath, runtime: activeRuntime, ctx,
			running: false, rescanRequested: false, retryTimer: null, lastWarning: "", listener: null };
		owner.listener = (current, previous) => {
			if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
			void scanNow(owner);
		};
		watch = owner;
		watchFile(owner.path, { persistent: false, interval: intervalMs }, owner.listener);
		// Cover writes between subscription and fs.watchFile's first stat sample.
		schedule(owner);
	};

	// Compact events occur before native Pi becomes idle. Scan on a later tick.
	const wake = () => { if (watch) schedule(watch); };
	return { start, stop, wake };
}
