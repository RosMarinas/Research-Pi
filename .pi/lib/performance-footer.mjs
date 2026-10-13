import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// A separate below-editor row keeps telemetry out of the native footer's
// alphabetically joined, width-truncated extension status line.
export class PerformanceFooterComponent {
	constructor() {
		this.text = "TPS: -- · TTFT: --";
	}

	update(text) {
		this.text = String(text ?? "TPS: --")
			.replace(/\u200b/g, "")
			.replace(" (TTFT:", " · TTFT:")
			.replace(/\)$/, "");
		if (!stripTerminalSequences(this.text).includes("TTFT:")) this.text += " · TTFT: --";
	}

	render(width) {
		const usable = Math.max(1, Math.floor(width));
		if (visibleWidth(this.text) <= usable) return [this.text];
		// Wrap rather than clip: even narrow terminals retain both measurements.
		return this.text.split(" · ").flatMap((part) => wrapTextWithAnsi(part, usable));
	}

	invalidate() {}
}
