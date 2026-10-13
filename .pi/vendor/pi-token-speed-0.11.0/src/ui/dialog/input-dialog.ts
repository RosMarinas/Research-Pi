import { type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import { BaseDialog } from "./base-dialog";

/**
 * Framed text-input dialog used as a `SettingItem.submenu` target.
 * Shows a title, a message, an optional `e.g., <placeholder>` hint and the
 * input itself, framed by accent `DynamicBorder`s with a keybinding footer.
 *
 * Enter commits the validated value via `onSubmit`; Esc cancels via
 * `onCancel`. Invalid values render an inline error line and keep the
 * dialog open for correction.
 */
export class InputDialog extends BaseDialog implements Component {
  private readonly options: InputDialogOptions;
  private readonly body = new Container();
  private readonly container: Container;
  private readonly input: Input;
  private errorText: Text | undefined;

  constructor(options: InputDialogOptions) {
    super(options.theme, options.tui);
    this.options = options;

    const initial = options.initialValue ?? "";
    this.input = options.createInput?.() ?? new Input();
    this.input.setValue(initial);
    for (let i = 0; i < [...initial].length; i++) {
      this.input.handleInput("\x1b[C");
    }
    this.input.onSubmit = (value) => {
      this.submit(value);
      this.tui.requestRender();
    };
    this.input.onEscape = () => {
      options.onCancel();
      this.tui.requestRender();
    };

    this.body.addChild(new Text(this.theme.fg("text", options.message), 1, 0));
    if (options.placeholder) {
      this.body.addChild(
        new Text(this.theme.fg("dim", `e.g., ${options.placeholder}`), 1, 0),
      );
    }
    this.body.addChild(this.input);

    this.container = this.createFrame(
      options.title,
      [this.body],
      this.inputFooter(),
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
   * Handles raw input data, forwarding to the inner input component.
   *
   * @param data The input data string.
   */
  handleInput(data: string): void {
    this.input.handleInput(data);
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
    return this.input.focused;
  }

  /**
   * Sets input focus on this dialog, forwarding to the inner input.
   *
   * @param value True to give focus, false to remove it.
   */
  set focused(value: boolean) {
    this.input.focused = value;
  }

  // -- helpers -------------------------------------------------------------------

  /**
   * Validates and submits the input value.
   *
   * Runs the optional validate callback; on invalid value, shows an
   * inline error. On success, calls onSubmit with the validated value.
   *
   * @param raw The raw input string.
   */
  private submit(raw: string): void {
    const validated = this.options.validate ? this.options.validate(raw) : raw;
    if (validated === null) {
      this.setError(`Invalid value "${raw}"`);
      return;
    }
    this.options.onSubmit(validated);
  }

  /**
   * Sets or clears the inline error message.
   *
   * @param message The error message to show, or undefined to clear.
   */
  private setError(message: string | undefined): void {
    if (this.errorText) {
      this.body.removeChild(this.errorText);
      this.errorText = undefined;
    }
    if (message) {
      this.errorText = new Text(this.theme.fg("error", message), 1, 0);
      this.body.addChild(this.errorText);
    }
    this.tui.requestRender();
  }

  /**
   * Builds a `SettingItem.submenu` factory that opens an `InputDialog`.
   *
   * @param theme The active theme (for dialog styling)
   * @param tui The TUI instance (for re-renders while the dialog is open)
   * @param options Dialog content options (title, message, validation, ...
   *   and optionally `createInput` for a custom input component).
   *   `onSubmit`/`onCancel` are wired to the submenu's `done` callback.
   */
  static inputSubmenu =
    (theme: Theme, tui: TUI, options: SubmenuOptions) =>
    (
      _currentValue: string,
      done: (selectedValue?: string) => void,
    ): Component => {
      const dialog = new InputDialog({
        theme,
        tui,
        ...options,
        onSubmit: (value) => done(value),
        onCancel: () => done(undefined),
      });
      dialog.focused = true;
      return dialog;
    };
}

/**
 * Dialog content options accepted by `InputDialog.inputSubmenu`.
 * Theme/TUI are passed separately; submit/cancel are wired to the
 * submenu's `done` callback.
 */
export type SubmenuOptions = Omit<
  InputDialogOptions,
  "theme" | "tui" | "onSubmit" | "onCancel"
>;

/**
 * Options passed to the InputDialog constructor.
 */
interface InputDialogOptions {
  theme: Theme;
  tui: TUI;
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (raw: string) => string | null;
  createInput?: () => Input;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}
