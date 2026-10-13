import { type CountStrategy } from "../settings/items/count-strategy";
import { type DisplayMode } from "../settings/items/display";
import { type EndTpsBehavior } from "../settings/items/end-tps-behavior";

/**
 * Status bar suffix parts that can be colorized.
 */
export type DisplayColorKey = "count" | "elapsed" | "ttft";

/**
 * Hex color (`#RRGGBB`) for each colorizable suffix part.
 */
export interface DisplayColors extends Record<DisplayColorKey, string> {}

/**
 * TPS tier names, shared by the threshold and color groups.
 */
export type TierName = "slow" | "medium" | "fast" | "blazing";

/**
 * TPS tiers as an interface
 */
interface Tiers<T> {
  slow: T;
  medium: T;
  fast: T;
  blazing: T;
}

/**
 * TPS threshold (tok/s) at or above which a tier applies.
 */
export interface Thresholds extends Tiers<number> {}

/**
 * Hex color (`#RRGGBB`) used for each TPS tier.
 */
export interface Colors extends Tiers<string> {}

/**
 * Core configuration fields (everything except `providerOverrides`).
 * Kept separate so provider override blocks can be a simple partial of
 * this shape without recursive type references.
 */
interface TokenSpeedConfigFields {
  display: DisplayMode;
  slidingWindow: number;
  useProviderTokens: boolean;
  countStrategy: CountStrategy;
  endTpsBehavior: EndTpsBehavior;
  icon: string;
  updateInterval: number; // ms, 0 = update on every delta
  formatDuration: boolean;
  thresholds: Thresholds;
  colors: Colors;
  displayColors: DisplayColors;
}

/**
 * Partial config that may override any top-level base key.
 * Omitted keys fall back to the base config at resolution time;
 * `thresholds`/`colors`/`displayColors` merge per-key.
 */
export type ProviderOverride = Partial<
  Omit<TokenSpeedConfigFields, "thresholds" | "colors" | "displayColors">
> & {
  thresholds?: Partial<Thresholds>;
  colors?: Partial<Colors>;
  displayColors?: Partial<DisplayColors>;
  formatDuration?: boolean;
};

/**
 * Maps a pi ProviderId (e.g. "anthropic", "openai") to a partial config
 * applied whenever the active model's provider matches.
 */
export interface ProviderOverrides {
  [providerId: string]: ProviderOverride;
}

/**
 * Configuration for the token-speed extension.
 * All fields can be overridden via ~/.pi/agent/settings.json under the "tokenSpeed" key.
 * All keys are optional — defaults are applied at merge time.
 */
export interface TokenSpeedConfig extends TokenSpeedConfigFields {
  /** Per-provider config overrides, keyed by pi ProviderId. */
  providerOverrides: ProviderOverrides;
}

/**
 * Partial config where the nested groups may also be partially specified.
 * Used for merging user settings over defaults without wiping sibling tiers.
 */
export type PartialConfig = Partial<
  Omit<TokenSpeedConfigFields, "thresholds" | "colors" | "displayColors">
> & {
  thresholds?: Partial<Thresholds>;
  colors?: Partial<Colors>;
  displayColors?: Partial<DisplayColors>;
  formatDuration?: boolean;
  providerOverrides?: ProviderOverrides;
};
