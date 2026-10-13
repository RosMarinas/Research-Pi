import { SettingsItem } from "../../base";
import { TIERS } from "../../options";

/**
 * Abstract base for per-tier setting items (thresholds and colors).
 *
 * Handles:
 * - `id` = `${prefix}.${tier}`
 * - `format()` — reads from the appropriate config field
 */
export abstract class TierSettingsItem extends SettingsItem {
  protected readonly prefix: string;
  protected readonly tier: (typeof TIERS)[number]["key"];

  readonly id: string;

  constructor(prefix: string, tier: (typeof TIERS)[number]["key"]) {
    super();
    this.prefix = prefix;
    this.tier = tier;
    this.id = `${prefix}.${tier}`;
  }
}
