import type { SettingsItem } from "../../base";
import { ThresholdItem } from "./threshold";

/**
 * Per-tier threshold items.
 */
export const THRESHOLD_ITEMS: Record<string, SettingsItem> = {
  slow: new ThresholdItem("slow"),
  medium: new ThresholdItem("medium"),
  fast: new ThresholdItem("fast"),
  blazing: new ThresholdItem("blazing"),
};
