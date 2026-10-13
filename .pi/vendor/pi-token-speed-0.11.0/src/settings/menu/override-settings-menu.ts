import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  KeybindingsManager,
  SettingItem,
  SettingsList,
  TUI,
} from "@earendil-works/pi-tui";
import { settings } from "../../config/settings";
import type { ProviderOverride, ProviderOverrides } from "../../config/types";
import { ConfirmDialog } from "../../ui/dialog/confirm-dialog";
import { InputDialog } from "../../ui/dialog/input-dialog";
import type { ResettableSettingsList } from "../../ui/resettable-settings-list";
import { SETTINGS_ITEMS } from "../defaults";
import { TIERS } from "../options";
import { isScalarField } from "../utils";
import { AbstractSettingsMenu } from "./abstract-settings-menu";
import { ProviderOverrideMenu } from "./provider-override-menu";

/**
 * Options for the override settings menu.
 */
export interface OverrideSettingsMenuOptions {
  overrides: ProviderOverrides;
  persist: (next: ProviderOverrides) => Promise<void>;
  onSettingChange: () => void;
  onWarning?: (message: string) => void;
}

/**
 * Override settings menu — relative values, partial override.
 *
 * Pure UI component: no `ExtensionCommandContext`, no engine/renderer.
 * Opens a `ProviderOverrideMenu` for per-provider override editing, and
 * supports adding (`a`) and removing (`d`) providers via the list hooks.
 */
export class OverrideSettingsMenu extends AbstractSettingsMenu {
  override settingsList: ResettableSettingsList | null = null;
  private tui: TUI | null = null;
  private theme: Theme | null = null;
  private keybindings: KeybindingsManager | null = null;
  private addDialog: InputDialog | undefined;
  private confirmDialog: ConfirmDialog | undefined;

  constructor(private readonly opts: OverrideSettingsMenuOptions) {
    super();
  }

  /**
   * Creates the override settings list UI.
   *
   * @param tui The TUI instance.
   * @param theme The active theme.
   * @param keybindings The keybindings manager.
   * @param done Callback when the menu is closed.
   * @returns A SettingsList to display.
   */
  create(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value?: string) => void,
  ): SettingsList {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    const items = this.buildList(theme, tui);
    this.settingsList = this.createMainSettingsList(
      items,
      Math.min(items.length + 2, 15),
      () => {}, // Overrides don't use onChange in the same way
      () => done(undefined),
      (itemId) => this.resetProvider(itemId),
      tui,
      {
        onAdd: () => this.beginAdd(),
        onDelete: (itemId) => this.beginDelete(itemId),
      },
    );
    return this.settingsList;
  }

  /**
   * Builds the provider list items. Item ids are the provider ids
   * themselves, so they stay stable across rebuilds.
   */
  private buildList(theme: Theme, tui: TUI): SettingItem[] {
    const ids = Object.keys(this.opts.overrides);
    return ids.map((id) => ({
      id,
      label: id,
      description: "(a) add provider · (d) remove provider",
      currentValue: this.formatOverrideSummary(this.opts.overrides[id] ?? {}),
      submenu: (_cv: string, submenuDone: (value?: string) => void) => {
        return this.createBlockList(id, theme, tui, submenuDone);
      },
    }));
  }

  /**
   * Formats a provider override as summary text.
   */
  private formatOverrideSummary(block: ProviderOverride): string {
    const parts: string[] = [];
    for (const item of Object.values(SETTINGS_ITEMS)) {
      if (!isScalarField(item.id)) continue;
      if (item.id in block) {
        parts.push(
          `${item.id}: ${item.formatPartial(block, settings.getConfig()) ?? ""}`,
        );
      }
    }
    if (block.thresholds !== undefined) {
      const set = TIERS.filter((t) => block.thresholds![t.key] !== undefined);
      if (set.length > 0) {
        parts.push(
          `thresholds: ${set.map((t) => `${t.key}=${block.thresholds![t.key]}`).join(" ")}`,
        );
      }
    }
    if (block.colors !== undefined) {
      const tiers = TIERS.filter((t) => block.colors![t.key] !== undefined);
      if (tiers.length > 0) {
        parts.push(
          `colors: ${tiers.map((t) => block.colors![t.key]).join(" ")}`,
        );
      }
    }
    return parts.length > 0 ? parts.join(", ") : "—";
  }

  /**
   * Creates the per-provider override menu for a specific provider.
   */
  private createBlockList(
    providerId: string,
    theme: Theme,
    tui: TUI,
    done: (value?: string) => void,
  ): SettingsList {
    const menu = new ProviderOverrideMenu({
      providerId,
      overrides: this.opts.overrides,
      persist: this.opts.persist,
      onWarning: (message) => this.opts.onWarning?.(message),
      onBlockChanged: () => {
        this.settingsList?.updateValue(
          providerId,
          this.formatOverrideSummary(this.opts.overrides[providerId] ?? {}),
        );
        // Re-apply engine + renderer with the new override values.
        this.opts.onSettingChange();
      },
    });

    return menu.create(tui, theme, this.keybindings!, () => {
      done(undefined);
    });
  }

  /**
   * Resets a provider to empty overrides.
   *
   * @param providerId The provider id (the item id is the provider id).
   */
  private resetProvider(providerId: string): void {
    if (this.opts.overrides[providerId] === undefined) return;

    const next: ProviderOverrides = {
      ...this.opts.overrides,
      [providerId]: {},
    };

    void this.persistNext(next).then((ok) => {
      if (!ok) return;
      this.opts.onSettingChange();
      this.settingsList?.updateValue(
        providerId,
        this.formatOverrideSummary({}),
      );
      this.tui?.requestRender();
    });
  }

  // -- Add -----------------------------------------------------------------

  /**
   * Opens the add-provider input dialog.
   */
  private beginAdd(): void {
    if (!this.settingsList || !this.theme || !this.tui) return;
    const tui = this.tui;

    this.addDialog = new InputDialog({
      theme: this.theme,
      tui,
      title: "Add provider override",
      message: 'Provider id to override (e.g. "anthropic")',
      placeholder: "anthropic",
      validate: (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
      },
      onSubmit: (value) => {
        this.closeDialogs();
        if (this.opts.overrides[value] !== undefined) return;
        const next: ProviderOverrides = {
          ...this.opts.overrides,
          [value]: {},
        };
        void this.persistNext(next).then((ok) => {
          if (ok) {
            this.opts.onSettingChange();
            this.rebuildList(value);
          }
          tui.requestRender();
        });
      },
      onCancel: () => this.closeDialogs(),
    });
    this.addDialog.focused = true;
    this.settingsList.showModal(this.addDialog);
  }

  // -- Delete ---------------------------------------------------------------

  /**
   * Opens the delete-provider confirmation dialog.
   *
   * @param providerId The provider id of the row to delete.
   */
  private beginDelete(providerId: string): void {
    if (!this.settingsList || !this.theme || !this.tui) return;
    if (this.opts.overrides[providerId] === undefined) return;
    const tui = this.tui;

    this.confirmDialog = new ConfirmDialog({
      theme: this.theme,
      tui,
      title: "Delete provider override",
      message: `Delete overrides for "${providerId}"?`,
      confirmLabel: "Delete",
      onConfirm: () => {
        this.closeDialogs();
        void this.deleteProvider(providerId);
      },
      onCancel: () => this.closeDialogs(),
    });
    this.confirmDialog.focused = true;
    this.settingsList.showModal(this.confirmDialog);
  }

  /**
   * Removes a provider from the overrides map and persists.
   *
   * @param providerId The provider id to delete.
   */
  private async deleteProvider(providerId: string): Promise<void> {
    const next = { ...this.opts.overrides };
    delete next[providerId];
    const ok = await this.persistNext(next);
    if (ok) {
      this.opts.onSettingChange();
      this.rebuildList();
    }
    this.tui?.requestRender();
  }

  // -- Shared helpers ---------------------------------------------------------

  /**
   * Persists the next overrides map and keeps the local snapshot in sync
   * (top-level keys are replaced in place so the UI reads fresh data).
   *
   * @param next The next overrides map.
   * @returns True on success, false on persistence error.
   */
  private async persistNext(next: ProviderOverrides): Promise<boolean> {
    try {
      await this.opts.persist(next);
    } catch (err) {
      this.opts.onWarning?.(String(err));
      return false;
    }
    for (const key of Object.keys(this.opts.overrides)) {
      delete this.opts.overrides[key];
    }
    Object.assign(this.opts.overrides, next);
    return true;
  }

  /**
   * Rebuilds the provider list in place after a structural change.
   *
   * @param selectId Optional provider id to move the selection to.
   */
  private rebuildList(selectId?: string): void {
    if (!this.settingsList || !this.theme || !this.tui) return;
    this.settingsList.setItems(this.buildList(this.theme, this.tui));
    if (selectId !== undefined) this.settingsList.selectItem(selectId);
  }

  /**
   * Closes any open dialog and restores the list.
   */
  private closeDialogs(): void {
    this.addDialog = undefined;
    this.confirmDialog = undefined;
    this.settingsList?.closeModal();
    this.tui?.requestRender();
  }
}
