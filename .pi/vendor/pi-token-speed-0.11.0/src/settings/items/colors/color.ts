import type { TierName, TokenSpeedConfig } from "../../../config/types";
import type { ValidationCheckResult, ValidationResult } from "../../base";
import { TIERS } from "../../options";
import { TierSettingsItem } from "../tiers/base";
import { isValidHex } from "../tiers/validation";

export const COLOR_SLOW = "#ff4444";
export const COLOR_MEDIUM = "#ffaa00";
export const COLOR_FAST = "#00ff88";
export const COLOR_BLAZING = "#44ddff";

export class ColorItem extends TierSettingsItem {
  constructor(tier: TierName) {
    super("colors", tier);
  }

  readonly label = TIERS.find((t) => t.key === this.tier)!.label;
  readonly description = `Hex color for the ${this.tier} tier`;

  /**
   * Formats the current color value for the tier.
   *
   * @param config The current TokenSpeedConfig.
   * @returns The hex color string for this tier.
   */
  format(config: TokenSpeedConfig): string {
    const colors = config.colors as unknown as Record<string, string>;
    return colors[this.tier];
  }

  /**
   * Validates a raw color value (hex string).
   *
   * @param value The raw config value to validate.
   * @returns Whether the value is valid.
   */
  validate(value: unknown): ValidationCheckResult {
    if (value === undefined) return { valid: true };
    if (typeof value !== "string" || !isValidHex(value)) {
      return { valid: false, errors: [`Invalid hex color: "${value}"`] };
    }
    return { valid: true };
  }

  /**
   * Validates and sets a hex color for this tier.
   *
   * @param _config The current config (unused; validation is hex-only).
   * @param value The hex color string to set.
   * @returns A ValidationResult with the color partial.
   */
  setConfig(_config: TokenSpeedConfig, value: string): ValidationResult {
    if (!isValidHex(value)) {
      return { valid: false, errors: [`Invalid hex color: "${value}"`] };
    }
    return {
      valid: true,
      config: {
        colors: { [this.tier]: value.toLowerCase() },
      } as unknown as Partial<TokenSpeedConfig>,
    };
  }
}
