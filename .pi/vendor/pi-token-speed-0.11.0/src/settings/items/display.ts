import { ScalarSettingsItem } from "./scalar";

export type DisplayMode = "tps" | "ttft" | "stats" | "full";

export const DISPLAY_MODE_DEFAULT: DisplayMode = "tps";

const DISPLAY_LABELS: Record<DisplayMode, string> = {
  tps: "TPS speed",
  ttft: "Time-to-first-token",
  stats: "Token stats",
  full: "Full details",
};

/**
 * Enum setting: display mode (tps / ttft / stats / full).
 *
 * Uses ScalarSettingsItem with `labels` for dropdown display.
 */
export class DisplaySettingsItem extends ScalarSettingsItem<DisplayMode> {
  constructor() {
    super({
      id: "display",
      label: "Display mode",
      description: "Level of detail to show in the status bar",
      default: DISPLAY_MODE_DEFAULT,
      labels: DISPLAY_LABELS,
    });
  }
}
