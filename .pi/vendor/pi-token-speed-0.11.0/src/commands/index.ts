import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TokenSpeedEngine } from "../core/engine";
import type { Renderer } from "../ui/renderer";
import { OverridesHandler } from "./overrides-handler";
import { SettingsHandler } from "./settings-handler";

/**
 * Thin command router — dispatches `/tps` arguments to the appropriate handler.
 * All UI/ctx concerns are owned here; menu classes are pure UI components.
 */
export class CommandManager {
  private readonly handlers: Map<
    string,
    {
      handler: { handle: (ctx: ExtensionCommandContext) => Promise<void> };
      default?: boolean;
    }
  >;

  constructor(
    private readonly renderer: Renderer,
    private readonly engine: TokenSpeedEngine,
  ) {
    this.handlers = new Map();
    this.registerHandlers();
  }

  /**
   * Registers all command handlers into the dispatch map.
   */
  private registerHandlers(): void {
    const settingsHandler = new SettingsHandler(this.renderer, this.engine);
    this.handlers.set("", { handler: settingsHandler, default: true });

    const overridesHandler = new OverridesHandler(this.renderer, this.engine);
    this.handlers.set("overrides", { handler: overridesHandler });
  }

  /**
   * Argument completions for the `/tps` command.
   */
  getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
    const completions: AutocompleteItem[] = [
      {
        value: "overrides",
        label: "overrides",
        description: "Manage per-provider overrides",
      },
    ];
    const filtered = completions.filter((a) => a.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  }

  /**
   * Handles the `/tps` command.
   *
   * - No arguments: opens the settings menu (default handler).
   * - `overrides`: opens the per-provider overrides editor.
   * - Unknown: shows a warning notification.
   *
   * @param args Command arguments
   * @param ctx The command context
   */
  async runTps(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const entry = this.handlers.get(args);
    if (entry) return await entry.handler.handle(ctx);

    ctx.ui.notify(
      `Unknown argument "${args}" — usage: /tps [overrides]`,
      "warning",
    );
  }
}
