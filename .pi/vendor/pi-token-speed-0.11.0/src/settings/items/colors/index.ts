import type { SettingsItem } from "../../base";
import { ColorItem } from "./color";

/**
 * Per-tier color items.
 */
export const COLOR_ITEMS: Record<string, SettingsItem> = {
  slow: new ColorItem("slow"),
  medium: new ColorItem("medium"),
  fast: new ColorItem("fast"),
  blazing: new ColorItem("blazing"),
};
