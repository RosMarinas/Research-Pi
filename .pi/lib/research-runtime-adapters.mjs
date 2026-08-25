let codexAdapter;
let codexWatchAdapter;
let runtimeUiAdapter;
let hostCapabilityUiAdapter;

export function registerCodexRuntimeAdapter(adapter) {
	codexAdapter = adapter;
}

export function getCodexRuntimeAdapter() {
	return codexAdapter;
}

export function registerCodexWatchAdapter(adapter) {
	codexWatchAdapter = adapter;
}

export function getCodexWatchAdapter() {
	return codexWatchAdapter;
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
