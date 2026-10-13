import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOKEN_GENERATION_TOOLS } from "../config/constants";
import type { Renderer } from "../ui/renderer";
import type { TokenSpeedEngine } from "./engine";
import type { MessageHandler, MessageUpdatePayload } from "./message-handler";

/**
 * Handles stream-start events (text_start, thinking_start, toolcall_start).
 *
 * Applies provider overrides, stops the TTFT timer, and starts the engine.
 */
export class StreamStartHandler implements MessageHandler {
  readonly types = ["text_start", "thinking_start", "toolcall_start"];

  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly getProvider: (ctx: ExtensionContext) => string | undefined,
  ) {}

  handle(_event: MessageUpdatePayload, ctx: ExtensionContext): void {
    this.engine.applyProvider(this.getProvider(ctx));
    this.engine.stopTTFT();
    this.engine.start();
  }
}

/**
 * Handles content/delta events (text_delta, thinking_delta).
 *
 * Records the token delta and triggers a renderer update.
 */
export class DeltaHandler implements MessageHandler {
  readonly types = ["text_delta", "thinking_delta"];

  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly renderer: Renderer,
  ) {}

  handle(event: MessageUpdatePayload, ctx: ExtensionContext): void {
    this.engine.recordDelta(
      event.assistantMessageEvent.delta ?? "",
      event.assistantMessageEvent.partial?.usage?.output,
    );
    this.renderer.update(ctx);
  }
}

/**
 * Handles tool call delta events.
 *
 * Only processes deltas for token-generation tools (edits/writes).
 */
export class ToolcallDeltaHandler implements MessageHandler {
  readonly types = ["toolcall_delta"];

  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly renderer: Renderer,
  ) {}

  handle(event: MessageUpdatePayload, ctx: ExtensionContext): void {
    const toolCall =
      event.assistantMessageEvent.partial?.content?.[
        event.assistantMessageEvent.contentIndex ?? 0
      ];
    if (toolCall?.type !== "toolCall") return;

    if (TOKEN_GENERATION_TOOLS.has(toolCall.name ?? "")) {
      this.engine.recordDelta(
        event.assistantMessageEvent.delta ?? "",
        event.assistantMessageEvent.partial?.usage?.output,
      );
      this.renderer.update(ctx);
    }
  }
}

/**
 * Handles tool call end events.
 *
 * Pauses the engine for prompt-processing tools to avoid skewing averages.
 */
export class ToolcallEndHandler implements MessageHandler {
  readonly types = ["toolcall_end"];

  constructor(
    private readonly engine: TokenSpeedEngine,
    private readonly isTokenGeneration: (name: string) => boolean,
  ) {}

  handle(event: MessageUpdatePayload): void {
    const toolCall =
      event.assistantMessageEvent.partial?.content?.[
        event.assistantMessageEvent.contentIndex ?? 0
      ];
    if (toolCall?.type !== "toolCall") return;

    if (!this.isTokenGeneration(toolCall.name ?? "")) {
      this.engine.pause();
    }
  }
}
