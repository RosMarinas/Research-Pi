import { settings } from "../../config/settings";
import type {
  DisplayColorKey,
  ProviderOverride,
  TierName,
} from "../../config/types";
import { SETTINGS_ITEMS } from "../../settings/defaults";
import { TIERS } from "../../settings/options";
import { getGroupPrefix, isScalarField } from "../../settings/utils";
import { truecolor } from "../ansi";

/** Label shown for fields not set in the override block. */
export const BASE = "(base)";

/**
 * Computes the currentValue shown for a block field row.
 */
export function fieldValue(id: string, block: ProviderOverride): string {
  // Group ids ("thresholds", "colors", "displayColors") are registered in
  // SETTINGS_ITEMS as group entries whose format() is undefined; resolve
  // them (and their children) by prefix before the scalar lookup.
  const item = isScalarField(id) ? SETTINGS_ITEMS[id] : undefined;
  if (item) {
    return id in block
      ? (item.formatPartial(block, settings.getConfig()) ?? BASE)
      : BASE;
  }

  const group = getGroupPrefix(id);
  if (!group) return "";
  const suffix = id.slice(group.length);
  switch (group) {
    case "thresholds":
      if (suffix === "")
        return TIERS.map(
          (t) => block.thresholds?.[t.key]?.toString() ?? BASE,
        ).join(" | ");
      {
        const tier = suffix.slice(1) as TierName;
        return block.thresholds?.[tier]?.toString() ?? BASE;
      }
    case "colors":
      if (suffix === "") {
        const base = settings.getConfig();
        return TIERS.map((t) =>
          truecolor("■", block.colors?.[t.key] ?? base.colors[t.key]),
        ).join(" ");
      }
      {
        const tier = suffix.slice(1) as TierName;
        return block.colors?.[tier] ?? BASE;
      }
    case "displayColors":
      if (suffix === "") {
        const base = settings.getConfig();
        return (["count", "elapsed", "ttft"] as DisplayColorKey[])
          .map((key) =>
            truecolor(
              "■",
              block.displayColors?.[key] ?? base.displayColors[key],
            ),
          )
          .join(" ");
      }
      {
        const key = suffix.slice(1) as DisplayColorKey;
        return block.displayColors?.[key] ?? BASE;
      }
  }
  return "";
}
