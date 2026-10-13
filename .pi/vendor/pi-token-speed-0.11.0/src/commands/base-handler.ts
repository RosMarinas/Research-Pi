import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";

/**
 * Abstract base for command handlers that display a settings menu.
 *
 * Subclasses implement `createMenu` to return the menu instance; the
 * shared `handle` method wires the menu into `ctx.ui.custom`.
 */
export abstract class BaseMenuHandler {
  /**
   * Creates the settings menu instance for this handler.
   *
   * @param ctx The command context (provides model/provider info).
   * @returns The menu to display.
   */
  protected abstract createMenu(ctx: ExtensionCommandContext): {
    menu: {
      create: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (value?: string) => void,
      ) => SettingsList;
    };
    onClosed: () => void;
  };

  /**
   * Shows the menu via `ctx.ui.custom` and runs the on-closed callback.
   *
   * @param ctx The command context.
   */
  async handle(ctx: ExtensionCommandContext): Promise<void> {
    const { menu, onClosed } = this.createMenu(ctx);
    await ctx.ui.custom<void>((tui, theme, kb, done) =>
      menu.create(tui, theme, kb, () => {
        onClosed();
        done(undefined);
      }),
    );
  }
}
