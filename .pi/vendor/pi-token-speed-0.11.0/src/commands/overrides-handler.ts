import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import { settings } from "../config/settings";
import type { TokenSpeedEngine } from "../core/engine";
import { OverrideSettingsMenu } from "../settings/menu/override-settings-menu";
import type { Renderer } from "../ui/renderer";
import { BaseMenuHandler } from "./base-handler";

/**
 * Handles the "overrides" argument — opens the per-provider overrides menu.
 */
export class OverridesHandler extends BaseMenuHandler {
  constructor(
    private readonly renderer: Renderer,
    private readonly engine: TokenSpeedEngine,
  ) {
    super();
  }

  protected override createMenu(ctx: ExtensionCommandContext): {
    menu: {
      create: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (value?: string) => void,
      ) => SettingsList;
    };
    onClosed: () => void;
  } {
    const overrides = settings.getConfig().providerOverrides;
    const menu = new OverrideSettingsMenu({
      overrides: { ...overrides },
      persist: (next) => settings.setProviderOverrides(next),
      onSettingChange: () => {
        this.engine.initialize();
        this.engine.applyProvider(ctx.model?.provider);
        this.renderer.update(ctx);
      },
      onWarning: (message) => ctx.ui.notify(message, "error"),
    });

    return {
      menu,
      onClosed: () => {},
    };
  }
}
