# Vendored pi-token-speed runtime

- Upstream: `gsanhueza/pi-token-speed`
- Version: `0.11.0`
- License: MIT; see `LICENSE.md`
- Source: <https://github.com/gsanhueza/pi-token-speed>
- Distribution: <https://registry.npmjs.org/pi-token-speed/-/pi-token-speed-0.11.0.tgz>

The entry point, source runtime, package metadata and license are vendored unchanged. Upstream tests, build configuration and README are omitted.

Research Pi loads this extension through `.pi/extensions/token-speed.ts` and supplies `tokenSpeed.display: "ttft"` and `tokenSpeed.useProviderTokens: true` through its Pi-native settings. The wrapper renders the upstream status in a separate below-editor performance row, with wrapping on narrow terminals, and preserves the upstream measurement engine and `/tps` menu. The extension resolves its settings path with Pi's `getAgentDir()`, preserving Research Pi's state isolation.
