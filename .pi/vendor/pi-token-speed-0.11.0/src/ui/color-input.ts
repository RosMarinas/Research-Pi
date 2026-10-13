import { Input, visibleWidth } from "@earendil-works/pi-tui";
import { HEX_CHAR, isValidHex } from "../settings/items/tiers/validation";

/**
 * Single-line input that live-previews hex color values: the moment the
 * typed value forms a valid `#RRGGBB` string, the text (including the
 * leading `#`) is rendered in that color — no Enter required.
 */
export class HexColorInput extends Input {
  private readonly promptText: string;
  private readonly maxHexLength = 7;

  constructor(options?: { prompt?: string }) {
    super(options);
    // Kept locally because `Input`'s `prompt` field is private and the
    // rendered-line splicing below needs its plain-text extent. Note:
    // the prompt must be a plain (escape-free) string for this to work.
    this.promptText = options?.prompt ?? "> ";
  }

  /**
   * Returns true when `data` consists solely of characters valid for a hex
   * color input (`#` and `0-9A-Fa-f`), rejecting control sequences and
   * non-hex printable characters.
   */
  private isHexCharacterInsert(data: string): boolean {
    if (data.startsWith("\x1b")) return false;
    if (
      [...data].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      })
    )
      return false;
    return new RegExp(`^${HEX_CHAR}+$`).test(data);
  }

  /**
   * Override to restrict input to valid hex color characters (`#` and
   * `0-9A-Fa-f`) and enforce a maximum of 7 characters.  Navigation,
   * deletion, undo, paste, and other editor commands pass through
   * (the parent class handles keybindings before rejecting stray
   * control characters).
   */
  override handleInput(data: string): void {
    if (data.startsWith("\x1b")) {
      super.handleInput(data);
      return;
    }
    if (
      [...data].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      })
    ) {
      super.handleInput(data);
      return;
    }
    if (!this.isHexCharacterInsert(data)) return;
    if (this.getValue().length >= this.maxHexLength) return;
    super.handleInput(data);
  }

  /**
   * Renders the input with live hex color preview: when the value
   * forms a valid `#RRGGBB`, the hex text is rendered in that color.
   *
   * @param width The available terminal width.
   * @returns An array of rendered text lines.
   */
  override render(width: number): string[] {
    const lines = super.render(width);
    const value = this.getValue();
    if (!isValidHex(value)) return lines;

    // A valid hex is always 7 ASCII chars, so the value can only be
    // horizontally scrolled when the available width can't show all 7
    // chars. Skip colorization in that case rather than splicing escapes
    // into a scrolled/clipped render (equivalent to pi-tui's private
    // `renderedStartColumn === 0` check, without touching private state).
    if (visibleWidth(this.promptText) + value.length > width) return lines;

    const line = lines[0];
    const r = parseInt(value.slice(1, 3), 16);
    const g = parseInt(value.slice(3, 5), 16);
    const b = parseInt(value.slice(5, 7), 16);
    const fg = `\x1b[38;2;${r};${g};${b}m`;

    // The line is `prompt + textWithCursor + padding`, where the padding is
    // a trailing run of spaces. The value region itself never ends with a
    // raw space (a cursor parked at the end is wrapped in `\x1b[27m`), so
    // scanning back over spaces reliably finds the end of the text region.
    let textEnd = line.length;
    while (textEnd > this.promptText.length && line[textEnd - 1] === " ") {
      textEnd--;
    }

    return [
      line.slice(0, this.promptText.length) +
        fg +
        line.slice(this.promptText.length, textEnd) +
        "\x1b[0m" +
        line.slice(textEnd),
    ];
  }
}
