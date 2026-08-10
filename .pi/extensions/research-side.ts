import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getMarkdownTheme,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import {
	buildSidePromotion,
	createSideRecord,
	findSideRecord,
	previewText,
	RESEARCH_SIDE_KIND,
	RESEARCH_SIDE_PROMOTION_KIND,
	sideRecords,
	sideUsageLine,
} from "../lib/research-side.mjs";

interface SideRecord {
	id: string;
	question: string;
	answer: string;
	anchorEntryId?: string | null;
	sessionId: string;
	model: { provider: string; id: string };
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		totalTokens: number;
	};
	startedAt: string;
	completedAt: string;
	latencyMs: number;
	sessionEntryId?: string;
}

function textFromResponse(response: { content?: Array<{ type?: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function showSide(record: SideRecord, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${record.id}\n${record.question}\n\n${record.answer}`, "info");
		return;
	}
	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const body = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		body.addChild(new Text(theme.fg("accent", theme.bold(`[side ${record.id}]`)), 0, 0));
		body.addChild(new Text(theme.fg("dim", `${record.model.provider}/${record.model.id} · ${record.completedAt}`), 0, 0));
		body.addChild(new Text(theme.fg("muted", "Question"), 0, 0));
		body.addChild(new Markdown(record.question, 0, 0, getMarkdownTheme()));
		body.addChild(new Text(theme.fg("muted", "Answer"), 0, 0));
		body.addChild(new Markdown(record.answer, 0, 0, getMarkdownTheme()));
		body.addChild(new Text(theme.fg("dim", `${sideUsageLine(record)} · ${(record.latencyMs / 1000).toFixed(1)}s`), 0, 0));
		container.addChild(body);
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

function listText(records: SideRecord[]): string {
	if (!records.length) return "No side conversations in the current session branch.";
	return records
		.slice(-20)
		.reverse()
		.map((record) => `${record.id} · ${record.completedAt}\n${previewText(record.question, 180)}`)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<SideRecord>(RESEARCH_SIDE_KIND, (entry, { expanded }, theme) => {
		const record = entry.data;
		if (!record?.id) return undefined;
		const card = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		card.addChild(
			new Text(
				`${theme.fg("accent", theme.bold(`[side ${record.id}]`))} ${theme.fg("dim", "isolated · persisted")}`,
				0,
				0,
			),
		);
		card.addChild(new Text(theme.fg("muted", "Q") + ` ${previewText(record.question, expanded ? 4_000 : 240)}`, 0, 0));
		card.addChild(new Markdown(expanded ? record.answer : previewText(record.answer), 0, 0, getMarkdownTheme()));
		card.addChild(
			new Text(
				theme.fg(
					"dim",
					expanded
						? `${record.model.provider}/${record.model.id} · ${record.completedAt} · ${sideUsageLine(record)} · /side use ${record.id}`
						: `Ctrl+O expands · /side show ${record.id} · /side use ${record.id}`,
				),
				0,
				0,
			),
		);
		return card;
	});

	pi.registerMessageRenderer<{ sideId?: string }>(RESEARCH_SIDE_PROMOTION_KIND, (message, _options, theme) => {
		const sideId = message.details?.sideId ?? "unknown";
		const card = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
		card.addChild(new Text(theme.fg("accent", theme.bold(`[side ${sideId} promoted to main context]`)), 0, 0));
		return card;
	});

	pi.registerCommand("side", {
		description: "Ask an isolated persisted side question; list/show/use saved side answers",
		getArgumentCompletions: (prefix) => {
			const commands = ["list", "show ", "use "];
			return commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value.trim() }));
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const input = args.trim();
			const branch = ctx.sessionManager.getBranch();

			if (!input) {
				ctx.ui.notify("Usage: /side <question> | /side list | /side show <id> | /side use <id>", "warning");
				return;
			}
			if (input === "list") {
				ctx.ui.notify(listText(sideRecords(branch)), "info");
				return;
			}
			if (input.startsWith("show ")) {
				try {
					await showSide(findSideRecord(branch, input.slice(5)) as SideRecord, ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (input.startsWith("use ")) {
				try {
					const record = findSideRecord(branch, input.slice(4)) as SideRecord;
					pi.sendMessage(
						{
							customType: RESEARCH_SIDE_PROMOTION_KIND,
							content: buildSidePromotion(record),
							display: true,
							details: { sideId: record.id, promotedAt: new Date().toISOString() },
						},
						{ triggerTurn: false },
					);
					ctx.ui.notify(`Promoted ${record.id} into the main context. It will be visible on the next model turn.`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No active model is available for /side.", "error");
				return;
			}
			const startedAt = new Date();
			const anchorEntryId = ctx.sessionManager.getLeafId();
			ctx.ui.notify("Running an isolated side question…", "info");
			try {
				const contextMessages = ctx.sessionManager
					.buildContextEntries()
					.flatMap((entry) => sessionEntryToContextMessages(entry));
				const messages = convertToLlm(contextMessages);
				const toolInfo = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
				const tools = pi
					.getActiveTools()
					.map((name) => toolInfo.get(name))
					.filter((tool) => tool !== undefined)
					.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
				messages.push({
					role: "user",
					content: [
						{
							type: "text",
							text: [
								"This is an isolated side question. Answer using the visible research context, but do not continue or alter the main task.",
								"No tools are available in this call. Be self-contained and distinguish facts from inference.",
								"The answer will be persisted outside the main model context unless the user explicitly promotes it.",
								"",
								input,
							].join("\n"),
						},
					],
					timestamp: Date.now(),
				});
				const response = await ctx.modelRegistry.complete(
					ctx.model,
					{ systemPrompt: ctx.getSystemPrompt(), messages, tools },
					{
						maxTokens: Math.min(16_000, ctx.model.maxTokens || 16_000),
						reasoningEffort: ctx.thinkingLevel ?? "max",
						toolChoice: "none",
						cacheRetention: "short",
						signal: ctx.signal,
						sessionId: ctx.sessionManager.getSessionId(),
					},
				);
				const answer = textFromResponse(response);
				if (!answer) throw new Error(response.errorMessage || `side call returned no text (${response.stopReason})`);
				const record = createSideRecord({
					question: input,
					answer,
					anchorEntryId,
					sessionId: ctx.sessionManager.getSessionId(),
					model: { provider: ctx.model.provider, id: ctx.model.id },
					usage: response.usage,
					startedAt,
					completedAt: new Date(),
				}) as SideRecord;
				pi.appendEntry<SideRecord>(RESEARCH_SIDE_KIND, record);
				ctx.ui.notify(`Saved ${record.id}. Ctrl+O expands it; /side use ${record.id} promotes it.`, "info");
			} catch (error) {
				ctx.ui.notify(`/side failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
