import { ScalarSettingsItem } from "./scalar";

export const USE_PROVIDER_TOKENS_DEFAULT = false;

/**
 * Boolean toggle: use the provider's token count vs the extension's counter.
 *
 * Uses ScalarSettingsItem with `toggle` for On/Off display labels.
 */
export class UseProviderTokensSettingsItem extends ScalarSettingsItem<boolean> {
  constructor() {
    super({
      id: "useProviderTokens",
      label: "Use provider tokens",
      description:
        "Use the provider's token count instead of this extension's counter",
      default: USE_PROVIDER_TOKENS_DEFAULT,
      toggle: ["On", "Off"],
    });
  }
}
