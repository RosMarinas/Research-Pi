import type { SettingItem } from "@earendil-works/pi-tui";
import type { Colors, DisplayColors, Thresholds } from "../../config/types";
import { truecolor } from "../../ui/ansi";
import { DISPLAY_COLOR_LABELS } from "../items/display-colors/color";
import { TIERS } from "../options";
import type { AbstractSettingsMenu } from "./abstract-settings-menu";

/**
 * Source of threshold and color values for a settings menu.
 */
export interface ValueSource {
  getThresholds(): Thresholds;
  getColors(): Colors;
  getDisplayColors(): DisplayColors;
}

/**
 * Generic refresher for threshold and color rows across the main list,
 * stored submenu items, and the active submenu (if open).
 *
 * Used by both `SettingsMenu` and `ProviderOverrideMenu` to avoid
 * duplicating refresh logic. Reads list state from the parent
 * `AbstractSettingsMenu` subclass.
 */
export class SettingsListRefresher {
  constructor(
    private readonly source: ValueSource,
    private readonly menu: AbstractSettingsMenu,
  ) {}

  /**
   * Refreshes tier-level threshold items in the stored submenu
   * and the active submenu (if thresholds is open).
   *
   * Does NOT update the group row — callers should update that themselves.
   */
  refreshThresholds(): void {
    const thresholds = this.source.getThresholds();

    if (this.menu.thresholdSubmenuItems) {
      for (const { key } of TIERS) {
        const item = this.menu.thresholdSubmenuItems.find(
          (i) => i.id === `thresholds.${key}`,
        );
        if (item) {
          item.currentValue = thresholds[key].toString();
        }
      }
    }

    if (this.menu.activeSubmenuList) {
      for (const { key } of TIERS) {
        this.menu.activeSubmenuList.updateValue(
          `thresholds.${key}`,
          thresholds[key].toString(),
        );
      }
      this.menu.activeSubmenuList.invalidate();
    }
  }

  /**
   * Refreshes tier-level color items in the stored submenu
   * and the active submenu (if colors is open).
   *
   * Does NOT update the group row — callers should update that themselves.
   */
  refreshColors(): void {
    const colors = this.source.getColors();

    if (this.menu.colorSubmenuItems) {
      for (const { key, label } of TIERS) {
        const item = this.menu.colorSubmenuItems.find(
          (i) => i.id === `colors.${key}`,
        );
        if (item) {
          item.label = `${truecolor("■", colors[key])} ${label}`;
        }
      }
    }

    if (this.menu.activeSubmenuList) {
      for (const { key, label } of TIERS) {
        this.menu.activeSubmenuList.updateValue(`colors.${key}`, colors[key]);
        const internalItems = (
          this.menu.activeSubmenuList as unknown as { items: SettingItem[] }
        ).items;
        if (internalItems) {
          const item = internalItems.find(
            (i: SettingItem) => i.id === `colors.${key}`,
          );
          if (item) {
            item.label = `${truecolor("■", colors[key])} ${label}`;
          }
        }
      }
      this.menu.activeSubmenuList.invalidate();
    }
  }

  /**
   * Refreshes display color items in the stored submenu
   * and the active submenu (if displayColors is open).
   *
   * Does NOT update the group row — callers should update that themselves.
   */
  refreshDisplayColors(): void {
    const displayColors = this.source.getDisplayColors();

    if (this.menu.displayColorSubmenuItems) {
      for (const key of ["count", "elapsed", "ttft"] as const) {
        const item = this.menu.displayColorSubmenuItems.find(
          (i) => i.id === `displayColors.${key}`,
        );
        if (item) {
          item.label = `${truecolor("■", displayColors[key])} ${
            DISPLAY_COLOR_LABELS[key]
          }`;
          item.currentValue = displayColors[key] || "(none)";
        }
      }
    }

    if (this.menu.activeSubmenuList) {
      for (const key of ["count", "elapsed", "ttft"] as const) {
        this.menu.activeSubmenuList.updateValue(
          `displayColors.${key}`,
          displayColors[key] || "(none)",
        );
        const internalItems = (
          this.menu.activeSubmenuList as unknown as { items: SettingItem[] }
        ).items;
        if (internalItems) {
          const item = internalItems.find(
            (i: SettingItem) => i.id === `displayColors.${key}`,
          );
          if (item) {
            item.label = `${truecolor("■", displayColors[key])} ${
              DISPLAY_COLOR_LABELS[key]
            }`;
            item.currentValue = displayColors[key] || "(none)";
          }
        }
      }
      this.menu.activeSubmenuList.invalidate();
    }
  }
}
