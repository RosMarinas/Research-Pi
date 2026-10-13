import { settings } from "../../config/settings";
import type {
  DisplayColorKey,
  ProviderOverride,
  Thresholds,
  TierName,
} from "../../config/types";
import { SETTINGS_ITEMS } from "../../settings/defaults";
import { isAscendingThresholds } from "../../settings/items/tiers/validation";
import { isScalarField } from "../../settings/utils";

/** Label shown for fields not set in the override block. */
const BASE = "(base)";

/**
 * Callback type for warning notifications.
 */
export type WarningCallback = (message: string) => void;

/**
 * Strategy interface for computing the next block after a field change.
 */
export interface BlockUpdater {
  /** Returns true if this updater handles the given field id. */
  appliesTo(id: string): boolean;

  /**
   * Computes the next block after a field change.
   * Returns null if the value is invalid (warning already notified by caller).
   * Empty input on input-dialog fields means "reset to base" (key removed).
   */
  compute(
    block: ProviderOverride,
    id: string,
    value: string,
    onWarning?: WarningCallback,
  ): ProviderOverride | null;
}

/**
 * Handles scalar fields that delegate to SettingsItem.
 */
export class ScalarBlockUpdater implements BlockUpdater {
  appliesTo(id: string): boolean {
    return SETTINGS_ITEMS[id] !== undefined && isScalarField(id);
  }

  compute(
    block: ProviderOverride,
    id: string,
    value: string,
  ): ProviderOverride | null {
    const next: ProviderOverride = { ...block };
    const base = settings.getConfig();
    const item = SETTINGS_ITEMS[id]!;

    if (value === BASE) {
      delete next[id as keyof ProviderOverride];
      return next;
    }
    const result = item.setConfigPartial(block, base, value);
    if (!result.valid) return null;
    if (result.config) Object.assign(next, result.config);
    return next;
  }
}

/**
 * Handles threshold fields (e.g. "thresholds.slow").
 */
export class ThresholdBlockUpdater implements BlockUpdater {
  appliesTo(id: string): boolean {
    return id.startsWith("thresholds.");
  }

  compute(
    block: ProviderOverride,
    id: string,
    value: string,
    onWarning?: WarningCallback,
  ): ProviderOverride | null {
    const next: ProviderOverride = { ...block };
    const base = settings.getConfig();
    const tier = id.slice("thresholds.".length) as TierName;
    const thresholds: Partial<Thresholds> = { ...(block.thresholds ?? {}) };

    if (value === "") {
      delete thresholds[tier];
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return null;
      thresholds[tier] = n;
    }

    if (Object.keys(thresholds).length > 0) {
      const merged = { ...base.thresholds, ...thresholds };
      if (!isAscendingThresholds(merged)) {
        onWarning?.("[pi-token-speed] Thresholds must be in ascending order.");
        return null;
      }
      next.thresholds = thresholds;
    } else {
      delete next.thresholds;
    }
    return next;
  }
}

/**
 * Handles color fields (e.g. "colors.slow").
 */
export class ColorBlockUpdater implements BlockUpdater {
  appliesTo(id: string): boolean {
    return id.startsWith("colors.");
  }

  compute(
    block: ProviderOverride,
    id: string,
    value: string,
  ): ProviderOverride | null {
    const next: ProviderOverride = { ...block };
    const tier = id.slice("colors.".length) as TierName;
    const colors = { ...(block.colors ?? {}) };

    if (value === "") {
      delete colors[tier];
    } else {
      colors[tier] = value.toLowerCase();
    }

    if (Object.keys(colors).length > 0) {
      next.colors = colors;
    } else {
      delete next.colors;
    }
    return next;
  }
}

/**
 * Handles display color fields (e.g. "displayColors.count").
 */
export class DisplayColorBlockUpdater implements BlockUpdater {
  appliesTo(id: string): boolean {
    return id.startsWith("displayColors.");
  }

  compute(
    block: ProviderOverride,
    id: string,
    value: string,
  ): ProviderOverride | null {
    const next: ProviderOverride = { ...block };
    const key = id.slice("displayColors.".length) as DisplayColorKey;
    const displayColors = { ...(block.displayColors ?? {}) };

    if (value === "") {
      delete displayColors[key];
    } else {
      displayColors[key] = value.toLowerCase();
    }

    if (Object.keys(displayColors).length > 0) {
      next.displayColors = displayColors;
    } else {
      delete next.displayColors;
    }
    return next;
  }
}

/**
 * Dispatches field updates to the appropriate BlockUpdater.
 *
 * @param block Current override block
 * @param id Field identifier
 * @param value New value
 * @param onWarning Optional warning callback
 * @returns Updated block, or null if invalid
 */
export function computeNextBlock(
  block: ProviderOverride,
  id: string,
  value: string,
  onWarning?: WarningCallback,
): ProviderOverride | null {
  const updaters: BlockUpdater[] = [
    new ScalarBlockUpdater(),
    new ThresholdBlockUpdater(),
    new ColorBlockUpdater(),
    new DisplayColorBlockUpdater(),
  ];

  for (const updater of updaters) {
    if (updater.appliesTo(id)) {
      return updater.compute(block, id, value, onWarning);
    }
  }

  return null;
}
