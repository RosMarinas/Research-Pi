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
	RESEARCH_PI_THEME_CHOICES,
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
			description: `${profile.provider}/${profile.model} · ${profile.thinking}${profile.description ? ` · ${profile.description}` : ""}`,
		};
	});
}

export function themeSelectItems(config: ResearchConfig, available: Array<{ name: string; path?: string }> = []): SelectItem[] {
	const active = String(config.pi.settings.theme ?? "research-pi");
	const metadata = new Map(RESEARCH_PI_THEME_CHOICES.map((theme) => [theme.name, theme]));
	const availableNames = available.length ? new Set(available.map((theme) => theme.name)) : null;
	const canonicalNames = RESEARCH_PI_THEME_CHOICES
		.map((theme) => theme.name)
		.filter((name) => !availableNames || availableNames.has(name));
	const additionalNames = availableNames
		? [...availableNames].filter((name) => !metadata.has(name)).sort()
		: [];
	const names = [...canonicalNames, ...additionalNames];
	return [...new Set(names)].map((name) => {
		const theme = metadata.get(name);
		return {
			value: name,
			label: name === active ? `● ${theme?.label ?? name}` : `  ${theme?.label ?? name}`,
			description: `${name}${theme?.description ? ` · ${theme.description}` : ""}`,
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

	const activateTheme = async (name: string, ctx: ExtensionContext) => {
		const available = ctx.ui.getAllThemes().map((theme) => theme.name);
		if (!available.includes(name)) throw new Error(`Theme is not loaded: ${name}`);
		const result = ctx.ui.setTheme(name);
		if (!result.success) throw new Error(result.error || `Could not activate theme ${name}`);
		const config = loadConfig();
		writeResearchPiConfig(configPath, {
			...config,
			pi: { ...config.pi, settings: { ...config.pi.settings, theme: name } },
		});
		ctx.ui.notify(`Theme ${name} is active and persisted.`, "info");
	};

	const showThemeSelector = async (ctx: ExtensionContext) => {
		const config = loadConfig();
		const items = themeSelectItems(config, ctx.ui.getAllThemes());
		const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			container.addChild(new Text(theme.fg("customMessageLabel", theme.bold(" Research Pi / Themes ")), 0, 0));
			container.addChild(new Text(theme.fg("muted", ` current ${config.pi.settings.theme ?? "research-pi"}`), 0, 0));
			container.addChild(new Text("", 0, 0));
			const list = new SelectList(items, Math.min(items.length, config.ui.configPanelRows), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", theme.bold(text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 24 });
			list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === config.pi.settings.theme)));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate   enter apply + persist   esc close"), 0, 0));
			container.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
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
		if (selected) await activateTheme(selected, ctx);
	};

	const showProfileSelector = async (ctx: ExtensionContext) => {
		const config = loadConfig();
		const items = profileSelectItems(config);
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unresolved";
		const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			container.addChild(new Text(theme.fg("customMessageLabel", theme.bold(" Research Pi / Model Profiles ")), 0, 0));
			container.addChild(new Text(theme.fg("muted", ` current ${currentModel} · ${pi.getThinkingLevel()} thinking`), 0, 0));
			container.addChild(new Text(theme.fg("dim", ` config ${compactConfigPath(configPath)}`), 0, 0));
			container.addChild(new Text("", 0, 0));
			const list = new SelectList(items, Math.min(items.length, config.ui.configPanelRows), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", theme.bold(text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 24 });
			list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === config.activeProfile)));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", " ↑↓ navigate   enter apply + persist   t themes   esc close"), 0, 0));
			container.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			return {
				render(width: number) { return container.render(width); },
				invalidate() { container.invalidate(); },
				handleInput(data: string) {
					if (data === "t") {
						done("__themes__");
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "88%", maxHeight: "72%", margin: 1 },
		});
		if (selected === "__themes__") await showThemeSelector(ctx);
		else if (selected) await activateProfile(selected, ctx);
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
				if (action === "themes") {
					ctx.ui.notify(themeSelectItems(loadConfig(), ctx.ui.getAllThemes()).map((item) => `${item.label} · ${item.description}`).join("\n"), "info");
					return;
				}
				if (action === "theme" && name) {
					await activateTheme(name, ctx);
					return;
				}
				if (action === "use" && name) {
					await activateProfile(name, ctx);
					return;
				}
				throw new Error("Usage: /config [show|path|use <profile>|themes|theme <name>]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
