import { randomUUID } from "node:crypto";

// Pending operations belong to the execution host, not the connected screens.
export function createRuntimeInteractions(publish, epoch) {
	const pending = new Map();
	function request(kind, title, detail, options = {}) {
		if (options.signal?.aborted) return Promise.resolve(kind === "confirm" ? false : undefined);
		const id = randomUUID();
		const view = { id, kind, title, epoch: epoch(), ...(kind === "select" ? { options: detail, searchable: true }
			: kind === "confirm" ? { message: detail } : { placeholder: detail }), ...(options.secret ? { secret: true } : {}) };
		return new Promise((resolve) => {
			let timer;
			const abort = () => finish(kind === "confirm" ? false : undefined);
			const finish = (value) => {
				if (!pending.delete(id)) return;
				clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
				publish({ type: "dialog_closed", id }); resolve(value);
			};
			pending.set(id, { view, finish });
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.timeout) { view.expiresAt = Date.now() + options.timeout; timer = setTimeout(abort, options.timeout); }
			publish({ type: "dialog", request: view });
		});
	}
	return {
		request,
		list: () => [...pending.values()].map(({ view }) => view),
		answer(id, value, cancelled = false) {
			const entry = pending.get(id);
			if (!entry || entry.view.epoch !== epoch()) throw new Error("This interaction has ended or the session changed");
			const { view } = entry;
			if (cancelled) value = view.kind === "confirm" ? false : undefined;
			else if (view.kind === "confirm" && typeof value !== "boolean") throw new Error("Confirmation requires yes or no");
			else if (view.kind === "select" && !view.options.includes(value)) throw new Error("Choose an offered option");
			else if (["input", "editor"].includes(view.kind) && (typeof value !== "string" || value.length > 100000)) throw new Error("Invalid input");
			entry.finish(value); return { answered: true };
		},
		cancelAll() { for (const { view, finish } of [...pending.values()]) finish(view.kind === "confirm" ? false : undefined); },
	};
}
