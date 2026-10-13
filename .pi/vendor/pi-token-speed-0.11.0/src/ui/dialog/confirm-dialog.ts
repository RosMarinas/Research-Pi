import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { BaseDialog } from "./base-dialog";

/**
 * Framed confirmation dialog with a two-item SelectList (confirm/cancel).
 * Used for destructive actions such as deleting a provider override.
 */
export class ConfirmDialog extends BaseDialog implements Component {
  private readonly container: Container;
  private readonly list: SelectList;
  private isFocused = false;

  constructor(options: ConfirmDialogOptions) {
    super(options.theme, options.tui);

    this.list = new SelectList(
      [
        { value: "confirm", label: options.confirmLabel ?? "Delete" },
        { value: "cancel", label: options.cancelLabel ?? "Cancel" },
      ],
      2,
      this.selectListTheme(),
    );
    this.list.onSelect = (item) => {
      if (item.value === "confirm") options.onConfirm();
      else options.onCancel();
    };
    this.list.onCancel = () => options.onCancel();

    const body = new Container();
    body.addChild(new Text(this.theme.fg("text", options.message), 1, 0));
    body.addChild(new Spacer(1));
    body.addChild(this.list);

    this.container = this.createFrame(
      options.title,
      [body],
      `${this.hint("tui.select.confirm", "confirm")} • ${this.hint("tui.select.cancel", "cancel")}`,
    );
  }

  // -- Component -------------------------------------------------------------

  /**
   * Invalidates the dialog for re-rendering.
   */
  invalidate(): void {
    this.container.invalidate();
  }

  /**
   * Handles raw input data, forwarding to the inner select list.
   *
   * @param data The input data string.
   */
  handleInput(data: string): void {
    this.list.handleInput(data);
    this.tui.requestRender();
  }

  /**
   * Renders the dialog to an array of text lines.
   *
   * @param width The available terminal width.
   * @returns An array of rendered lines.
   */
  render(width: number): string[] {
    return this.container.render(width);
  }

  // -- Focusable ---------------------------------------------------------------

  /**
   * Whether this dialog currently has input focus.
   *
   * @returns True if this dialog has input focus.
   */
  get focused(): boolean {
    return this.isFocused;
  }

  /**
   * Sets input focus on this dialog.
   *
   * @param value True to give focus, false to remove it.
   */
  set focused(value: boolean) {
    this.isFocused = value;
  }
}

/**
 * Options passed to the ConfirmDialog constructor.
 */
interface ConfirmDialogOptions {
  theme: Theme;
  tui: TUI;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}
