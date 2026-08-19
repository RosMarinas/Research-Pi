import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureResearchPiConfig,
	readResearchPiConfig,
	researchPiConfigSummary,
	researchPiProfile,
	researchPiProfileForModel,
	writeResearchPiConfig,
} from "../lib/research-config.mjs";
import { resolveResearchPiPaths } from "../lib/runtime-paths.mjs";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(EXTENSION_DIR, "../..");
const paths = resolveResearchPiPaths({ harnessRoot: HARNESS_ROOT });

type ResearchConfig = ReturnType<typeof readResearchPiConfig>;

function loadConfig(): ResearchConfig {
	return ensureResearchPiConfig(process.env.RESEARCH_PI_CONFIG_FILE ?? paths.configPath);
}

export function profileSelectItems(config: ResearchConfig): SelectItem[] {
	return Object.keys(config.profiles).map((name) => {
		const profile = researchPiProfile(config, name);
		return {
			value: name,
			label: name === config.activeProfile ? `● ${profile.label ?? name}` : `  ${profile.label ?? name}`,
			description: `${profile.model} · ${profile.thinking}${profile.description ? ` · ${profile.description}` : ""}`,
		};
	});
}

export function compactConfigPath(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length <= 4 ? path : `…/${parts.slice(-4).join("/")}`;
}

export function formatProfileStatus(config: ResearchConfig, ctx: ExtensionContext): string {
	const current = ctx.model ? researchPiProfileForModel(config, ctx.model.provider, ctx.model.id) : null;
	const name = current?.name ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : config.activeProfile);
	return `◇ ${name}`;
}

export default function researchConfigExtension(pi: ExtensionAPI) {
	const configPath = process.env.RESEARCH_PI_CONFIG_FILE ?? paths.configPath;

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const config = loadConfig();
			ctx.ui.setStatus(
				"research_profile",
				config.ui.showProfileStatus ? ctx.ui.theme.fg("accent", formatProfileStatus(config, ctx)) : undefined,
			);
		} catch {
			ctx.ui.setStatus("research_profile", undefined);
		}
	};

	const activateProfile = async (name: string, ctx: ExtensionContext) => {
		const config = loadConfig();
		const profile = researchPiProfile(config, name);
		const model = ctx.modelRegistry.find(profile.provider, profile.model);
		if (!model) throw new Error(`Model is not available: ${profile.provider}/${profile.model}`);
		if (!(await pi.setModel(model))) throw new Error(`No usable credential for ${profile.provider}/${profile.model}`);
		pi.setThinkingLevel(profile.thinking);
		const next = writeResearchPiConfig(configPath, { ...config, activeProfile: name });
		process.env.RESEARCH_PI_ACTIVE_PROFILE = name;
		updateStatus(ctx);
		ctx.ui.notify(
			`Profile ${name} is active and persisted. ${profile.provider}/${profile.model} · thinking ${profile.thinking}`,
			"info",
		);
		return next;
	};

	const showProfileSelector = async (ctx: ExtensionContext) => {
		const config = loadConfig();
		const items = profileSelectItems(config);
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unresolved";
		const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Research Pi · Model Profiles ")), 0, 0));
			container.addChild(new Text(theme.fg("muted", ` current ${ctx.model?.id ?? currentModel} · ${pi.getThinkingLevel()} thinking`), 0, 0));
			container.addChild(new Text(theme.fg("dim", ` config ${compactConfigPath(configPath)}`), 0, 0));
			container.addChild(new Text("", 0, 0));
			const list = new SelectList(items, Math.min(items.length, config.ui.configPanelRows), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", theme.bold(text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 24 });
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate   enter apply + persist   esc close"), 0, 0));
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			return {
				render(width: number) { return container.render(width); },
				invalidate() { container.invalidate(); },
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "88%", maxHeight: "72%", margin: 1 },
		});
		if (selected) await activateProfile(selected, ctx);
	};

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", async (_event, ctx) => updateStatus(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("research_profile", undefined);
	});

	pi.registerCommand("config", {
		description: "Open Research Pi configuration or switch a persistent model profile",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (!input) return await showProfileSelector(ctx);
				const [action, name] = input.split(/\s+/, 2);
				if (action === "show") {
					ctx.ui.notify(researchPiConfigSummary(loadConfig(), configPath), "info");
					return;
				}
				if (action === "path") {
					ctx.ui.notify(configPath, "info");
					return;
				}
				if (action === "use" && name) {
					await activateProfile(name, ctx);
					return;
				}
				throw new Error("Usage: /config [show|path|use <profile>]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
