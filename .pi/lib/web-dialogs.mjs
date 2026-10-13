import { randomUUID } from "node:crypto";

// The same Pi dialog is visible on both screens. AbortSignal dismisses the
// original terminal dialog when a browser answers; the first answer wins.
export function attachWebDialogs(ui, publish) {
	const originals = new Map();
	const pending = new Map();
	for (const kind of ["confirm", "select", "input"]) {
		const original = ui[kind];
		if (typeof original !== "function") continue;
		const wrapper = (title, detail, options = {}) => new Promise((resolve, reject) => {
			const id = randomUUID();
			const controller = new AbortController();
			const request = {
				id, kind, title,
				...(kind === "confirm" ? { message: detail } : kind === "select" ? { options: detail } : { placeholder: detail }),
				...(options.timeout ? { expiresAt: Date.now() + options.timeout } : {}),
			};
			let settled = false, nativePromise;
			const finish = (value, error) => {
				if (settled) return false;
				settled = true;
				pending.delete(id);
				controller.abort();
				publish({ type: "dialog_closed", id });
				// Wait for Pi to finish dismissing its old component before the
				// extension is allowed to open the next dialog.
				Promise.resolve(nativePromise).catch(() => {}).then(() => error ? reject(error) : resolve(value));
				return true;
			};
			pending.set(id, { request, finish });
			publish({ type: "dialog", request });
			const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
			nativePromise = Promise.resolve().then(() => original.call(ui, title, detail, { ...options, signal }));
			nativePromise.then((value) => finish(value), (error) => finish(undefined, error));
		});
		originals.set(kind, { original, wrapper });
		ui[kind] = wrapper;
	}
	return {
		list: () => [...pending.values()].map((entry) => entry.request),
		answer(id, value, cancelled = false) {
			const entry = pending.get(id);
			if (!entry) throw new Error("This request has already been answered or expired");
			const { request } = entry;
			if (cancelled) value = request.kind === "confirm" ? false : undefined;
			else if (request.kind === "confirm" && typeof value !== "boolean") throw new Error("A confirmation must be yes or no");
			else if (request.kind === "select" && !request.options.includes(value)) throw new Error("Choose one of the offered options");
			else if (request.kind === "input" && (typeof value !== "string" || value.length > 16_000)) throw new Error("Invalid input");
			entry.finish(value);
			return { answered: true };
		},
		dispose() {
			for (const entry of [...pending.values()]) entry.finish(entry.request.kind === "confirm" ? false : undefined);
			for (const [kind, { original, wrapper }] of originals) if (ui[kind] === wrapper) ui[kind] = original;
		},
	};
}
