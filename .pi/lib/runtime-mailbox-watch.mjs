import { unwatchFile, watchFile } from "node:fs";

export function createRuntimeMailboxWatcher({ intervalMs = 250, drain, onDelivered, onWarning }) {
	let generation = 0;
	let watch = null;
	let scan = { status: "idle", rescanRequested: false };
	let lastWarning = "";

	const stop = () => {
		generation += 1;
		if (watch) unwatchFile(watch.path, watch.listener);
		watch = null;
		scan = { status: "idle", rescanRequested: false };
		lastWarning = "";
	};

	const scanNow = async (activeRuntime, ctx, expectedGeneration) => {
		if (!watch || expectedGeneration !== generation) return;
		if (scan.status === "running") {
			scan.rescanRequested = true;
			return;
		}
		scan = { status: "running", rescanRequested: false };
		try {
			const delivered = await drain(activeRuntime, ctx);
			if (delivered === null) {
				stop();
				return;
			}
			if (delivered) await onDelivered?.(ctx, delivered);
			lastWarning = "";
		} catch (error) {
			const message = `Runtime mailbox wake failed: ${error instanceof Error ? error.message : String(error)}`;
			if (message !== lastWarning) await onWarning?.(ctx, message);
			lastWarning = message;
		} finally {
			const rescanRequested = scan.rescanRequested;
			scan = { status: "idle", rescanRequested: false };
			if (rescanRequested && watch && expectedGeneration === generation) {
				queueMicrotask(() => void scanNow(activeRuntime, ctx, expectedGeneration));
			}
		}
	};

	const start = (activeRuntime, ctx) => {
		stop();
		const expectedGeneration = generation;
		const path = activeRuntime.ledgerPath;
		const listener = (current, previous) => {
			if (expectedGeneration !== generation) return;
			if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
			void scanNow(activeRuntime, ctx, expectedGeneration);
		};
		watch = { path, listener };
		watchFile(path, { persistent: false, interval: intervalMs }, listener);
	};

	return { start, stop };
}
