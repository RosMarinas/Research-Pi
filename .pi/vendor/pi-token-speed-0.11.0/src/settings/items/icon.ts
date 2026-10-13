import type { TokenSpeedConfig } from "../../config/types";
import { ValidationCheckResult, ValidationResult } from "../base";
import { ScalarSettingsItem } from "./scalar";

export const DEFAULT_ICON = "⚡";

const ICONS = ["⚡", "🔥", "💨", "🚀", ""] as const;

/**
 * String setting with special normalization: "(empty)" → "".
 *
 * Extends ScalarSettingsItem and overrides setConfig + validate
 * to handle the icon set and "(empty)" display label.
 */
export class IconSettingsItem extends ScalarSettingsItem<string> {
  constructor() {
    super({
      id: "icon",
      label: "Status icon",
      description: "Icon shown before TPS in the status bar",
      default: DEFAULT_ICON,
    });
  }

  values: string[] = [...ICONS.slice(0, -1), "(empty)"];

  /**
   * Formats the icon value for display in the status bar.
   *
   * @param config The current TokenSpeedConfig.
   * @returns The formatted icon string (uses default when empty).
   */
  format(config: TokenSpeedConfig): string {
    const value = config[this.options.id];
    if (typeof value === "string" && value !== "") return value;
    return this.options.default;
  }

  /**
   * Sets the icon config value, normalizing "(empty)" → "".
   *
   * @param _config The current TokenSpeedConfig (unused).
   * @param value The display-value string from the user.
   * @returns A ValidationResult with the config patch.
   */
  setConfig(_config: TokenSpeedConfig, value: string): ValidationResult {
    if (!this.values!.includes(value)) {
      return { valid: false, errors: [`Invalid icon: "${value}"`] };
    }
    return { valid: true, config: { icon: value === "(empty)" ? "" : value } };
  }

  /**
   * Validates the icon value, normalizing "(empty)" → "" and rejecting invalid icons.
   *
   * @param value The value to validate.
   * @returns A ValidationCheckResult with validity, corrections, and errors.
   */
  validate(value: unknown): ValidationCheckResult {
    if (typeof value !== "string") {
      return {
        valid: false,
        corrected: this.options.default,
        errors: [
          `Invalid icon (expected string) — defaulting to "${this.options.default}".`,
        ],
      };
    }
    const normalized = value === "(empty)" ? "" : value;
    if (ICONS.includes(normalized as (typeof ICONS)[number])) {
      return { valid: true, corrected: normalized };
    }
    return {
      valid: false,
      corrected: this.options.default,
      errors: [
        `Invalid icon "${value}" — defaulting to "${this.options.default}".`,
      ],
    };
  }
}
