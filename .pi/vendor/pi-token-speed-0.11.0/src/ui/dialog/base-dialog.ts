import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Keybinding, TUI } from "@earendil-works/pi-tui";
import {
  Container,
  getKeybindings,
  Spacer,
  Text,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

/**
 * Base dialog class encapsulating shared UI utilities (frame, hints,
 * themes) so concrete dialogs don't duplicate code.
 */
export abstract class BaseDialog {
  protected theme: Theme;
  protected tui: TUI;

  constructor(theme: Theme, tui: TUI) {
    this.theme = theme;
    this.tui = tui;
  }

  // -- shared utilities ------------------------------------------------------

  /**
   * Builds a hint string from a keybinding and description.
   *
   * @param action The keybinding action to look up.
   * @param description Human-readable description of the action.
   * @returns A styled hint string (e.g. `Enter/Space save`).
   */
  protected hint(action: Keybinding, description: string): string {
    const keys = getKeybindings().getKeys(action).join("/");
    return (
      this.theme.fg("dim", keys) + this.theme.fg("muted", ` ${description}`)
    );
  }

  /**
   * Builds the input dialog footer with save/cancel hints.
   *
   * @returns A styled footer string.
   */
  protected inputFooter(): string {
    return `${this.hint("tui.select.confirm", "save")} • ${this.hint("tui.select.cancel", "cancel")}`;
  }

  /**
   * Returns the SelectList theme with accent-colored selections and muted descriptions.
   *
   * @returns A SelectListTheme configuration.
   */
  protected selectListTheme(): SelectListTheme {
    return {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    };
  }

  /**
   * Creates a framed container with a title, body components, and optional footer.
   *
   * @param title The frame title text.
   * @param body The child components to place inside the frame.
   * @param footer Optional footer text displayed above the bottom border.
   * @returns A Container with DynamicBorder framing.
   */
  protected createFrame(
    title: string,
    body: Component[],
    footer?: string,
  ): Container {
    const container = new Container();
    container.addChild(
      new DynamicBorder((text) => this.theme.fg("accent", text)),
    );
    container.addChild(
      new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0),
    );
    for (const child of body) container.addChild(child);
    if (footer) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(this.theme.fg("dim", footer), 1, 0));
    }
    container.addChild(
      new DynamicBorder((text) => this.theme.fg("accent", text)),
    );
    return container;
  }
}
