import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TUI } from "@earendil-works/pi-tui";
import { settings } from "../config/settings";
import type {
  DisplayColorKey,
  ProviderOverride,
  TierName,
  TokenSpeedConfig,
} from "../config/types";
import { DISPLAY_COLOR_LABELS } from "../settings/items/display-colors/color";
import { isValidHex } from "../settings/items/tiers/validation";
import { TIERS } from "../settings/options";
import { truecolor } from "./ansi";
import { HexColorInput } from "./color-input";
import { InputDialog } from "./dialog/input-dialog";
import { BASE } from "./editor/utils";

/** A TIERS entry (tier key + display label). */
type TierInfo = (typeof TIERS)[number];

/**
 * Builds SettingsList items for tier submenus (colors and thresholds).
 * Each tier opens a framed `InputDialog` for editing on Enter.
 *
 * Values are resolved through protected hooks so subclasses (e.g.
 * `OverrideTierSubmenuBuilder`) can redirect reads to an override block
 * without duplicating the item construction.
 */
export class TierSubmenuBuilder {
  private readonly placeholder: string = "■";

  constructor(
    private readonly theme: Theme,
    private readonly tui: TUI,
  ) {}

  /**
   * Builds the SettingsList items for the color customization submenu.
   *
   * @returns Array of SettingItem for the color submenu.
   */
  buildColors(): SettingItem[] {
    return TIERS.map((tier) => {
      const hex = this.resolveColor(tier.key);
      return {
        id: `colors.${tier.key}`,
        label: `${truecolor(this.placeholder, hex)} ${tier.label}`,
        description: this.colorDescription(tier, hex),
        currentValue: this.colorCurrentValue(tier, hex),
        // Read the value fresh each time the submenu opens so that
        // previously saved colors are reflected immediately
        submenu: InputDialog.inputSubmenu(this.theme, this.tui, {
          title: `${tier.label} color`,
          message: this.colorMessage(tier, hex),
          placeholder: "#RRGGBB",
          initialValue: this.colorInitialValue(tier, hex),
          // Live hex preview while typing (see PLAN_COLORS.md).
          createInput: () => new HexColorInput(),
          // Normalize on commit: hex is stored lower-cased regardless
          // of how the user typed it (isValidHex accepts both cases).
          validate: (raw) => this.validateColor(raw),
        }),
      };
    });
  }

  /**
   * Builds the SettingsList items for the TPS threshold customization submenu.
   *
   * @returns Array of SettingItem for the threshold submenu.
   */
  buildThresholds(): SettingItem[] {
    return TIERS.map((tier) => {
      const value = this.resolveThreshold(tier.key);
      return {
        id: `thresholds.${tier.key}`,
        label: tier.label,
        description: this.thresholdDescription(tier, value),
        currentValue: this.thresholdCurrentValue(tier, value),
        // Read the value fresh each time the submenu opens so that
        // previously saved thresholds are reflected immediately
        submenu: InputDialog.inputSubmenu(this.theme, this.tui, {
          title: `${tier.label} threshold`,
          message: this.thresholdMessage(tier, value),
          placeholder: "non-negative integer",
          initialValue: this.thresholdInitialValue(tier, value),
          validate: (raw) => this.validateThreshold(raw),
        }),
      };
    });
  }

  /**
   * Builds the SettingsList items for the display color customization submenu.
   *
   * @returns Array of SettingItem for the display color submenu.
   */
  buildDisplayColors(): SettingItem[] {
    return (["count", "elapsed", "ttft"] as DisplayColorKey[]).map((key) => {
      const hex = this.resolveDisplayColor(key);
      return {
        id: `displayColors.${key}`,
        label: `${truecolor(this.placeholder, hex)} ${DISPLAY_COLOR_LABELS[key]}`,
        description: this.displayColorDescription(key, hex),
        currentValue: this.displayColorCurrentValue(key, hex),
        submenu: InputDialog.inputSubmenu(this.theme, this.tui, {
          title: `${DISPLAY_COLOR_LABELS[key]} display color`,
          message: this.displayColorMessage(key, hex),
          placeholder: "#RRGGBB",
          initialValue: this.displayColorInitialValue(key, hex),
          createInput: () => new HexColorInput(),
          validate: (raw) => this.validateDisplayColor(raw),
        }),
      };
    });
  }

  // ── Value resolvers ───────────────────────────────────────────────────

  /**
   * Resolves the configured TPS threshold for a tier.
   *
   * @param tier The tier key.
   * @returns The threshold value.
   */
  protected resolveThreshold(tier: TierName): number {
    return settings.getConfig().thresholds[tier];
  }

  /**
   * Resolves the configured hex color for a tier.
   *
   * @param tier The tier key.
   * @returns The hex color string.
   */
  protected resolveColor(tier: TierName): string {
    return settings.getConfig().colors[tier];
  }

  /**
   * Resolves the configured hex display color for a key.
   *
   * @param key The display color key.
   * @returns The hex color string ("" when unset).
   */
  protected resolveDisplayColor(key: DisplayColorKey): string {
    return settings.getConfig().displayColors[key];
  }

  // ── Threshold formatting hooks ────────────────────────────────────────

  /**
   * Description for a threshold row.
   *
   * @param tier The tier entry.
   * @param value The resolved threshold value.
   * @returns The description text.
   */
  protected thresholdDescription(tier: TierInfo, _value: number): string {
    return `TPS threshold for the ${tier.label.toLowerCase()} tier`;
  }

  /**
   * Displayed current value for a threshold row.
   *
   * @param tier The tier entry.
   * @param value The resolved threshold value.
   * @returns The display string.
   */
  protected thresholdCurrentValue(_tier: TierInfo, value: number): string {
    return value.toString();
  }

  /**
   * Initial input value when the threshold dialog opens.
   *
   * @param tier The tier entry.
   * @param value The resolved threshold value.
   * @returns The initial input string.
   */
  protected thresholdInitialValue(_tier: TierInfo, value: number): string {
    return value.toString();
  }

  /**
   * Message shown inside the threshold input dialog.
   *
   * @param tier The tier entry.
   * @param value The resolved threshold value.
   * @returns The message text.
   */
  protected thresholdMessage(tier: TierInfo, _value: number): string {
    return `TPS threshold for the ${tier.label.toLowerCase()} tier`;
  }

  /**
   * Validates a raw threshold input.
   *
   * @param raw The raw input string.
   * @returns The normalized value, or null when invalid.
   */
  protected validateThreshold(raw: string): string | null {
    const num = Number(raw);
    return Number.isFinite(num) && num >= 0 && Number.isInteger(num)
      ? num.toString()
      : null;
  }

  // ── Color formatting hooks ────────────────────────────────────────────

  /**
   * Description for a color row.
   *
   * @param tier The tier entry.
   * @param hex The resolved hex color.
   * @returns The description text.
   */
  protected colorDescription(tier: TierInfo, _hex: string): string {
    return `Hex color for the ${tier.label.toLowerCase()} tier`;
  }

  /**
   * Displayed current value for a color row.
   *
   * @param tier The tier entry.
   * @param hex The resolved hex color.
   * @returns The display string.
   */
  protected colorCurrentValue(_tier: TierInfo, hex: string): string {
    return hex;
  }

  /**
   * Initial input value when the color dialog opens.
   *
   * @param tier The tier entry.
   * @param hex The resolved hex color.
   * @returns The initial input string.
   */
  protected colorInitialValue(_tier: TierInfo, hex: string): string {
    return hex;
  }

  /**
   * Message shown inside the color input dialog.
   *
   * @param tier The tier entry.
   * @param hex The resolved hex color.
   * @returns The message text.
   */
  protected colorMessage(tier: TierInfo, _hex: string): string {
    return `Hex color for the ${tier.label.toLowerCase()} tier`;
  }

  /**
   * Validates a raw color input.
   *
   * @param raw The raw input string.
   * @returns The normalized value, or null when invalid.
   */
  protected validateColor(raw: string): string | null {
    return isValidHex(raw) ? raw.toLowerCase() : null;
  }

  /**
   * Description for a display color row.
   *
   * @param key The display color key.
   * @param hex The resolved hex color.
   * @returns The description text.
   */
  protected displayColorDescription(
    key: DisplayColorKey,
    _hex: string,
  ): string {
    return `Hex color for the ${key} part of the status bar suffix`;
  }

  /**
   * Displayed current value for a display color row.
   *
   * @param key The display color key.
   * @param hex The resolved hex color.
   * @returns The display string.
   */
  protected displayColorCurrentValue(
    _key: DisplayColorKey,
    hex: string,
  ): string {
    return hex || "(none)";
  }

  /**
   * Initial input value when the display color dialog opens.
   *
   * @param key The display color key.
   * @param hex The resolved hex color.
   * @returns The initial input string.
   */
  protected displayColorInitialValue(
    _key: DisplayColorKey,
    hex: string,
  ): string {
    return hex;
  }

  /**
   * Message shown inside the display color input dialog.
   *
   * @param key The display color key.
   * @param hex The resolved hex color.
   * @returns The message text.
   */
  protected displayColorMessage(key: DisplayColorKey, _hex: string): string {
    return `Hex color for the ${key} part of the status bar suffix`;
  }

  /**
   * Validates a raw display color input.
   *
   * @param raw The raw input string.
   * @returns The normalized value, or null when invalid.
   */
  protected validateDisplayColor(raw: string): string | null {
    return isValidHex(raw) ? raw.toLowerCase() : null;
  }
}

/**
 * Builds tier submenu items for a provider override block: values come
 * from the block when set, falling back to the base config otherwise.
 *
 * Non-overridden fields display the `(base)` marker, submit an empty
 * value (interpreted by `computeNextBlock` as "remove key → use base"),
 * and mention the base value in their descriptions and dialog messages.
 */
export class OverrideTierSubmenuBuilder extends TierSubmenuBuilder {
  constructor(
    theme: Theme,
    tui: TUI,
    private readonly base: TokenSpeedConfig,
    private readonly getBlock: () => ProviderOverride,
  ) {
    super(theme, tui);
  }

  /** Reads from the override block, falling back to the base config. */
  protected override resolveThreshold(tier: TierName): number {
    return this.getBlock().thresholds?.[tier] ?? this.base.thresholds[tier];
  }

  /** Reads from the override block, falling back to the base config. */
  protected override resolveColor(tier: TierName): string {
    return this.getBlock().colors?.[tier] ?? this.base.colors[tier];
  }

  protected override thresholdDescription(
    tier: TierInfo,
    _value: number,
  ): string {
    return `TPS threshold override for the ${tier.label.toLowerCase()} tier (Base: ${this.base.thresholds[tier.key]})`;
  }

  /** `(base)` marker when the tier is not overridden. */
  protected override thresholdCurrentValue(
    tier: TierInfo,
    _value: number,
  ): string {
    return this.getBlock().thresholds?.[tier.key]?.toString() ?? BASE;
  }

  /** Empty initial value when the tier is not overridden. */
  protected override thresholdInitialValue(
    tier: TierInfo,
    _value: number,
  ): string {
    return this.getBlock().thresholds?.[tier.key]?.toString() ?? "";
  }

  protected override thresholdMessage(tier: TierInfo, _value: number): string {
    return `TPS threshold for the ${tier.label.toLowerCase()} tier (empty = reset to base: ${this.base.thresholds[tier.key]})`;
  }

  /** Accepts an empty input as "reset to base". */
  protected override validateThreshold(raw: string): string | null {
    if (raw.trim() === "") return "";
    return super.validateThreshold(raw);
  }

  protected override colorDescription(tier: TierInfo, _hex: string): string {
    return `Hex color override for the ${tier.label.toLowerCase()} tier (Base: ${this.base.colors[tier.key]})`;
  }

  /** `(base)` marker when the tier is not overridden. */
  protected override colorCurrentValue(tier: TierInfo, _hex: string): string {
    return this.getBlock().colors?.[tier.key] ?? BASE;
  }

  /** Empty initial value when the tier is not overridden. */
  protected override colorInitialValue(tier: TierInfo, _hex: string): string {
    return this.getBlock().colors?.[tier.key] ?? "";
  }

  protected override colorMessage(tier: TierInfo, _hex: string): string {
    return `Hex color for the ${tier.label.toLowerCase()} tier (empty = reset to base: ${this.base.colors[tier.key]})`;
  }

  /** Accepts an empty input as "reset to base". */
  protected override validateColor(raw: string): string | null {
    if (raw.trim() === "") return "";
    return super.validateColor(raw);
  }

  /** Reads from the override block, falling back to the base config. */
  protected override resolveDisplayColor(key: DisplayColorKey): string {
    return this.getBlock().displayColors?.[key] ?? this.base.displayColors[key];
  }

  protected override displayColorDescription(
    key: DisplayColorKey,
    _hex: string,
  ): string {
    return `Hex color override for the ${key} part (Base: ${this.base.displayColors[key] || "(none)"})`;
  }

  /** `(base)` marker when the key is not overridden. */
  protected override displayColorCurrentValue(
    key: DisplayColorKey,
    _hex: string,
  ): string {
    return this.getBlock().displayColors?.[key] ?? BASE;
  }

  /** Empty initial value when the key is not overridden. */
  protected override displayColorInitialValue(
    key: DisplayColorKey,
    _hex: string,
  ): string {
    return this.getBlock().displayColors?.[key] ?? "";
  }

  protected override displayColorMessage(
    key: DisplayColorKey,
    _hex: string,
  ): string {
    return `Hex color for the ${key} part (empty = reset to base: ${this.base.displayColors[key] || "(none)"})`;
  }

  /** Accepts an empty input as "reset to base". */
  protected override validateDisplayColor(raw: string): string | null {
    if (raw.trim() === "") return "";
    return super.validateDisplayColor(raw);
  }
}
