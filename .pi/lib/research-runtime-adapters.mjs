const subagentAdapters = new Map();
let runtimeUiAdapter;
let hostCapabilityUiAdapter;

function normalizeBackend(backend) {
	const value = String(backend ?? "").trim().toLowerCase();
	if (!value) throw new Error("A subagent backend name is required");
	return value;
}

export function registerSubagentRuntimeAdapter(backend, adapter) {
	subagentAdapters.set(normalizeBackend(backend), adapter);
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
