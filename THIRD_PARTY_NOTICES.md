# Third-Party Notices

Research Pi's original code and documentation are licensed under the MIT
License. Third-party components retain their own copyright and license terms.
This notice is informational and does not replace those terms.

## Direct and vendored components

| Component | Use | License | Source or included terms |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` | Pi Core and terminal UI | MIT | [earendil-works/pi](https://github.com/earendil-works/pi) |
| `pi-trace-extension` 0.1.14 | Optional vendored trace runtime | MIT | [LICENSE](.pi/vendor/pi-trace-extension-0.1.14/LICENSE) and [NOTICE](.pi/vendor/pi-trace-extension-0.1.14/NOTICE.md) |
| `pi-token-speed` 0.11.0 | Default TPS and first-token latency status | MIT | [LICENSE](.pi/vendor/pi-token-speed-0.11.0/LICENSE.md) and [NOTICE](.pi/vendor/pi-token-speed-0.11.0/NOTICE.md) |
| `@anthropic-ai/sandbox-runtime` | OS sandbox runtime | Apache-2.0 | [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) |
| `@anthropic-ai/sdk` | Anthropic API client | MIT | [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) |
| `typebox` | Runtime type schemas | MIT | [sinclairzx81/typebox](https://github.com/sinclairzx81/typebox) |
| node-pty 1.1.0 | Optional Web launch mode: native PTY | MIT | [microsoft/node-pty](https://github.com/microsoft/node-pty) |
| @xterm/xterm, @xterm/headless, @xterm/addon-fit, @xterm/addon-serialize | Browser terminal, resizing and state replay | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| ws 8.22.0 | Authenticated WebSocket transport | MIT | [websockets/ws](https://github.com/websockets/ws) |
| marked 18.0.14 | Browser Markdown rendering | MIT | [markedjs/marked](https://github.com/markedjs/marked) |
| DOMPurify 3.4.16 | HTML sanitization after Markdown rendering | MPL-2.0 OR Apache-2.0 | [cure53/DOMPurify](https://github.com/cure53/DOMPurify) |

Dependencies installed by npm may include additional transitive components.
Their package distributions contain the authoritative license metadata and
texts. A future bundled or standalone distribution must preserve all applicable
third-party LICENSE and NOTICE material.

## Research HTML resources

The bundled `.pi/skills/research-html/` retains separate third-party terms:

- html-plan runtime, upstream snapshot `06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1`: marketplace root Apache-2.0 license in `UPSTREAM-LICENSE`; upstream plugin metadata separately declares MIT in `upstream-plugin.json`. Both are retained without relabeling upstream files as Research Pi's MIT code. Modifications to the packer and additional resources are described in `PROVENANCE.md`.
- KaTeX 0.19.1: MIT, `runtime/math/LICENSE`.
- Source Han Sans CN (modified and renamed Research Han Sans), Inter, and JetBrains Mono: SIL OFL 1.1, original notices in `runtime/fonts/*-OFL.txt`. The standalone HTML packer preserves their notices when embedding fonts.

Other researched skills informed the unified authoring guidance; their implementations and chart templates are not bundled.
