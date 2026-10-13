import { DISPLAY_COLOR_ITEMS } from ".";
import type { DisplayColors, TokenSpeedConfig } from "../../../config/types";
import {
  SettingsItem,
  type ValidationCheckResult,
  type ValidationResult,
} from "../../base";

/**
 * Grouped settings item for the Display colors submenu.
 *
 * Composite: validates all three keys.
 */
export class DisplayColorsGroupSettingsItem extends SettingsItem {
  readonly id = "displayColors";
  readonly label = "Display colors";
  readonly description = "Customize suffix colors (count, elapsed, ttft)";

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
   * Composite validation: checks each key's hex validity.
   *
   * @param value The displayColors object to validate.
   * @returns Whether the display colors are valid.
   */
  validate(value: unknown): ValidationCheckResult {
    const colors = value as DisplayColors | undefined;
    if (colors !== undefined && typeof colors !== "object") {
      return { valid: false, errors: ["Display colors must be an object."] };
    }
    const errors: string[] = [];
    for (const item of Object.values(DISPLAY_COLOR_ITEMS)) {
      const result = item.validate(
        (colors as Record<string, unknown>)?.[item.id.split(".")[1]],
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
