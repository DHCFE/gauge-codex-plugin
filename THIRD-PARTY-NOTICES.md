# Third-party notices

Gauge (formerly TokenLens) bundles the MCP SDK, MCP Apps extensions, their JavaScript dependencies,
Node.js, Python and PyInstaller runtime components. The Mac release includes their
full license texts in `THIRD-PARTY-NOTICES.txt` and `plugin/runtime/darwin-arm64/`.

## CodexBar

Upstream: https://github.com/steipete/CodexBar (MIT).

Copyright (c) 2026 Peter Steinberger. License verified at pinned commit
[`7998bf66c796befcb91c38e6b1096e702e511481`](https://github.com/steipete/CodexBar/tree/7998bf66c796befcb91c38e6b1096e702e511481)
([MIT license](https://github.com/steipete/CodexBar/blob/7998bf66c796befcb91c38e6b1096e702e511481/LICENSE)).

Upstream code was reviewed as a development reference.

A/B reviewed the upstream CLI and local cost scanner interfaces, including:

- `Sources/CodexBarCore/Vendored/CostUsage/CostUsageScanner.swift`
- `Sources/CodexBarCore/CostUsageFetcher.swift`
- `docs/cli.md`
- `LICENSE`

The request-level account ledger reuses existing TokenLens
`cost_meter.usage/add/subtract/Prices.cost_parts/tail_hash` and
`agent_usage.lineage`. E uses B's official RPC, official-cycle query and ledger-normalization helpers.
Budget persistence and UI reuse these interfaces without importing Swift UI.

Module-specific review evidence and limitations are in
`development-status/ledger.json`, `quota.json`, `budget.json` and `ui.json`.

