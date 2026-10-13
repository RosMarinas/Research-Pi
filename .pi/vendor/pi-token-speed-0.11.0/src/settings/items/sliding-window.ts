import { MAX_SLIDING_WINDOW, MIN_SLIDING_WINDOW } from "../../config/constants";
import { ScalarSettingsItem } from "./scalar";

export const SLIDING_WINDOW_DEFAULT = 1000;

const SLIDING_WINDOW_LABELS: Record<number, string> = {
  500: "500 ms (fast/reactive)",
  1000: "1000 ms (default)",
  3000: "3000 ms (medium)",
  5000: "5000 ms (slow)",
  10000: "10000 ms (very slow)",
  15000: "15000 ms (extreme)",
  30000: "30000 ms (max)",
};

/**
 * Numeric setting with range validation and preset labels.
 */
export class SlidingWindowSettingsItem extends ScalarSettingsItem<number> {
  constructor() {
    super({
      id: "slidingWindow",
      label: "Sliding window",
      description:
        "Time window for TPS calculation. Larger = smoother, smaller = more reactive.",
      default: SLIDING_WINDOW_DEFAULT,
      labels: SLIDING_WINDOW_LABELS,
      min: MIN_SLIDING_WINDOW,
      max: MAX_SLIDING_WINDOW,
    });
  }
}
