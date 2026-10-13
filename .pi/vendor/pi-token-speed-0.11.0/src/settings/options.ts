import type { TierName } from "../config/types";

/**
 * Tier metadata (key + label) shared by the threshold and color groups.
 */
export const TIERS: { key: TierName; label: string }[] = [
  { key: "slow", label: "Slow" },
  { key: "medium", label: "Medium" },
  { key: "fast", label: "Fast" },
  { key: "blazing", label: "Blazing" },
];

/**
 * Inverts a label map, swapping keys and values.
 *
 * E.g., `{ tps: "TPS speed" }` → `{ "TPS speed": "tps" }`.
 * Used to convert the user-facing label shown in a SettingsList back to
 * the config value when a setting is changed.
 */
export const invertLabels = <K extends string>(
  obj: Record<K, string>,
): Record<string, K> => {
  const result = {} as Record<string, K>;
  for (const key in obj) {
    result[obj[key]] = key;
  }
  return result;
};
