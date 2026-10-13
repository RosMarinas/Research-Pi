import type { ProviderOverride, TokenSpeedConfig } from "../config/types";

/**
 * Validation result returned by `setConfig`.
 */
export interface ValidationResult {
  valid: boolean;
  config?: Partial<TokenSpeedConfig>;
  errors?: string[];
}

/**
 * Result from `validate` — checks a raw value and returns a corrected
 * default when invalid.
 */
export interface ValidationCheckResult {
  valid: boolean;
  corrected?: unknown;
  errors?: string[];
}

/**
 * Abstract base for all settings items.
 *
 * Each concrete subclass owns its own:
 * - `id` — unique setting identifier
 * - `label` — display name
 * - `description` — help text
 * - `values` — possible values (for dropdowns)
 * - `format(config)` — reads current value → string
 * - `setConfig(config, value)` — validates and returns partial config
 * - `reset(defaults)` — returns partial config with default value
 *
 * Partial variants (`formatPartial` / `setConfigPartial`) accept a
 * `ProviderOverride` (which may be missing fields) by merging it with
 * the supplied defaults before delegating to the abstract methods.
 * This lets the overrides editor reuse the same validation/formatting
 * logic as the global settings menu without duplicating it.
 */
export abstract class SettingsItem {
  /**
   * Merges a partial override with defaults, properly handling nested
   * `thresholds` and `colors` objects (per-tier merge, not replace).
   */
  private static mergePartial(
    defaults: TokenSpeedConfig,
    override_: ProviderOverride,
  ): TokenSpeedConfig {
    return {
      ...defaults,
      ...override_,
      thresholds: { ...defaults.thresholds, ...override_.thresholds },
      colors: { ...defaults.colors, ...override_.colors },
      displayColors: {
        ...defaults.displayColors,
        ...override_.displayColors,
      },
    };
  }
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly description: string;
  readonly values?: string[];

  /**
   * Formats the current value from config into a display string.
   */
  abstract format(config: TokenSpeedConfig): string | undefined;

  /**
   * Validates and writes a new value. Returns a partial config to persist.
   */
  abstract setConfig(config: TokenSpeedConfig, value: string): ValidationResult;

  /**
   * Validates a raw config value and returns a corrected value if invalid.
   *
   * Concrete subclasses must implement this to own their validation +
   * correction logic. Group items (thresholds, colors) return a no-op
   * result — they have no single config field to validate.
   *
   * @param value The raw config value to validate.
   * @returns Whether the value is valid and the corrected value (if invalid).
   */
  validate(_value: unknown): ValidationCheckResult {
    // Default: no-op for group items. Concrete items override.
    return { valid: true };
  }

  /**
   * Returns the default value for this setting (used by config generation).
   * Scalar items override this; grouped items return undefined.
   */
  getDefault(): unknown {
    return undefined;
  }

  /**
   * Formats the value from a partial override, merging with defaults
   * for any missing fields so `format` can read them.
   */
  formatPartial(
    override_: ProviderOverride,
    defaults: TokenSpeedConfig,
  ): string | undefined {
    return this.format(SettingsItem.mergePartial(defaults, override_));
  }

  /**
   * Validates and writes a new value from a partial override.
   * Merges with defaults before delegating to `setConfig`, then
   * returns only the changed field as a `Partial<ProviderOverride>`.
   */
  setConfigPartial(
    override_: ProviderOverride,
    defaults: TokenSpeedConfig,
    value: string,
  ): { valid: boolean; config?: Partial<ProviderOverride>; errors?: string[] } {
    const merged = SettingsItem.mergePartial(defaults, override_);
    const result = this.setConfig(merged, value);
    if (!result.valid) return result;
    // Extract only the field this item owns
    if (result.config) {
      const partial = {
        [this.id]: result.config[this.id as keyof typeof result.config],
      };
      return { valid: true, config: partial as Partial<ProviderOverride> };
    }
    return { valid: true };
  }
}
