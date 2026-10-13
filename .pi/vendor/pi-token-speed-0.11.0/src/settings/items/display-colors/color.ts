import type { DisplayColorKey, TokenSpeedConfig } from "../../../config/types";
import {
  SettingsItem,
  type ValidationCheckResult,
  type ValidationResult,
} from "../../base";
import { isValidHex } from "../tiers/validation";

export const DISPLAY_COLOR_LABELS: Record<DisplayColorKey, string> = {
  count: "Count",
  elapsed: "Elapsed",
  ttft: "TTFT",
};

/**
 * Settings item for a single display color (count, elapsed, ttft).
 * Reuses hex validation from `tiers/validation.ts` (strict #RRGGBB).
 */
export class DisplayColorSettingsItem extends SettingsItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;

  constructor(key: DisplayColorKey) {
    super();
    this.id = `displayColors.${key}`;
    this.label = DISPLAY_COLOR_LABELS[key];
    this.description = `Hex color for the ${key} part of the status bar suffix`;
  }

  /**
   * Formats the current display color value for its key.
   *
   * @param config The current TokenSpeedConfig.
   * @returns The hex color string ("" when unset).
   */
  format(config: TokenSpeedConfig): string {
    const key = this.id.split(".")[1] as DisplayColorKey;
    return config.displayColors?.[key] ?? "";
  }

  /**
   * Validates a raw display color value (strict #RRGGBB, "" = unset).
   *
   * @param value The raw config value to validate.
   * @returns Whether the value is valid.
   */
  validate(value: unknown): ValidationCheckResult {
    if (value === "" || value === undefined) return { valid: true };
    if (typeof value !== "string" || !isValidHex(value)) {
      return { valid: false, errors: [`Invalid hex color: "${value}"`] };
    }
    return { valid: true };
  }

  /**
   * Validates and sets a display color for its key.
   *
   * @param _config The current config (unused; validation is hex-only).
   * @param value The hex color string to set ("" to unset).
   * @returns A ValidationResult with the displayColors partial.
   */
  setConfig(_config: TokenSpeedConfig, value: string): ValidationResult {
    if (value !== "" && !isValidHex(value)) {
      return { valid: false, errors: [`Invalid hex color: "${value}"`] };
    }
    const key = this.id.split(".")[1] as DisplayColorKey;
    return {
      valid: true,
      config: {
        displayColors: { [key]: value.toLowerCase() },
      } as Partial<TokenSpeedConfig>,
    };
  }
}
