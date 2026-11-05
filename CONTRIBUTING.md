# Contributing to ccmux

## Prerequisites

- [Bun](https://bun.sh) 1.3.14 or later (runtime, package manager, and test runner)
- [tmux](https://github.com/tmux/tmux)

## Setup

```bash
git clone https://github.com/epilande/ccmux.git
cd ccmux
bun install
bun link
```

The `ccmux` launcher prefers `dist/index.js` for faster startup but only when it is current, so during development your edits always win: a launch that finds the bundle stale runs from source and rebuilds the bundle in the background for the next launch (throttled to one rebuild per minute, so rapid edit-launch cycles don't churn builds). You never need to run `bun run build` manually.

To test real session matching during development:

```bash
ccmux setup              # Install hooks for all supported agents (Claude, Codex, Cursor, OpenCode, Pi)
ccmux setup --uninstall  # Remove hooks
```

## Development

Built with TypeScript on Bun. The TUI uses Solid.js via [`@opentui/solid`](https://github.com/anomalyco/opentui). Follow existing code style, keep changes scoped, and prefer clear code over clever abstractions.

### Project Layout

- `src/daemon` — file watching, parsing, session tracking, HTTP/SSE server
- `src/tui` — Solid.js TUI components, store, input handling, and rendering
- `src/commands` — CLI command entrypoints (`show`, `status`, `setup`, `picker`)
- `src/lib` — shared utilities, formatting helpers, config, and preference logic
- `src/types` — shared TypeScript type definitions

### Common Commands

```bash
bun run dev              # Run with --watch for live reload
bun run typecheck        # TypeScript type checking
bun test                 # Run all tests
bun test src/daemon/parser.test.ts  # Run a single test file
bun run build            # Bundle to dist/index.js (consumed by the launcher)
```

## Pull Requests

1. Keep commits focused and ensure `bun run typecheck` and `bun test` pass
2. Open a pull request with a clear summary of what changed and how you verified it
3. Use conventional commit style: `fix: handle stale hook markers`, `docs: expand contributing guide`

For larger features or bug reports, consider opening an issue first.
