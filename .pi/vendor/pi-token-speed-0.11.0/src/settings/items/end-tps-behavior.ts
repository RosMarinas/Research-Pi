import { ScalarSettingsItem } from "./scalar";

export type EndTpsBehavior = "average" | "last";

export const END_TPS_BEHAVIOR_DEFAULT: EndTpsBehavior = "average";

const END_TPS_BEHAVIOR_LABELS: Record<EndTpsBehavior, string> = {
  average: "Average (overall)",
  last: "Last (sliding window)",
};

/**
 * Enum setting: behavior for TPS display after streaming ends.
 */
export class EndTpsBehaviorSettingsItem extends ScalarSettingsItem<EndTpsBehavior> {
  constructor() {
    super({
      id: "endTpsBehavior",
      label: "End-of-stream TPS",
      description:
        "What to show after streaming: overall average or last sliding window value",
      default: END_TPS_BEHAVIOR_DEFAULT,
      labels: END_TPS_BEHAVIOR_LABELS,
    });
  }
}
