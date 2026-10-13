import { ScalarSettingsItem } from "./scalar";

export const FORMAT_DURATION_DEFAULT = false;

/**
 * Scalar settings item for the `formatDuration` toggle.
 */
export class FormatDurationSettingsItem extends ScalarSettingsItem<boolean> {
  constructor() {
    super({
      id: "formatDuration",
      label: "Format duration",
      description:
        "Show elapsed time in human-readable units (days, hours, minutes, seconds) instead of raw seconds",
      default: false,
      toggle: ["On", "Off"],
    });
  }
}
