import {
	DynamicBorder,
	SettingsManager,
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
	researchPiEnvironment,
	RESEARCH_PI_THEME_CHOICES,
	writeResearchPiConfig,
} from "../lib/research-config.mjs";
import { resolveResearchPiPaths } from "../lib/runtime-paths.mjs";
import { parseContextWindow, setModelContextWindow } from "../lib/model-context.mjs";
import { selectModel } from "../lib/model-picker.mjs";
import {
	codexReasoningChoices,
	codexSupportsFast,
	getSupportedThinkingLevels,
	leaderServiceTierPayload,
	listAntigravityModels,
	listCodexModels,
	supportsLeaderSpeed,
	validateServiceTier,
} from "../lib/model-settings.mjs";

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

export function registerModelSettings(pi: ExtensionAPI, {
	configPath = process.env.RESEARCH_PI_CONFIG_FILE ?? paths.configPath,
	agentDir = process.env.PI_CODING_AGENT_DIR ?? paths.agentDir,
	listModels = listCodexModels,
	listAntigravity = listAntigravityModels,
} = {}) {
	const load = () => readResearchPiConfig(configPath);
	const save = (config: ResearchConfig) => {
		const saved = writeResearchPiConfig(configPath, config);
		for (const [key, value] of Object.entries(researchPiEnvironment(saved))) {
			if (/^RESEARCH_PI_(?:SUBAGENT_|CODEX_)/.test(key)) process.env[key] = value;
		}
	};
	const roleNames = ["leader", "advisor", "executor", "environment", "general", "internal"] as const;
	type Role = typeof roleNames[number];
	const summary = (ctx: ExtensionContext) => {
		const config = load();
		const modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
		return [
			`Leader: ${modelId} · ${pi.getThinkingLevel()} · context ${ctx.model?.contextWindow ?? "unknown"} · speed ${config.pi.modelServiceTiers[modelId] ?? "inherit"}`,
			...(["advisor", "executor", "environment", "general"] as const).map((role) => {
				const runner = config.subagents[role];
				return `${role}: ${runner.backend} · ${runner.model} · ${runner.thinking}${runner.speed ? ` · speed ${runner.speed}` : ""}`;
			}),
			`internal: codex · ${config.codex.internalSubagent.model} · ${config.codex.internalSubagent.thinking} · speed inherited`,
			"Leader changes apply now. Runner defaults apply to new Actions; explicit dispatch values override one Action only.",
		].join("\n");
	};
	const persistLeader = async (ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>) => {
		const settings = SettingsManager.create(ctx.cwd, agentDir);
		settings.setDefaultModelAndProvider(model.provider, model.id);
		settings.setDefaultThinkingLevel(pi.getThinkingLevel());
		settings.setModelThinkingLevel(model.provider, model.id, pi.getThinkingLevel());
		await settings.flush();
		const errors = settings.drainErrors();
		if (errors.length) throw errors[0].error;
		const config = load();
		for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) delete config.pi.settings[key];
		if (config.pi.settings.modelThinkingLevels) delete config.pi.settings.modelThinkingLevels[`${model.provider}/${model.id}`];
		save(config);
	};
	const confirmFast = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) throw new Error("Enabling Fast requires confirmation in /models; it uses extra quota.");
		return await ctx.ui.confirm("Enable Fast?", "Fast uses additional quota (currently 2.5× included subscription usage; credits/PAYG 2×). Account/model eligibility still applies. It changes speed, not reasoning effort.");
	};
	const nativeModels = async (ctx: ExtensionContext) => {
		await ctx.modelRegistry.refresh({ allowNetwork: false });
		return ctx.modelRegistry.getAvailable();
	};
	const contextModel = async (role: Role, ctx: ExtensionContext) => {
		const runner = role === "leader" ? null : load().subagents[role];
		if (role !== "leader" && runner?.backend !== "pi") throw new Error("Context controls are available for the Leader and Pi runners");
		const id = !runner || runner.model === "inherit" ? ctx.model && `${ctx.model.provider}/${ctx.model.id}` : runner.model;
		return (await nativeModels(ctx)).find((model) => `${model.provider}/${model.id}` === id);
	};
	const modelChoices = async (backend: string, ctx: ExtensionContext) => {
		if (backend === "pi") return (await nativeModels(ctx)).map((model) => ({ model: `${model.provider}/${model.id}`, native: model }));
		if (backend === "antigravity") return await listAntigravity({ cwd: ctx.cwd });
		return await listModels({ cwd: ctx.cwd });
	};
	const thinkingChoices = (backend: string, modelId: string, catalog: any[], config: ResearchConfig) => {
		if (backend === "antigravity") return ["inherit", "low", "medium", "high", "max"];
		if (backend === "pi") {
			if (modelId === "inherit") return ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
			const model = catalog.find((item) => item.model === modelId)?.native;
			return ["inherit", ...(model ? getSupportedThinkingLevels(model) : [])];
		}
		return ["inherit", ...codexReasoningChoices(config, catalog, modelId)];
	};
	const apply = async (role: Role, field: string, value: string, ctx: ExtensionContext, catalog?: any[]) => {
		const config = load();
		if (!["backend", "model", "thinking", "speed", "context"].includes(field)) throw new Error("Setting must be backend, model, thinking, speed, or context");
		if (field === "context") {
			const model = await contextModel(role, ctx);
			if (!model) throw new Error("Select an authenticated Pi model first");
			if (!ctx.isIdle()) throw new Error("Wait until the Leader is idle before changing context metadata");
			await setModelContextWindow(agentDir, model.provider, model.id, parseContextWindow(value));
			await ctx.modelRegistry.refresh({ allowNetwork: false });
			const refreshed = ctx.modelRegistry.find(model.provider, model.id);
			if (ctx.model?.provider === model.provider && ctx.model.id === model.id && refreshed && !await pi.setModel(refreshed)) throw new Error("Saved context override; reselect the model to apply it");
			ctx.ui.notify(`${model.provider}/${model.id}: context ${refreshed?.contextWindow ?? value} tokens. Saved in native models.json; new Pi jobs share it. Server limits and compaction thresholds remain independently configured.`, "info");
			return;
		}
		if (role === "leader") {
			if (field === "backend") throw new Error("Leader provider is selected through its model; use /login and /models leader model");
			if (!ctx.isIdle()) throw new Error("Wait until the Leader is idle before changing its model settings");
			let model = ctx.model;
			if (field === "model") {
				await ctx.modelRegistry.refresh();
				const models = ctx.modelRegistry.getAvailable();
				model = models.find((item) => `${item.provider}/${item.id}` === value);
				if (!model) throw new Error("Choose an authenticated provider/model from /models; use /login first if needed");
				if (!await pi.setModel(model)) throw new Error(`Could not select ${value}`);
				await persistLeader(ctx, model);
			} else {
				if (!model) throw new Error("Select a Leader model first");
				if (field === "thinking") {
					if (!getSupportedThinkingLevels(model).includes(value)) throw new Error(`Unsupported thinking level for ${model.id}: ${value}`);
					pi.setThinkingLevel(value as ReturnType<typeof pi.getThinkingLevel>);
					await persistLeader(ctx, model);
				} else {
					validateServiceTier(value);
					if (!supportsLeaderSpeed(model)) throw new Error("Speed controls require a GPT model on native OpenAI Responses or OpenAI Codex");
					const key = `${model.provider}/${model.id}`;
					if (value === "fast" && config.pi.modelServiceTiers[key] !== "fast" && !await confirmFast(ctx)) return;
					if (value === "inherit") delete config.pi.modelServiceTiers[key];
					else config.pi.modelServiceTiers[key] = value;
					save(config);
				}
			}
		} else if (role === "internal") {
			if (field === "backend" || field === "speed") throw new Error("Codex internal subagents inherit backend and speed from their parent");
			const current = config.codex.internalSubagent;
			const models = catalog ?? await listModels({ cwd: ctx.cwd });
			if (field === "model") {
				if (value !== "inherit" && !models.some((item) => item.model === value)) throw new Error(`Codex model is not in the current catalog: ${value}`);
				current.model = value;
			} else {
				const choices = thinkingChoices("codex", current.model, models, config);
				if (!choices.includes(value)) throw new Error(`Unsupported reasoning effort for ${current.model}: ${value}`);
				current.thinking = value;
			}
			save(config);
		} else {
			const current = config.subagents[role];
			if (field === "backend") {
				if (!["codex", "antigravity", "pi"].includes(value)) throw new Error("Backend must be codex, antigravity, or pi");
				current.backend = value;
				if (value === "pi") { current.model = "inherit"; current.thinking = "inherit"; delete current.speed; }
				else if (value === "antigravity") { current.model = "gemini-3.1-pro-high"; current.thinking = "high"; delete current.speed; }
				else {
					const codexDefault = [config.subagents.advisor, config.subagents.executor].find((runner) => runner.backend === "codex")?.model ?? "gpt-5.6-sol";
					current.model = codexDefault;
					current.thinking = "max";
					current.speed = "inherit";
				}
			} else if (field === "speed") {
				if (current.backend !== "codex") throw new Error("Independent speed is available only for Codex runners");
				validateServiceTier(value);
				const models = catalog ?? await listModels({ cwd: ctx.cwd });
				const model = models.find((item) => item.model === current.model);
				if (value === "fast" && !codexSupportsFast(model)) throw new Error(`Codex does not advertise Fast for ${current.model}`);
				if (value === "fast" && current.speed !== "fast" && !await confirmFast(ctx)) return;
				current.speed = value;
			} else {
				const models = catalog ?? await modelChoices(current.backend, ctx);
				if (field === "model") {
					if (value !== "inherit" && !models.some((item) => item.model === value)) throw new Error(`${current.backend} model is not in the current catalog: ${value}`);
					if (value === "inherit" && current.backend === "codex") throw new Error("A Codex runner must name its model");
					current.model = value;
				} else {
					const choices = thinkingChoices(current.backend, current.model, models, config);
					if (!choices.includes(value)) throw new Error(`Unsupported thinking level for ${current.model}: ${value}`);
					current.thinking = value;
				}
			}
			save(config);
		}
		ctx.ui.notify(`${role} ${field} = ${value}. ${role === "leader" ? "Applied and persisted." : "Saved for new jobs; existing jobs/resumes are unchanged."}`, "info");
	};
	const handler = async (args: string, ctx: ExtensionContext) => {
		try {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length > 3) throw new Error("Usage: /models <role> <backend|model|thinking|speed|context> <value>");
			if (parts[0] === "show" || (!parts.length && !ctx.hasUI)) { ctx.ui.notify(summary(ctx), "info"); return; }
			if (!parts.length) { await showModelPanel(ctx); return; }
			const role = parts[0] as Role;
			if (!roleNames.includes(role!)) throw new Error("Usage: /models [show|leader|advisor|executor|environment|general|internal] [backend|model|thinking|speed|context] [value]");
			let field = parts[1];
			if (!field) {
				if (role === "leader") field = await ctx.ui.select(`${role}: setting`, ["model", "thinking", "speed", "context"]);
				else if (role === "internal") field = await ctx.ui.select(`${role}: setting`, ["model", "thinking"]);
				else {
					const runner = load().subagents[role!];
					field = await ctx.ui.select(`${role}: setting`, ["backend", "model", "thinking", ...(runner.backend === "codex" ? ["speed"] : runner.backend === "pi" ? ["context"] : [])]);
				}
			}
			if (!field) return;
			let value = parts[2];
			let catalog: any[] | undefined;
			if (!value) {
				const config = load();
				let choices: string[];
				if (field === "context") {
					const model = await contextModel(role, ctx);
					if (!model) throw new Error("Select an authenticated Pi model first");
					value = await ctx.ui.input(`Context window: ${model.provider}/${model.id} (tokens; inherit resets catalog default)`, String(model.contextWindow));
					if (value) await apply(role, field, value, ctx);
					return;
				}
				if (field === "backend") choices = ["codex", "antigravity", "pi"];
				else if (field === "speed") choices = ["inherit", "standard", "fast"];
				else if (role === "leader") {
					const models = await nativeModels(ctx);
					choices = field === "model" ? models.map((model) => `${model.provider}/${model.id}`)
						: ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
				} else {
					const runner = role === "internal" ? { backend: "codex", ...config.codex.internalSubagent } : config.subagents[role!];
					ctx.ui.notify(`Reading ${runner.backend} model catalog (no model turn).`, "info");
					catalog = await modelChoices(runner.backend, ctx);
					choices = field === "model" ? catalog.map((item) => item.model) : thinkingChoices(runner.backend, runner.model, catalog, config);
					if (field === "model" && runner.backend !== "codex") choices.unshift("inherit");
				}
				if (!choices.length) throw new Error("No choices available; check the selected backend login");
				const runner = role === "leader" ? null : role === "internal" ? config.codex.internalSubagent : config.subagents[role];
				value = field === "model" ? await selectModel(ctx, `${role}: model`, choices, role === "leader" ? ctx.model && `${ctx.model.provider}/${ctx.model.id}` : runner?.model)
					: await ctx.ui.select(`${role}: ${field}`, choices);
			}
			if (value) await apply(role!, field, value, ctx, catalog);
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	};
	const editRole = async (role: Role, ctx: ExtensionContext) => {
		while (true) {
			const config = load();
			const runner = role === "leader"
				? { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected", thinking: pi.getThinkingLevel(), speed: config.pi.modelServiceTiers[`${ctx.model?.provider}/${ctx.model?.id}`] ?? "inherit" }
				: role === "internal" ? config.codex.internalSubagent : config.subagents[role];
			const fields = role === "leader" ? ["model", "thinking", ...(ctx.model && supportsLeaderSpeed(ctx.model) ? ["speed"] : []), "context"]
				: role === "internal" ? ["model", "thinking"] : ["backend", "model", "thinking", ...(runner.backend === "codex" ? ["speed"] : runner.backend === "pi" ? ["context"] : [])];
			const effectiveModel = role === "leader" || runner.model === "inherit" ? ctx.model
				: ctx.modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === runner.model);
			const rows = fields.map((field) => `${field}  ·  ${field === "context" ? `${effectiveModel?.contextWindow ?? "unknown"} tokens` : runner[field] ?? "inherit"}`);
			const chosen = await ctx.ui.select(`Config / Models / ${role} — Esc: back`, rows);
			if (!chosen) return;
			await handler(`${role} ${fields[rows.indexOf(chosen)]}`, ctx);
		}
	};
	const showModelPanel = async (ctx: ExtensionContext) => {
		while (true) {
			const choice = await ctx.ui.select("Config / Models — Esc: back", ["Leader", "Subagents", "Codex internal subagents"]);
			if (!choice) return;
			if (choice === "Leader") await editRole("leader", ctx);
			else if (choice === "Codex internal subagents") await editRole("internal", ctx);
			else {
				while (true) {
					const config = load();
					const roles = ["advisor", "executor", "environment", "general"] as const;
					const rows = roles.map((role) => { const r = config.subagents[role]; return `${role}  ·  ${r.backend} / ${r.model} / ${r.thinking}`; });
					const selected = await ctx.ui.select("Config / Models / Subagents — Esc: back", rows);
					if (!selected) break;
					await editRole(roles[rows.indexOf(selected)], ctx);
				}
			}
		}
	};
	pi.registerCommand("models", { description: "Configure Leader and subagent model, thinking, speed and Pi context window", handler });
	pi.registerCommand("fast", {
		description: "Configure GPT Leader Fast mode (extra quota): /fast [on|off|status|inherit]",
		handler: async (args, ctx) => {
			const input = args.trim();
			const modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			const tier = load().pi.modelServiceTiers[modelId] ?? "inherit";
			if (input === "status") { ctx.ui.notify(`${modelId}: ${tier}`, "info"); return; }
			const value = !input ? (tier === "fast" ? "standard" : "fast") : ({ on: "fast", off: "standard", inherit: "inherit" } as Record<string, string>)[input];
			if (!value) { ctx.ui.notify("Usage: /fast [on|off|status|inherit]", "error"); return; }
			await handler(`leader speed ${value}`, ctx);
		},
	});
	pi.on("before_provider_request", (event, ctx) => leaderServiceTierPayload(event.payload, ctx.model, load().pi.modelServiceTiers));
	return handler;
}

export default function researchConfigExtension(pi: ExtensionAPI) {
	const configPath = process.env.RESEARCH_PI_CONFIG_FILE ?? paths.configPath;
	const modelSettings = registerModelSettings(pi, { configPath });

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
		if (typeof (ctx.ui as any).openView === "function") {
			const chosen = await ctx.ui.select("Research Pi / Themes", items.map((item) => item.value));
			if (chosen) await activateTheme(chosen, ctx);
			return;
		}
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
		description: "Open hierarchical settings: models and roles, appearance, configuration",
		handler: async (args, ctx) => {
			try {
				const input = args.trim();
				if (/^models(?:\s|$)/.test(input)) {
					await modelSettings(input.slice("models".length).trim(), ctx);
					return;
				}
				if (!input) {
					if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
						ctx.ui.notify(`${researchPiConfigSummary(loadConfig(), configPath)}\n\nUse /login, /model, /scoped-models and /settings for native Pi settings.`, "info");
						return;
					}
					while (true) {
						const choice = await ctx.ui.select("Research Pi / Config — Esc: close", ["Models and roles", "Appearance", "Current configuration", "Configuration path"]);
						if (!choice) break;
						if (choice === "Models and roles") await modelSettings("", ctx);
						else if (choice === "Appearance") await showThemeSelector(ctx);
						else ctx.ui.notify(choice === "Configuration path" ? configPath : researchPiConfigSummary(loadConfig(), configPath), "info");
					}
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
				throw new Error("Usage: /config [show|path|models|themes|theme <name>]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
