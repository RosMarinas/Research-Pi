import { THRESHOLD_ITEMS } from ".";
import type { Thresholds, TokenSpeedConfig } from "../../../config/types";
import {
  SettingsItem,
  ValidationResult,
  type ValidationCheckResult,
} from "../../base";
import { validateAscending } from "../tiers/validation";

/**
 * Grouped settings item for the Thresholds submenu.
 *
 * Composite: validates all tiers and their ordering.
 */
export class ThresholdsGroupSettingsItem extends SettingsItem {
  readonly id = "thresholds";
  readonly label = "Thresholds";
  readonly description =
    "Customize TPS thresholds (slow, medium, fast, blazing)";

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
   * Composite validation: checks each tier and ordering.
   *
   * @param value The thresholds object to validate.
   * @returns Whether the thresholds are valid.
   */
  validate(value: unknown): ValidationCheckResult {
    const thresholds = value as Thresholds | undefined;
    if (!thresholds || typeof thresholds !== "object") {
      return { valid: false, errors: ["Thresholds must be an object."] };
    }
    const errors: string[] = [];
    for (const tier of Object.values(THRESHOLD_ITEMS)) {
      const result = tier.validate(
        thresholds[tier.id.split(".")[1] as keyof Thresholds],
      );
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
    }
    errors.push(...validateAscending(thresholds));
    return {
      valid: errors.length === 0,
      errors: errors.length ? errors : undefined,
    };
  }
}
