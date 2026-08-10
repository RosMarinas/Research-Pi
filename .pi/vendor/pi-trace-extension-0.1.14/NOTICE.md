# Vendored pi-trace runtime

- Upstream: `npxcnency-ux/pi-trace-extension`
- Version: `0.1.14`
- License: MIT; see `LICENSE`
- Source: <https://github.com/npxcnency-ux/pi-trace-extension/tree/v0.1.14>

Only the runtime files needed for event collection and HTML rendering are vendored. The example screenshot, duplicated READMEs, source viewer assets and Python bytecode are omitted.

Local compatibility change: trace output first honors `PI_TRACE_DIR`, then `PI_CODING_AGENT_DIR/traces`, and only then falls back to upstream's `~/.pi/agent/traces`. Upstream 0.1.14 hard-codes the fallback and therefore breaks this harness's project-local Pi isolation.
