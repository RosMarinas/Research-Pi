let codexAdapter;

export function registerCodexRuntimeAdapter(adapter) {
	codexAdapter = adapter;
}

export function getCodexRuntimeAdapter() {
	return codexAdapter;
}
