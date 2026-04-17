# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex, Claude, and Kiro.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps provider CLIs (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Architecture

T3 Code is Kiro-first (default provider). The server supports three providers: Kiro, Codex, and Claude. Each provider has its own adapter layer.

### Kiro (default)

The Kiro adapter communicates with `kiro-cli acp` (Agent Client Protocol over JSON-RPC/stdio). Key files:

- `apps/server/src/provider/Layers/KiroAdapter.ts` — ACP process lifecycle, session management, turn dispatch.
- `apps/server/src/provider/Layers/KiroProvider.ts` — Provider status detection, dynamic model fetching via `kiro-cli chat --list-models`.

The adapter spawns `kiro-cli acp --model <model>` per session. Models are fetched dynamically at startup. The `session/prompt` RPC has no timeout (long-running tasks); process exit rejects all pending requests as a safety net.

### Codex

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- The Codex adapter uses `codex app-server` (JSON-RPC over stdio) with fire-and-forget turn RPCs and streaming event notifications.

### Claude

- The Claude adapter wraps `claude` CLI with its own JSON-RPC protocol.

### Adding a new provider

When adding provider support, ensure `"kiro"` (or the new provider) is included in all enumeration points. Search for `"codex"` and `"claudeAgent"` patterns — anywhere these are listed, the new provider must also appear. Key locations: `ProviderKind` schema, `normalizeProviderKind`, provider iteration loops, default fallbacks, and `decodeProviderKind`.
