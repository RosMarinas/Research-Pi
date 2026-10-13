import type { SettingsItem } from "../settings/base";
import { SETTINGS_ITEMS } from "../settings/defaults";
import { OverrideValidator } from "../settings/items/override-validator";
import type {
  ProviderOverride,
  ProviderOverrides,
  TokenSpeedConfig,
} from "./types";

/**
 * Validation result returned by `validateConfig`.
 *
 * `config` always contains the corrected config (defaults applied for
 * invalid values). `errors` is empty when the config is fully valid.
 */
export interface ValidationResult {
  valid: boolean;
  config: TokenSpeedConfig;
  errors: string[];
}

/**
 * Validates TokenSpeed configuration by delegating to `SettingItem` instances.
 *
 * Handles two concerns:
 * 1. **Base config validation** — iterates over all registered `SettingsItem`s,
 *    validates each field, and applies corrections for invalid values.
 * 2. **Provider override sanitization** — cleans per-provider override blocks,
 *    dropping malformed entries and invalid keys while collecting warnings.
 */
export class SettingsValidator {
  /**
   * @param settingsItems The registry of all settings items (from `defaults.ts`).
   */
  constructor(
    private readonly settingsItems: Record<
      string,
      SettingsItem
    > = SETTINGS_ITEMS,
  ) {}

  /**
   * Validates the base config, delegating to each `SettingItem`.
   * Group items (thresholds, colors) act as composites that validate
   * their children.
   *
   * Invalid values are replaced with their defaults (via `validate()` correction).
   *
   * @param config The config to validate.
   * @returns The corrected config and any validation errors.
   */
  validateConfig(config: TokenSpeedConfig): ValidationResult {
    const response = { ...config };
    const errors: string[] = [];

    for (const item of Object.values(this.settingsItems)) {
      const result = item.validate(response[item.id as keyof TokenSpeedConfig]);
      if (!result.valid && result.errors) {
        errors.push(...result.errors);
      }
      if (result.corrected !== undefined) {
        (response as unknown as Record<string, unknown>)[item.id] =
          result.corrected;
      }
    }

    return {
      valid: errors.length === 0,
      config: response as TokenSpeedConfig,
      errors,
    };
  }

  /**
   * Sanitizes the raw `providerOverrides` value: keeps valid provider →
   * partial-config entries (with invalid keys dropped and warned about),
   * drops malformed entries entirely.
   *
   * @param raw The raw tokenSpeed settings block.
   * @param baseConfig The merged base config (defaults + user base settings),
   *   used as the fallback when validating per-tier groups.
   * @returns The cleaned overrides and any validation error messages.
   */
  sanitizeProviderOverrides(
    raw: Record<string, unknown>,
    baseConfig: TokenSpeedConfig,
  ): { overrides: ProviderOverrides; errors: string[] } {
    const overrides: ProviderOverrides = {};
    const errors: string[] = [];

    const rawValue = raw.providerOverrides;
    if (rawValue === undefined) return { overrides, errors };

    if (!this.isPlainObject(rawValue)) {
      errors.push("- providerOverrides must be an object — ignoring.");
      return { overrides, errors };
    }

    for (const [providerId, block] of Object.entries(rawValue)) {
      if (!this.isPlainObject(block)) {
        errors.push(
          `- providerOverrides["${providerId}"] must be an object — entry ignored.`,
        );
        continue;
      }
      const { config, errors: blockErrors } = new OverrideValidator(
        providerId,
        baseConfig,
      ).validate(block as ProviderOverride);
      errors.push(...blockErrors);
      overrides[providerId] = config;
    }

    return { overrides, errors };
  }

  /**
   * Checks whether `value` is a plain object (not null, not array).
   *
   * @param value The value to check.
   * @returns True if value is a plain object.
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
