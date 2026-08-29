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

export default function researchConfigExtension(pi: ExtensionAPI) {
	const configPath = process.env.RESEARCH_PI_CONFIG_FILE ?? paths.configPath;

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

	pi.registerCommand("config", {
		description: "Inspect Research Pi-only configuration and choose a theme; Pi Core owns models and authentication",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (!input) {
					ctx.ui.notify(`${researchPiConfigSummary(loadConfig(), configPath)}\n\nUse /login for provider authentication, /model to switch, /scoped-models to curate cycling, and /settings for thinking defaults.`, "info");
					return;
				}
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
				throw new Error("Usage: /config [show|path|themes|theme <name>]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
