import type { TokenSpeedConfig } from "../../config/types";
import {
  SettingsItem,
  ValidationResult,
  type ValidationCheckResult,
} from "../base";
import { invertLabels } from "../options";

/**
 * Options for a scalar setting (enum, numeric, boolean, string).
 */
interface ScalarOptions<T> {
  id: keyof TokenSpeedConfig & string;
  label: string;
  description: string;
  default: T;
  /** Enum label map: config value → display label */
  labels?: Record<string, string>;
  /** Numeric range */
  min?: number;
  max?: number;
  /** Boolean toggle labels: [on, off] */
  toggle?: [string, string];
}

/**
 * Shared registry populated by ScalarSettingsItem constructors.
 * Auto-registration eliminates manual registry entries.
 */
export const SettingsRegistry = {
  ITEMS: {} as Record<string, ScalarSettingsItem<unknown>>,
};

/**
 * Base class for scalar settings. Handles the four abstract methods
 * with sensible defaults based on the options:
 *
 * - **Enum** (`labels`): format → label lookup, setConfig → invert map
 * - **Numeric** (number default): format → String, setConfig → Number, validate → range check
 * - **Boolean** (`toggle`): format → "On"/"Off", setConfig → value === onLabel
 * - **String** (fallback): format → String, setConfig → passthrough
 *
 * Auto-registers itself in `SettingsRegistry.ITEMS` at construction time.
 * Subclasses override any method for custom logic (e.g. icon normalization).
 */
export abstract class ScalarSettingsItem<T> extends SettingsItem {
  readonly options: ScalarOptions<T>;
  readonly values: string[] | undefined;

  constructor(options: ScalarOptions<T>) {
    super();
    this.options = options;
    this.values = options.labels
      ? Object.values(options.labels)
      : options.toggle
        ? [...options.toggle]
        : undefined;
    SettingsRegistry.ITEMS[this.options.id] =
      this as unknown as ScalarSettingsItem<unknown>;
  }

  /**
   * The setting identifier (e.g. "display", "updateInterval").
   *
   * @returns The setting identifier.
   */
  get id(): keyof TokenSpeedConfig & string {
    return this.options.id;
  }

  /**
   * The display label for this setting.
   *
   * @returns The display label.
   */
  get label(): string {
    return this.options.label;
  }

  /**
   * The description text for this setting.
   *
   * @returns The description text.
   */
  get description(): string {
    return this.options.description;
  }

  /**
   * @returns The default value for this setting.
   */
  getDefault(): T {
    return this.options.default;
  }

  /**
   * Formats the current config value for display.
   *
   * @param config The current TokenSpeedConfig.
   * @returns The formatted display string, or undefined if unset.
   */
  format(config: TokenSpeedConfig): string | undefined {
    const value = config[this.options.id];
    if (this.options.labels) {
      return this.options.labels[String(value)] ?? String(value);
    }
    if (this.options.toggle && typeof value === "boolean") {
      return value ? this.options.toggle[0] : this.options.toggle[1];
    }
    return String(value);
  }

  /**
   * Parses a display value string back into a config update.
   *
   * @param _config The current TokenSpeedConfig (unused).
   * @param value The display-value string from the user.
   * @returns A ValidationResult with the config patch.
   */
  setConfig(_config: TokenSpeedConfig, value: string): ValidationResult {
    if (this.options.labels) {
      const inverted = invertLabels(this.options.labels);
      const parsed = inverted[value] as string | undefined;
      if (parsed === undefined) {
        return { valid: false, errors: [`Invalid ${this.id}: "${value}"`] };
      }
      const finalValue =
        typeof this.options.default === "number"
          ? Number(parsed)
          : (parsed as T);
      return {
        valid: true,
        config: { [this.options.id]: finalValue } as Partial<TokenSpeedConfig>,
      };
    }
    if (this.options.toggle) {
      return {
        valid: true,
        config: {
          [this.options.id]: value === this.options.toggle[0],
        } as Partial<TokenSpeedConfig>,
      };
    }
    if (typeof this.options.default === "number") {
      return {
        valid: true,
        config: {
          [this.options.id]: Number(value),
        } as Partial<TokenSpeedConfig>,
      };
    }
    return {
      valid: true,
      config: { [this.options.id]: value as T } as Partial<TokenSpeedConfig>,
    };
  }

  /**
   * Validates a raw value and returns a corrected version if invalid.
   *
   * @param value The value to validate.
   * @returns A ValidationCheckResult with validity, corrections, and errors.
   */
  validate(value: unknown): ValidationCheckResult {
    // Numeric settings use range validation regardless of labels
    // (labels are for display only, not for validation).
    if (typeof this.options.default === "number") {
      const num =
        typeof value === "number" ? value : value == null ? NaN : Number(value);
      const valid =
        !isNaN(num) &&
        (!this.options.min || num >= this.options.min) &&
        (!this.options.max || num <= this.options.max);
      if (valid) return { valid: true, corrected: num };
      return {
        valid: false,
        corrected: this.options.default,
        errors: [
          `Invalid ${this.id} "${value}" — defaulting to ${this.options.default}.`,
        ],
      };
    }
    if (this.options.labels) {
      const valid = Object.keys(this.options.labels).includes(String(value));
      if (valid) return { valid: true, corrected: value as T };
      return {
        valid: false,
        corrected: this.options.default,
        errors: [
          `Invalid ${this.id} "${value}" — defaulting to ${this.options.default}.`,
        ],
      };
    }
    if (this.options.toggle) {
      const valid = typeof value === "boolean";
      if (valid) return { valid: true, corrected: value };
      return {
        valid: false,
        corrected: this.options.default,
        errors: [
          `Invalid ${this.id} (expected boolean) — defaulting to ${this.options.default}.`,
        ],
      };
    }
    // String: type check
    const valid = typeof value === typeof this.options.default;
    if (valid) return { valid: true, corrected: value as T };
    return {
      valid: false,
      corrected: this.options.default,
      errors: [
        `Invalid ${this.id} (expected ${typeof this.options.default}) — defaulting to ${this.options.default}.`,
      ],
    };
  }
}
