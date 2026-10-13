import { ScalarSettingsItem } from "./scalar";

export type CountStrategy = "estimate" | "direct";

export const COUNT_STRATEGY_DEFAULT: CountStrategy = "direct";

const COUNT_STRATEGY_LABELS: Record<CountStrategy, string> = {
  estimate: "Estimate (calculated)",
  direct: "Direct (accurate)",
};

/**
 * Enum setting: how to count tokens during streaming.
 */
export class CountStrategySettingsItem extends ScalarSettingsItem<CountStrategy> {
  constructor() {
    super({
      id: "countStrategy",
      label: "Count strategy",
      description:
        "Direct counting (server streams tokens) vs estimate counting (server streams chunks)",
      default: COUNT_STRATEGY_DEFAULT,
      labels: COUNT_STRATEGY_LABELS,
    });
  }
}
