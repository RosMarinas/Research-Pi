import { COLOR_ITEMS } from ".";
import type { Colors, TokenSpeedConfig } from "../../../config/types";
import {
  SettingsItem,
  ValidationResult,
  type ValidationCheckResult,
} from "../../base";

/**
 * Grouped settings item for the Colors submenu.
 *
 * Composite: validates all tiers.
 */
export class ColorsGroupSettingsItem extends SettingsItem {
  readonly id = "colors";
  readonly label = "Colors";
  readonly description = "Customize tier colors (slow, medium, fast, blazing)";

  /**
   * Returns undefined — this is a group entry that opens a submenu.
   *
   * @param _config The current config (unused).
   * @returns undefined.
   */
  format(_config: TokenSpeedConfig): undefined {
    return undefined;
  }

  /**
   * Returns invalid — this group has no direct value.
   *
   * @param _config The current config (unused).
   * @param _value The value to set (unused).
   * @returns An invalid ValidationResult.
   */
  setConfig(_config: TokenSpeedConfig, _value: string): ValidationResult {
    return { valid: false };
  }

  /**
   * Composite validation: checks each tier's hex validity.
   *
   * @param value The colors object to validate.
   * @returns Whether the colors are valid.
   */
  validate(value: unknown): ValidationCheckResult {
    const colors = value as Colors | undefined;
    if (!colors || typeof colors !== "object") {
      return { valid: false, errors: ["Colors must be an object."] };
    }
    const errors: string[] = [];
    for (const tier of Object.values(COLOR_ITEMS)) {
      const result = tier.validate(
        colors[tier.id.split(".")[1] as keyof Colors],
      );
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
    }
    return {
      valid: errors.length === 0,
      errors: errors.length ? errors : undefined,
    };
  }
}
