import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import tokenSpeed from "../vendor/pi-token-speed-0.11.0/index.ts";
import { PerformanceFooterComponent } from "../lib/performance-footer.mjs";

const WIDGET_KEY = "research_performance";

export default function researchTokenSpeed(pi: ExtensionAPI) {
	let component: PerformanceFooterComponent | undefined;
	let requestRender: (() => void) | undefined;

	const performanceContext = <T extends ExtensionContext>(ctx: T): T => {
		if (ctx.mode !== "tui") return ctx;
		const ui = {
			...ctx.ui,
			setStatus(key: string, text: string | undefined) {
				if (key !== "tokenSpeed") return ctx.ui.setStatus(key, text);
				component?.update(text);
				requestRender?.();
			},
		};
		return new Proxy(ctx, { get: (target, key) => key === "ui" ? ui : Reflect.get(target, key) });
	};

	return tokenSpeed({
		...pi,
		on(name: any, handler: any) {
			return pi.on(name, async (event: any, ctx: ExtensionContext) => {
				if (name === "session_start" && ctx.mode === "tui") {
					component = new PerformanceFooterComponent();
					ctx.ui.setStatus("tokenSpeed", undefined);
					ctx.ui.setWidget(WIDGET_KEY, (tui) => {
						requestRender = () => tui.requestRender();
						return component!;
					}, { placement: "belowEditor" });
				}
				const result = await handler(event, performanceContext(ctx));
				if (name === "session_shutdown" && ctx.mode === "tui") {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					component = undefined;
					requestRender = undefined;
				}
				return result;
			});
		},
		registerCommand(name, command) {
			return pi.registerCommand(name, {
				...command,
				handler: (args, ctx) => command.handler(args, performanceContext(ctx)),
			});
		},
	});
}
