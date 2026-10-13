import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingItem,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import { settings } from "../../config/settings";
import type {
  Colors,
  DisplayColors,
  ProviderOverride,
  ProviderOverrides,
  Thresholds,
} from "../../config/types";
import { DISPLAY_COLOR_LABELS } from "../../settings/items/display-colors/color";
import { isScalarField } from "../../settings/utils";
import { truecolor } from "../../ui/ansi";
import { OverrideTierSubmenuBuilder } from "../../ui/color-picker";
import { computeNextBlock } from "../../ui/editor/block-updaters";
import { BASE, fieldValue } from "../../ui/editor/utils";
import { SETTINGS_ITEMS } from "../defaults";
import { TIERS } from "../options";
import { AbstractSettingsMenu } from "./abstract-settings-menu";
import { SettingsListRefresher } from "./settings-list-refresher";

/**
 * Options for the per-provider override menu.
 */
export interface ProviderOverrideMenuOptions {
  /** The provider whose overrides are being edited. */
  providerId: string;
  /** The shared overrides map (mutated in place on commit). */
  overrides: ProviderOverrides;
  /** Persists the full overrides map. */
  persist: (next: ProviderOverrides) => Promise<void>;
  /** Sink for validation warnings (e.g. `ctx.ui.notify`). */
  onWarning: (message: string) => void;
  /** Optional callback after a committed change (e.g. summary refresh). */
  onBlockChanged?: () => void;
}

/**
 * Per-provider override menu — relative values with base fallback.
 *
 * Mirrors `SettingsMenu` item building, but reads values from the
 * provider's override block (falling back to the base config) and
 * commits by removing/setting keys in the block. Non-overridden fields
 * display the `(base)` marker.
 */
export class ProviderOverrideMenu extends AbstractSettingsMenu {
  private refresher: SettingsListRefresher;

  constructor(private readonly opts: ProviderOverrideMenuOptions) {
    super();
    this.refresher = new SettingsListRefresher(this, this);
  }

  /**
   * Returns the current override block for this provider.
   */
  private block(): ProviderOverride {
    return this.opts.overrides[this.opts.providerId] ?? {};
  }

  getThresholds(): Thresholds {
    const block = this.block();
    const base = settings.getConfig();
    return {
      slow: block.thresholds?.slow ?? base.thresholds.slow,
      medium: block.thresholds?.medium ?? base.thresholds.medium,
      fast: block.thresholds?.fast ?? base.thresholds.fast,
      blazing: block.thresholds?.blazing ?? base.thresholds.blazing,
    };
  }

  getColors(): Colors {
    const block = this.block();
    const base = settings.getConfig();
    return {
      slow: block.colors?.slow ?? base.colors.slow,
      medium: block.colors?.medium ?? base.colors.medium,
      fast: block.colors?.fast ?? base.colors.fast,
      blazing: block.colors?.blazing ?? base.colors.blazing,
    };
  }

  getDisplayColors(): DisplayColors {
    const block = this.block();
    const base = settings.getConfig();
    return {
      count: block.displayColors?.count ?? base.displayColors.count,
      elapsed: block.displayColors?.elapsed ?? base.displayColors.elapsed,
      ttft: block.displayColors?.ttft ?? base.displayColors.ttft,
    };
  }

  /**
   * Creates the override settings list UI for this provider.
   *
   * @param tui The TUI instance.
   * @param theme The active theme.
   * @param _keybindings Unused (no keybindings needed).
   * @param done Callback when the menu is closed.
   * @returns A SettingsList to display.
   */
  create(
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    done: (value?: string) => void,
  ): SettingsList {
    const block = this.block();
    const items = this.buildItems(block, theme, tui);
    this.settingsList = this.createMainSettingsList(
      items,
      Math.min(items.length + 2, 15),
      (id, value) => void this.handleSettingChange(id, value),
      () => done(undefined),
      (id) => void this.resetSetting(id),
      tui,
    );
    return this.settingsList;
  }

  // ── Commit / reset hooks ──────────────────────────────────────────────

  /**
   * Computes the next override block and persists it.
   *
   * @param id The setting identifier.
   * @param value The new value (`""`/`BASE` removes the key → base).
   * @returns Whether the change was committed.
   */
  protected override async commit(id: string, value: string): Promise<boolean> {
    const nextBlock = computeNextBlock(
      this.block(),
      id,
      value,
      this.opts.onWarning,
    );
    if (nextBlock === null) return false;
    return this.persistBlock(nextBlock);
  }

  /**
   * Resets a single field by removing it from the override block so it
   * falls back to the base config value.
   *
   * @param id The setting identifier.
   */
  protected override async resetScalar(id: string): Promise<void> {
    const value = isScalarField(id) ? BASE : "";
    await this.commit(id, value);
  }

  /**
   * Resets a grouped setting by removing the entire group key from the
   * override block.
   *
   * @param id The group identifier ("thresholds", "colors", or "displayColors").
   */
  protected override async resetGroup(id: string): Promise<void> {
    const current = this.block();
    if (current[id as keyof ProviderOverride] === undefined) return;
    const nextBlock = { ...current };
    delete nextBlock[id as keyof ProviderOverride];
    await this.persistBlock(nextBlock);
  }

  /**
   * Persists the given block for this provider and syncs the shared
   * overrides map in place so all holders see fresh data.
   *
   * @param nextBlock The next override block.
   * @returns Whether the persistence succeeded.
   */
  private async persistBlock(nextBlock: ProviderOverride): Promise<boolean> {
    const next: ProviderOverrides = {
      ...this.opts.overrides,
      [this.opts.providerId]: nextBlock,
    };
    try {
      await this.opts.persist(next);
    } catch {
      return false;
    }
    this.syncOverrides(next);
    return true;
  }

  /**
   * Replaces the shared overrides map's contents in place.
   *
   * @param next The next overrides map.
   */
  private syncOverrides(next: ProviderOverrides): void {
    for (const key of Object.keys(this.opts.overrides)) {
      delete this.opts.overrides[key];
    }
    Object.assign(this.opts.overrides, next);
  }

  // ── Post-change refresh ───────────────────────────────────────────────

  /**
   * Refreshes all rows and notifies the block-changed callback.
   *
   * @param id The setting identifier that changed.
   */
  protected override afterChange(id: string): void {
    this.refreshScalarRows();
    this.opts.onBlockChanged?.();
    super.afterChange(id);
  }

  /**
   * Refreshes all rows and notifies the block-changed callback.
   *
   * @param id The setting identifier that was reset.
   */
  protected override afterReset(id: string): void {
    this.refreshScalarRows();
    this.opts.onBlockChanged?.();
    super.afterReset(id);
  }

  /**
   * Updates scalar row values from the current override block.
   */
  private refreshScalarRows(): void {
    const block = this.block();
    if (!this.settingsList) return;
    for (const item of Object.values(SETTINGS_ITEMS)) {
      if (!isScalarField(item.id)) continue;
      this.settingsList.updateValue(item.id, fieldValue(item.id, block));
    }
  }

  /**
   * Refreshes threshold rows: the group row, the stored submenu items,
   * and the active submenu list (if open).
   */
  override refreshThresholdItems(): void {
    const block = this.block();
    this.settingsList?.updateValue(
      "thresholds",
      fieldValue("thresholds", block),
    );

    this.refresher.refreshThresholds();
  }

  /**
   * Refreshes color rows: the group row, the stored submenu items
   * (labels included), and the active submenu list (if open).
   */
  override refreshColorItems(): void {
    const block = this.block();
    const base = settings.getConfig();
    this.settingsList?.updateValue("colors", fieldValue("colors", block));

    // Update color submenu items (skip if threshold submenu is open)
    if (!this.thresholdSubmenuItems && this.colorSubmenuItems) {
      for (const { key, label } of TIERS) {
        const item = this.colorSubmenuItems.find(
          (i) => i.id === `colors.${key}`,
        );
        if (item) {
          const hex = block.colors?.[key] ?? base.colors[key];
          item.label = `${truecolor("■", hex)} ${label}`;
          item.currentValue = block.colors?.[key] ?? BASE;
        }
      }
    }

    this.refresher.refreshColors();
  }

  /**
   * Refreshes display color rows: the group row, the stored submenu items
   * (labels included), and the active submenu list (if open).
   */
  override refreshDisplayColorItems(): void {
    const block = this.block();
    const base = settings.getConfig();
    this.settingsList?.updateValue(
      "displayColors",
      fieldValue("displayColors", block),
    );

    // Update display color submenu items (skip if threshold/colors submenu is open)
    if (
      !this.thresholdSubmenuItems &&
      !this.colorSubmenuItems &&
      this.displayColorSubmenuItems
    ) {
      for (const key of ["count", "elapsed", "ttft"] as const) {
        const item = this.displayColorSubmenuItems.find(
          (i) => i.id === `displayColors.${key}`,
        );
        if (item) {
          const hex = block.displayColors?.[key] ?? base.displayColors[key];
          item.label = `${truecolor("■", hex)} ${DISPLAY_COLOR_LABELS[key]}`;
          item.currentValue = block.displayColors?.[key] ?? BASE;
        }
      }
    }

    this.refresher.refreshDisplayColors();
  }

  // ── Item building ─────────────────────────────────────────────────────

  /**
   * Builds the full list of SettingItems for this provider's overrides.
   *
   * @param block The current override block.
   * @param theme The active theme.
   * @param tui The TUI instance.
   * @returns An array of SettingItems.
   */
  private buildItems(
    block: ProviderOverride,
    theme: Theme,
    tui: TUI,
  ): SettingItem[] {
    const base = settings.getConfig();
    const items: SettingItem[] = [];

    // Scalar settings (excludes grouped thresholds/colors)
    for (const item of Object.values(SETTINGS_ITEMS)) {
      if (!isScalarField(item.id)) continue;
      const hasField = item.id in block;
      items.push({
        id: item.id,
        label: item.label,
        description: `Base: ${item.formatPartial({}, base)}`,
        currentValue: hasField
          ? (item.formatPartial(block, base) ?? BASE)
          : BASE,
        values: [BASE, ...(item.values ?? [])],
      });
    }

    // Group items — Thresholds and Colors
    const thresholdsItem = SETTINGS_ITEMS["thresholds"];
    if (thresholdsItem) {
      items.push({
        id: "thresholds",
        label: thresholdsItem.label,
        description:
          "Customize TPS threshold overrides (slow, medium, fast, blazing)",
        currentValue: fieldValue("thresholds", block),
        submenu: (
          _currentValue: string,
          submenuDone: (value?: string) => void,
        ) =>
          this.openTierSubmenu(
            new OverrideTierSubmenuBuilder(theme, tui, base, () =>
              this.block(),
            ).buildThresholds(),
            submenuDone,
            tui,
          ),
      });
    }

    const colorsItem = SETTINGS_ITEMS["colors"];
    if (colorsItem) {
      items.push({
        id: "colors",
        label: colorsItem.label,
        description:
          "Customize tier color overrides (slow, medium, fast, blazing)",
        currentValue: fieldValue("colors", block),
        submenu: (
          _currentValue: string,
          submenuDone: (value?: string) => void,
        ) =>
          this.openTierSubmenu(
            new OverrideTierSubmenuBuilder(theme, tui, base, () =>
              this.block(),
            ).buildColors(),
            submenuDone,
            tui,
          ),
      });
    }

    const displayColorsItem = SETTINGS_ITEMS["displayColors"];
    if (displayColorsItem) {
      items.push({
        id: "displayColors",
        label: displayColorsItem.label,
        description: "Customize suffix color overrides (count, elapsed, ttft)",
        currentValue: fieldValue("displayColors", block),
        submenu: (
          _currentValue: string,
          submenuDone: (value?: string) => void,
        ) =>
          this.openTierSubmenu(
            new OverrideTierSubmenuBuilder(theme, tui, base, () =>
              this.block(),
            ).buildDisplayColors(),
            submenuDone,
            tui,
          ),
      });
    }

    return items;
  }

  /**
   * Wraps tier submenu items in a resettable submenu list.
   *
   * @param submenuItems The tier items to display.
   * @param submenuDone Callback when the submenu is closed.
   * @param tui The TUI instance.
   * @returns A SettingsList for the submenu.
   */
  private openTierSubmenu(
    submenuItems: SettingItem[],
    submenuDone: (value?: string) => void,
    tui: TUI,
  ): SettingsList {
    return this.createSubmenuList(
      submenuItems,
      Math.min(submenuItems.length + 2, 15),
      (id, value) => void this.handleSettingChange(id, value),
      () => submenuDone(undefined),
      (id) => void this.resetSetting(id),
      tui,
    );
  }
}
