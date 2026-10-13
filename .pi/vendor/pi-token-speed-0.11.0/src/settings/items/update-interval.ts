import { ScalarSettingsItem } from "./scalar";

export const UPDATE_INTERVAL_DEFAULT = 0;

const UPDATE_INTERVAL_LABELS: Record<number, string> = {
  0: "Every delta (default)",
  50: "50 ms",
  100: "100 ms",
  200: "200 ms",
  500: "500 ms",
};

/**
 * Numeric setting with preset labels: status bar update interval in ms.
 *
 * Uses ScalarSettingsItem with `labels` for the dropdown and numeric
 * default for range validation. Format falls through to String(value).
 */
export class UpdateIntervalSettingsItem extends ScalarSettingsItem<number> {
  constructor() {
    super({
      id: "updateInterval",
      label: "Status update interval",
      description:
        "How often to update the status bar. 0 = every delta (current behavior).",
      default: UPDATE_INTERVAL_DEFAULT,
      labels: UPDATE_INTERVAL_LABELS,
      min: 0,
    });
  }
}
