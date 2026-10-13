import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Registry of message event handlers for the token-speed engine.
 *
 * Each handler declares which event types it responds to via its `types`
 * property. The registry dispatches events to the first matching handler
 * (only one handler per event type is invoked).
 */
export class MessageHandlerRegistry {
  private readonly handlers: MessageHandler[] = [];

  register(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  handle(event: MessageUpdatePayload, ctx: ExtensionContext): void {
    for (const handler of this.handlers) {
      if (handler.types.includes(event.assistantMessageEvent.type)) {
        handler.handle(event, ctx);
        return;
      }
    }
  }
}

/**
 * Contract for handlers that process individual message update events.
 */
export interface MessageHandler {
  /** Which event types this handler responds to. */
  readonly types: string[];
  /** Process the given event. */
  handle(event: MessageUpdatePayload, ctx: ExtensionContext): void;
}

/** Payload for message update events. */
export interface MessageUpdatePayload {
  assistantMessageEvent: {
    type: string;
    delta?: string;
    partial?: {
      content?: ToolCall[];
      usage?: { output?: number };
    };
    contentIndex?: number;
  };
}

/** Minimal tool call representation. */
export interface ToolCall {
  type: string;
  name?: string;
}
