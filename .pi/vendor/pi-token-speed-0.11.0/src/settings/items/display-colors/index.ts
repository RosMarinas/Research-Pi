import { DisplayColorSettingsItem } from "./color";

/**
 * Per-key display color items.
 */
export const DISPLAY_COLOR_ITEMS: Record<string, DisplayColorSettingsItem> = {
  count: new DisplayColorSettingsItem("count"),
  elapsed: new DisplayColorSettingsItem("elapsed"),
  ttft: new DisplayColorSettingsItem("ttft"),
};
