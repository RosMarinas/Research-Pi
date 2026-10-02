const subagentAdapters = new Map();
const subagentWatchAdapters = new Map();
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

export function listSubagentRuntimeAdapters() {
	return [...subagentAdapters.entries()].map(([backend, adapter]) => ({ backend, adapter }));
}

export function registerSubagentWatchAdapter(backend, adapter) {
	subagentWatchAdapters.set(normalizeBackend(backend), adapter);
}

export function getSubagentWatchAdapter(backend) {
	return subagentWatchAdapters.get(normalizeBackend(backend));
}

export function listSubagentWatchAdapters() {
	return [...subagentWatchAdapters.entries()].map(([backend, adapter]) => ({ backend, adapter }));
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
