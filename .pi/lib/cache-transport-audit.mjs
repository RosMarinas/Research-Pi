// Observe the actual fetch boundary, not just the pre-SDK payload hook. The
// caller selects in-scope requests. Never rewrite a body/header/response or
// retain raw prompt, response, URL, or credential text in the report.
export function numericCacheUsage(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	const result = {};
	for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
		if (typeof usage[key] === "number") result[key] = usage[key];
	}
	for (const [key, names] of [["prompt_tokens_details", ["cached_tokens", "cache_write_tokens"]], ["completion_tokens_details", ["reasoning_tokens"]]]) {
		for (const name of names) {
			if (typeof usage[key]?.[name] !== "number") continue;
			(result[key] ??= {})[name] = usage[key][name];
		}
	}
	return result;
}

async function readUsage(response, report) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const parse = (line) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (data === "[DONE]") { report.doneMarker = true; return; }
		let chunk;
		try { chunk = JSON.parse(data); } catch { report.invalidSseJson = true; return; }
		const usage = numericCacheUsage(chunk.usage);
		const choiceUsage = numericCacheUsage(chunk.choices?.[0]?.usage);
		if (usage !== undefined || choiceUsage !== undefined) report.usageUpdates.push({ usage, choiceUsage, afterDoneMarker: report.doneMarker === true });
		if (chunk.error) report.streamError = true;
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split(/\r?\n/);
			pending = lines.pop();
			for (const line of lines) parse(line);
		}
		parse(pending + decoder.decode());
	} finally { reader.releaseLock(); }
}

export function installCacheTransportAudit(selectRequest, completed, target = globalThis) {
	const original = target.fetch;
	const tasks = new Set();
	const publish = (report) => { try { completed(report); } catch { /* observer only */ } };
	async function observedFetch(input, init) {
		let selected;
		try { selected = selectRequest(input, init); } catch { /* diagnostics must not block the request */ }
		if (!selected) return original.call(this, input, init);
		let response;
		try { response = await original.call(this, input, init); }
		catch (error) { publish({ ...selected, transportError: true }); throw error; }
		const report = { ...selected, httpStatus: response.status, usageUpdates: [] };
		if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
			publish({ ...report, sseObserved: false });
			return response;
		}
		// The SDK gets the original Response. Drain a clone in parallel, keeping
		// only numerical usage fields; never wait for this observer on its path.
		let copy;
		try { copy = response.clone(); } catch { publish({ ...report, observerError: true }); return response; }
		const task = readUsage(copy, report)
			.catch(() => { report.observerError = true; })
			.then(() => publish({ ...report, sseObserved: true, responseEndedAt: Date.now() }));
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
		return response;
	}
	target.fetch = observedFetch;
	return {
		restore() { if (target.fetch === observedFetch) target.fetch = original; },
		async settled() { await Promise.all([...tasks]); },
	};
}
