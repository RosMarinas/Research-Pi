const subagentAdapters = new Map();
let runtimeUiAdapter;
let hostCapabilityUiAdapter;
let hostCapabilityRequestAdapter;

function normalizeBackend(backend) {
	const value = String(backend ?? "").trim().toLowerCase();
	if (!value) throw new Error("A subagent backend name is required");
	return value;
}

export function registerSubagentRuntimeAdapter(backend, adapter) {
	const key = normalizeBackend(backend);
	subagentAdapters.set(key, adapter);
	return () => { if (subagentAdapters.get(key) === adapter) subagentAdapters.delete(key); };
}

export function getSubagentRuntimeAdapter(backend) {
	return subagentAdapters.get(normalizeBackend(backend));
}

export function registerRuntimeUiAdapter(adapter) {
	runtimeUiAdapter = adapter;
}

export function getRuntimeUiAdapter() {
	return runtimeUiAdapter;
}

export function registerHostCapabilityUiAdapter(adapter) {
	hostCapabilityUiAdapter = adapter;
}

export function getHostCapabilityUiAdapter() {
	return hostCapabilityUiAdapter;
}

// Native subagents ask their owning Leader to review a capability. The grant
// still comes from the project-boundary policy and its existing ledger.
export function registerHostCapabilityRequestAdapter(adapter) {
	hostCapabilityRequestAdapter = adapter;
}

export function getHostCapabilityRequestAdapter() {
	return hostCapabilityRequestAdapter;
}
