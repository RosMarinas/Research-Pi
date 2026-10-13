import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  COLOR_BLAZING,
  COLOR_FAST,
  COLOR_MEDIUM,
  COLOR_SLOW,
} from "../settings/items/colors/color";
import { SettingsRegistry } from "../settings/items/scalar";
import {
  TPS_THRESHOLD_BLAZING,
  TPS_THRESHOLD_FAST,
  TPS_THRESHOLD_MEDIUM,
  TPS_THRESHOLD_SLOW,
} from "../settings/items/thresholds/threshold";
import { SettingsStorage, mergeConfig } from "./settings-storage";
import { SettingsValidator } from "./settings-validator";
import type {
  PartialConfig,
  ProviderOverrides,
  TokenSpeedConfig,
} from "./types";

/**
 * Manages TokenSpeed configuration: defaults, user settings, caching,
 * and persistence to ~/.pi/agent/settings.json.
 *
 * Composes a `SettingsStorage` for file I/O and a `SettingsValidator`
 * for config validation and provider override sanitization.
 */
class Settings {
  private cachedConfig: TokenSpeedConfig | null = null;
  private cachedErrors: string[] = [];

  /**
   * @internal Use the exported `settings` singleton instead.
   */
  constructor(
    private readonly storage: SettingsStorage,
    public readonly validator: SettingsValidator,
  ) {}

  /**
   * Retrieves the default configuration object.
   * Derives scalar defaults from registered `SettingsItem` instances —
   * one source of truth.
   *
   * @returns The default configuration.
   */
  getDefaultConfig(): TokenSpeedConfig {
    const scalars = Object.fromEntries(
      Object.values(SettingsRegistry.ITEMS).map((item) => [
        item.id,
        (item as any).getDefault(),
      ]),
    );
    return {
      thresholds: {
        slow: TPS_THRESHOLD_SLOW,
        medium: TPS_THRESHOLD_MEDIUM,
        fast: TPS_THRESHOLD_FAST,
        blazing: TPS_THRESHOLD_BLAZING,
      },
      colors: {
        slow: COLOR_SLOW,
        medium: COLOR_MEDIUM,
        fast: COLOR_FAST,
        blazing: COLOR_BLAZING,
      },
      displayColors: { count: "", elapsed: "", ttft: "" },
      providerOverrides: {},
      ...scalars,
    } as TokenSpeedConfig;
  }

  /**
   * Initializes the config by reading the settings file, merging with
   * defaults, and validating. Caches the result for subsequent reads.
   *
   * @returns The resolved and validated TokenSpeedConfig.
   */
  async initialize(): Promise<TokenSpeedConfig> {
    const defaults = this.getDefaultConfig();
    const raw = await this.storage.readTokenSpeedBlock();

    // Sanitize per-provider overrides: drop malformed entries and invalid
    // keys (collecting prefixed warnings), keeping valid blocks verbatim so
    // resolution via getEffectiveConfig() stays lazy.
    const { overrides: providerOverrides, errors: overrideErrors } =
      this.validator.sanitizeProviderOverrides(raw, defaults);

    const merged = mergeConfig(defaults, {
      ...raw,
      providerOverrides,
    }) as TokenSpeedConfig;

    const result = this.validator.validateConfig(merged);
    this.cachedConfig = result.config!;
    this.cachedErrors = [...(result.errors ?? []), ...overrideErrors];

    return this.cachedConfig;
  }

  /**
   * Returns the effective configuration for a provider: the base config
   * merged with the provider's override block when one exists.
   *
   * Merge semantics: top-level keys present in the override replace the
   * base value; `thresholds`/`colors` merge per-tier; omitted keys fall
   * back to base.
   *
   * @param providerId The pi ProviderId (e.g. "anthropic"), or undefined
   *   when no model is active — returns the base config.
   */
  getEffectiveConfig(providerId?: string): TokenSpeedConfig {
    const base = this.getConfig();
    if (!providerId) return base;

    const override = base.providerOverrides[providerId];
    if (!override) return base;

    return mergeConfig(base, override as PartialConfig) as TokenSpeedConfig;
  }

  /**
   * Replaces the whole `providerOverrides` map and updates the cache.
   * Used by the `/tps overrides` editor, whose add/delete semantics are
   * map-level rather than per-key.
   */
  async setProviderOverrides(next: ProviderOverrides): Promise<void> {
    await this.setConfig({ providerOverrides: next });
  }

  /**
   * Returns the cached configuration, or defaults if not yet initialized.
   */
  getConfig(): TokenSpeedConfig {
    return this.cachedConfig || this.getDefaultConfig();
  }

  /**
   * Returns validation errors from the last config resolution.
   * Only relevant at initialization time (e.g., to show warnings).
   */
  getErrors(): string[] {
    return this.cachedErrors;
  }

  /**
   * Resets the cached configuration and errors.
   *
   * Intended for test use — calling in production is harmless; the next
   * call to `initialize()` will re-read from disk.
   */
  reset(): void {
    this.cachedConfig = null;
    this.cachedErrors = [];
  }

  /**
   * Writes a partial TokenSpeedConfig and updates the cache.
   *
   * @param partial The partial config to merge and persist.
   */
  async setConfig(partial: PartialConfig): Promise<void> {
    await this.storage.writeTokenSpeedBlock(partial);
    const current = this.cachedConfig || this.getDefaultConfig();
    this.cachedConfig = mergeConfig(current, partial) as TokenSpeedConfig;
  }

  /**
   * Deletes keys from the persisted "tokenSpeed" block and refreshes the
   * cache by re-initializing from disk. Deleted keys fall back to their
   * defaults, so resets remove the keys instead of writing default values.
   *
   * @param keys The keys to delete (dotted keys delete a single tier
   *   from a nested group, e.g. "thresholds.slow").
   */
  async resetKeys(keys: string[]): Promise<void> {
    await this.storage.deleteTokenSpeedKeys(keys);
    await this.initialize();
  }
}

/**
 * Shared singleton instance used across the extension.
 */
export const settings = new Settings(
  new SettingsStorage(join(getAgentDir(), "settings.json")),
  new SettingsValidator(),
);
