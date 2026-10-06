import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { builtInExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { resolveCliModel, resolveModelScope } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js";
import { initTheme, setThemeJsonValidator } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { validateThemeJson } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js";
import { processFileArguments } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js";
import { buildInitialMessage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/initial-message.js";

export async function createResearchSessionRuntime({ args, cwd, agentDir, sessionDir, extensionFactories = [], model, settingsManager }) {
	const parsed = parseArgs(args);
	sessionDir = parsed.sessionDir ?? sessionDir;
	const parseErrors = parsed.diagnostics.filter((x) => x.type === "error"); if (parseErrors.length) throw new Error(parseErrors.map((x) => x.message).join("\n"));
	const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const trusted = parsed.projectTrustOverride ?? (!hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(agentDir).get(cwd) === true);
		const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settingsManager ?? SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: { noExtensions: parsed.noExtensions, noSkills: parsed.noSkills, noThemes: parsed.noThemes, noPromptTemplates: parsed.noPromptTemplates, additionalPromptTemplatePaths: parsed.promptTemplates, noContextFiles: parsed.noContextFiles,
				additionalExtensionPaths: parsed.extensions, additionalSkillPaths: parsed.skills, additionalThemePaths: parsed.themes,
				appendSystemPrompt: parsed.appendSystemPrompt, systemPrompt: parsed.systemPrompt,
				extensionFactories: [...builtInExtensions, ...extensionFactories] } });
		const errors = [...services.diagnostics.filter((x) => x.type === "error"), ...services.resourceLoader.getExtensions().errors];
		if (errors.length) throw new Error(errors.map((x) => x.message ?? `${x.path}: ${x.error}`).join("\n"));
		const resolved = resolveCliModel({ cliProvider: parsed.provider, cliModel: parsed.model, cliThinking: parsed.thinking, modelRuntime: services.modelRuntime });
		if (resolved.error) throw new Error(resolved.error);
		const patterns = parsed.models ?? services.settingsManager.getEnabledModels();
		const scopedModels = patterns ? await resolveModelScope(patterns, services.modelRuntime) : undefined;
		if (parsed.apiKey) { const selected = model ?? resolved.model ?? scopedModels?.[0]?.model; if (!selected) throw new Error("--api-key requires an explicit model"); await services.modelRuntime.setRuntimeApiKey(selected.provider, parsed.apiKey); }
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
			model: sessionStartEvent ? undefined : model ?? resolved.model, thinkingLevel: sessionStartEvent ? undefined : parsed.thinking ?? resolved.thinkingLevel,
			scopedModels, tools: parsed.tools, excludeTools: parsed.excludeTools, noTools: parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined });
		setThemeJsonValidator(validateThemeJson); initTheme(services.settingsManager.getTheme(), false);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	let sessionManager;
	const sessions = await SessionManager.list(cwd, sessionDir);
	const resolveSession = (value) => {
		const path = resolve(cwd, value);
		if (existsSync(path)) return path;
		const matches = sessions.filter((s) => s.id.startsWith(value));
		if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous session ID" : "No workspace session matches " + value);
		return matches[0].path;
	};
	if (parsed.noSession) sessionManager = SessionManager.inMemory(cwd, { id: parsed.sessionId });
	else if (parsed.fork) sessionManager = SessionManager.forkFrom(resolveSession(parsed.fork), cwd, sessionDir, { id: parsed.sessionId });
	else if (parsed.session) {
		sessionManager = SessionManager.open(resolveSession(parsed.session), sessionDir);
		if (resolve(sessionManager.getCwd()) !== resolve(cwd)) throw new Error("This Session belongs to another workspace; use --fork to copy it into the current workspace");
	}
	else if (parsed.continue) sessionManager = SessionManager.continueRecent(cwd, sessionDir);
	else if (parsed.sessionId) { const existing = sessions.find((s) => s.id === parsed.sessionId); if (existing) sessionManager = SessionManager.open(existing.path, sessionDir, cwd); }
	sessionManager ??= SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
	const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager });
	if (parsed.name) runtime.session.setSessionName(parsed.name);
	const files = await processFileArguments(parsed.fileArgs ?? []);
	runtime.startupInput = buildInitialMessage({ parsed, fileText: files.text, fileImages: files.images });
	runtime.startupMessages = [...(parsed.resume ? ["/resume"] : []), ...parsed.messages];
	return runtime;
}
