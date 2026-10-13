import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingItem,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import { settings } from "../../config/settings";
import type {
  Colors,
  DisplayColors,
  Thresholds,
  TokenSpeedConfig,
} from "../../config/types";
import { truecolor } from "../../ui/ansi";
import { TierSubmenuBuilder } from "../../ui/color-picker";
import {
  DISPLAY_COLOR_SETTINGS_ITEMS,
  SETTINGS_ITEMS,
  TIER_SETTINGS_ITEMS,
} from "../defaults";
import { TIERS } from "../options";
import { AbstractSettingsMenu } from "./abstract-settings-menu";
import { SettingsListRefresher } from "./settings-list-refresher";

/**
 * Options for the base settings menu.
 */
export interface SettingsMenuOptions {
  config: TokenSpeedConfig;
  onSettingChange: () => void; // callback for re-apply engine + renderer
  onWarning?: (message: string) => void;
}

/**
 * Base settings menu — absolute values, full config.
 *
 * Pure UI component: no `ExtensionCommandContext`, no engine/renderer.
 * Accepts an `onSettingChange` callback to trigger re-apply after changes.
 */
export class SettingsMenu extends AbstractSettingsMenu {
  private refresher: SettingsListRefresher;

  constructor(private readonly opts: SettingsMenuOptions) {
    super();
    this.refresher = new SettingsListRefresher(this, this);
  }

  getThresholds(): Thresholds {
    return settings.getConfig().thresholds;
  }

  getColors(): Colors {
    return settings.getConfig().colors;
  }

  getDisplayColors(): DisplayColors {
    return settings.getConfig().displayColors;
  }

  /**
   * Creates the settings list UI.
   *
   * @param tui The TUI instance.
   * @param theme The active theme.
   * @param keybindings The keybindings manager.
   * @param done Callback when the menu is closed.
   * @returns A SettingsList to display.
   */
  create(
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    done: (value?: string) => void,
  ): SettingsList {
    const config = this.opts.config;
    const items = this.buildSettingsItems(config, theme, tui);
    this.settingsList = this.createMainSettingsList(
      items,
      items.length,
      (id, newValue) => this.handleSettingChange(id, newValue),
      () => done(undefined),
      (id) => this.resetSetting(id),
      tui,
    );
    return this.settingsList;
  }

  /**
   * Validates and persists a setting change to the global config.
   *
   * @param id The setting identifier.
   * @param value The new value to set.
   * @returns Whether the change was committed.
   */
  protected override async commit(id: string, value: string): Promise<boolean> {
    const config = settings.getConfig();
    const item =
      SETTINGS_ITEMS[id] ??
      TIER_SETTINGS_ITEMS[id] ??
      DISPLAY_COLOR_SETTINGS_ITEMS[id];
    if (!item) return false;
    const result = item.setConfig(config, value);
    if (!result.valid) {
      this.opts.onWarning?.(
        `[pi-token-speed] ${result.errors?.join("\n") ?? "Invalid value."}`,
      );
      return false;
    }
    await settings.setConfig(result.config!);
    return true;
  }

  /**
   * Fires the external re-apply callback, then refreshes the lists.
   *
   * @param id The setting identifier that changed.
   */
  protected override afterChange(id: string): void {
    this.opts.onSettingChange();
    super.afterChange(id);
  }

  /**
   * Resets a single (scalar or per-tier) setting by deleting its key
   * from the persisted config (so it falls back to the default) and
   * reflects the reset value in the main menu's row.
   *
   * @param id The setting identifier.
   */
  protected override async resetScalar(id: string): Promise<void> {
    const item =
      SETTINGS_ITEMS[id] ??
      TIER_SETTINGS_ITEMS[id] ??
      DISPLAY_COLOR_SETTINGS_ITEMS[id];
    if (!item) return;
    await settings.resetKeys([id]);

    // Reflect the reset value in the main menu's row
    const mainValue = item.format(settings.getConfig());
    if (mainValue !== undefined) {
      this.settingsList?.updateValue(id, mainValue);
    }
  }

  /**
   * Resets a grouped setting (thresholds or colors) by deleting the
   * group key from the persisted config (so all tiers fall back to
   * their defaults).
   *
   * @param id The group identifier ("thresholds" or "colors").
   */
  protected override async resetGroup(id: string): Promise<void> {
    const item = SETTINGS_ITEMS[id];
    if (!item) return;
    await settings.resetKeys([id]);
  }

  /**
   * Fires the external re-apply callback, then refreshes the lists.
   *
   * @param id The setting identifier that was reset.
   */
  protected override afterReset(id: string): void {
    this.opts.onSettingChange();
    super.afterReset(id);
  }

  /**
   * Builds the full list of SettingItems for the main settings menu.
   *
   * @param config The current TokenSpeedConfig.
   * @param theme The active theme (for colored blocks).
   * @param tui The TUI instance (for submenu dialogs).
   * @returns An array of SettingItems.
   */
  private buildSettingsItems(
    config: TokenSpeedConfig,
    theme: Theme,
    tui: TUI,
  ): SettingItem[] {
    const items: SettingItem[] = [];
    for (const [id, setting] of Object.entries(SETTINGS_ITEMS)) {
      const currentValue = setting.format(config);
      if (currentValue === undefined) continue;
      items.push({
        id,
        label: setting.label,
        description: setting.description,
        currentValue,
        ...(setting.values ? { values: setting.values } : {}),
      });
    }

    // Group items — Thresholds and Colors
    const thresholdsItem = SETTINGS_ITEMS["thresholds"];
    if (thresholdsItem) {
      const thresholdsDisplay = Object.values(config.thresholds).join(" | ");
      items.push({
        id: "thresholds",
        label: thresholdsItem.label,
        description: thresholdsItem.description,
        currentValue: thresholdsDisplay,
        submenu: (_currentValue: string, done) => {
          const submenuItems = new TierSubmenuBuilder(
            theme,
            tui,
          ).buildThresholds();
          return this.createSubmenuList(
            submenuItems,
            Math.min(submenuItems.length + 2, 15),
            (id, newValue) => this.handleSettingChange(id, newValue),
            () => done(undefined),
            (id) => this.resetSetting(id),
            tui,
          );
        },
      });
    }

    const colorsItem = SETTINGS_ITEMS["colors"];
    if (colorsItem) {
      const colorsDisplay = Object.values(config.colors)
        .map((h) => truecolor("■", h))
        .join(" ");
      items.push({
        id: "colors",
        label: colorsItem.label,
        description: colorsItem.description,
        currentValue: colorsDisplay,
        submenu: (_currentValue: string, done) => {
          const submenuItems = new TierSubmenuBuilder(theme, tui).buildColors();
          return this.createSubmenuList(
            submenuItems,
            Math.min(submenuItems.length + 2, 15),
            (id, newValue) => this.handleSettingChange(id, newValue),
            () => done(undefined),
            (id) => this.resetSetting(id),
            tui,
          );
        },
      });
    }

    const displayColorsItem = SETTINGS_ITEMS["displayColors"];
    if (displayColorsItem) {
      const dc = config.displayColors;
      const displayColorsDisplay = (["count", "elapsed", "ttft"] as const)
        .map((key) => truecolor("■", dc[key]))
        .join(" ");
      items.push({
        id: "displayColors",
        label: displayColorsItem.label,
        description: displayColorsItem.description,
        currentValue: displayColorsDisplay,
        submenu: (_currentValue: string, done) => {
          const submenuItems = new TierSubmenuBuilder(
            theme,
            tui,
          ).buildDisplayColors();
          return this.createSubmenuList(
            submenuItems,
            Math.min(submenuItems.length + 2, 15),
            (id, newValue) => this.handleSettingChange(id, newValue),
            () => done(undefined),
            (id) => this.resetSetting(id),
            tui,
          );
        },
      });
    }

    return items;
  }

  /**
   * Refreshes threshold values across the main list, threshold submenu,
   * and active submenu (if thresholds is open).
   */
  override refreshThresholdItems(): void {
    const config = settings.getConfig();
    const allThresholds = TIERS.map(({ key }) => config.thresholds[key]).join(
      " | ",
    );

    if (this.settingsList) {
      this.settingsList.updateValue("thresholds", allThresholds);
      this.settingsList.invalidate();
    }

    this.refresher.refreshThresholds();
  }

  /**
   * Refreshes color values across the main list, color submenu,
   * and active submenu (if colors is open).
   */
  override refreshColorItems(): void {
    const config = settings.getConfig();

    if (this.settingsList) {
      this.settingsList.updateValue(
        "colors",
        TIERS.map(({ key }) => truecolor("■", config.colors[key])).join(" "),
      );
      this.settingsList.invalidate();
    }

    this.refresher.refreshColors();
  }

  /**
   * Refreshes display color values across the main list, display color submenu,
   * and active submenu (if displayColors is open).
   */
  override refreshDisplayColorItems(): void {
    const config = settings.getConfig();
    const dc = config.displayColors;

    if (this.settingsList) {
      this.settingsList.updateValue(
        "displayColors",
        (["count", "elapsed", "ttft"] as const)
          .map((key) => truecolor("■", dc[key]))
          .join(" "),
      );
      this.settingsList.invalidate();
    }

    this.refresher.refreshDisplayColors();
  }
}
