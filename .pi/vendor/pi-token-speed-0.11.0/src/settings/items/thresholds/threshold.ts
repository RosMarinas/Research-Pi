import type { TierName, TokenSpeedConfig } from "../../../config/types";
import type { ValidationCheckResult, ValidationResult } from "../../base";
import { TIERS } from "../../options";
import { TierSettingsItem } from "../tiers/base";
import { validateAscending } from "../tiers/validation";

export const TPS_THRESHOLD_SLOW = 0;
export const TPS_THRESHOLD_MEDIUM = 15;
export const TPS_THRESHOLD_FAST = 30;
export const TPS_THRESHOLD_BLAZING = 45;

export class ThresholdItem extends TierSettingsItem {
  constructor(tier: TierName) {
    super("thresholds", tier);
  }

  readonly label = TIERS.find((t) => t.key === this.tier)!.label;
  readonly description = `TPS threshold for the ${this.tier} tier`;

  /**
   * Formats the current threshold value for the tier.
   *
   * @param config The current TokenSpeedConfig.
   * @returns The threshold value as a string.
   */
  format(config: TokenSpeedConfig): string {
    const thresholds = config.thresholds as unknown as Record<string, number>;
    return thresholds[this.tier].toString();
  }

  /**
   * Validates a raw threshold value (non-negative integer).
   *
   * @param value The raw config value to validate.
   * @returns Whether the value is valid.
   */
  validate(value: unknown): ValidationCheckResult {
    if (value === undefined) return { valid: true };
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
      return { valid: false, errors: [`Invalid threshold: "${value}"`] };
    }
    return { valid: true };
  }

  /**
   * Validates and sets a threshold value for this tier.
   *
   * @param config The current config (used for ordering validation).
   * @param value The threshold value as a string.
   * @returns A ValidationResult with the thresholds partial.
   */
  setConfig(config: TokenSpeedConfig, value: string): ValidationResult {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
      return { valid: false, errors: [`Invalid threshold: "${value}"`] };
    }

    const merged = {
      ...config.thresholds,
      [this.tier]: num,
    };
    const ascErrors = validateAscending(merged);
    if (ascErrors.length) {
      return { valid: false, errors: ascErrors };
    }

    return {
      valid: true,
      config: {
        thresholds: { [this.tier]: num },
      } as unknown as Partial<TokenSpeedConfig>,
    };
  }
}
