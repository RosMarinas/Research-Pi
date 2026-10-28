import { runtimePerformance } from "./runtime-performance.mjs";
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// Pi's complete InteractiveMode drives this terminal. It never owns a physical tty.
export class NativeTerminal {
  constructor({ cols = 100, rows = 30, output = () => {} } = {}) {
    this.screen = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.serializer = new SerializeAddon(); this.screen.loadAddon(this.serializer);
    this.output = output; this.seq = 0; this.kittyProtocolActive = false;
  }
  start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; }
  stop() { this.onInput = undefined; this.onResize = undefined; clearInterval(this.progressTimer); this.progressTimer = undefined; }
  get columns() { return this.screen.cols; }
  get rows() { return this.screen.rows; }
  async drainInput() {}
  write(data) { runtimePerformance.count("terminalWrites"); if (runtimePerformance.enabled) runtimePerformance.count("terminalBytes", Buffer.byteLength(data)); this.screen.write(data, () => this.output({ type:'terminal', data, seq: ++this.seq })); }
  input(data) { this.onInput?.(data); }
  resize(cols, rows) { if (cols === this.columns && rows === this.rows) return; this.screen.resize(cols, rows); this.onResize?.(); this.output({ type:'terminal_resize',cols,rows }); }
  snapshot() { return new Promise(resolve => this.screen.write('', () => resolve({data:this.serializer.serialize(), cols:this.columns, rows:this.rows, seq:this.seq}))); }
  moveBy(lines) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor() { this.write('\x1b[?25l'); }
  showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[K'); }
  clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  setTitle(title) { this.write('\x1b]0;' + String(title).replace(/[\x00-\x1f\x7f]/g,'') + '\x07'); }
  // Pi 1.2 requires this Terminal method. The headless screen does not
  // support OSC 7501, so retain the report without emitting that protocol.
  setProgramStatus(status) { this.programStatus = status.state === 'clear' ? undefined : { ...status }; }
  setProgress(active) {
    clearInterval(this.progressTimer); this.progressTimer = undefined;
    this.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0\x07");
    if (active) { this.progressTimer = setInterval(() => this.write("\x1b]9;4;3\x07"), 1000); this.progressTimer.unref(); }
  }
  dispose() { this.stop(); this.screen.dispose(); }
}
