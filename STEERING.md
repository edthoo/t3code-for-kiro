# Kiro CLI Provider Integration — Steering Document

## Status

Kiro is the **default provider** in T3 Code. All three providers (Kiro, Codex, Claude) are functional.

## Architecture

`kiro-cli acp` — JSON-RPC 2.0 over stdio. The adapter spawns `kiro-cli acp --model <model>` per session.

ACP docs: https://kiro.dev/docs/cli/acp/

### Key Files

- `apps/server/src/provider/Layers/KiroAdapter.ts` — ACP process lifecycle, session management, turn dispatch
- `apps/server/src/provider/Layers/KiroProvider.ts` — Provider status detection, dynamic model fetching

### ACP ↔ ProviderAdapter Mapping

| Adapter Method       | ACP Method                                   | Notes                                |
| -------------------- | -------------------------------------------- | ------------------------------------ |
| `startSession`       | `initialize` + `initialized` + `session/new` | Three-step handshake                 |
| `sendTurn`           | `session/prompt`                             | No timeout; process exit = rejection |
| `interruptTurn`      | `session/cancel` (notification)              |                                      |
| `stopSession`        | Kill child process                           |                                      |
| `respondToRequest`   | —                                            | `--trust-all-tools` at session start |

### ACP Event Mapping

| ACP `session/update` type | ProviderRuntimeEvent             |
| ------------------------- | -------------------------------- |
| `agent_message_chunk`     | `content.delta` (assistant_text) |
| `tool_call` (pending)     | `item.started`                   |
| `tool_call` (completed)   | `item.completed`                 |
| `tool_call_update`        | `item.updated` / `item.completed`|
| `plan`                    | `turn.proposed.completed`        |
| RPC response `stopReason` | `turn.completed`                 |

## Design Decisions

- **No timeout on `session/prompt`** — Tasks can run for hours. Process exit rejects all pending requests as a safety net.
- **Model via CLI flag** — `kiro-cli acp --model <model>` sets the model at spawn time. `sessionModelSwitch` is `"in-session"` to avoid unnecessary restarts.
- **Dynamic model list** — Fetched via `kiro-cli chat --list-models --format json-pretty` on startup with 10s timeout. Falls back to built-in `["auto"]`.
- **No auth check** — `kiro-cli` has no `auth` subcommand. A successful `--version` check is treated as ready/authenticated.
- **Node.js compatible** — Uses `node:child_process.spawn` instead of `Bun.spawn` since the desktop app runs the server under Electron/Node.

## Known Gaps vs Codex

| Feature              | Status     | Notes                                         |
| -------------------- | ---------- | --------------------------------------------- |
| Thread rollback      | ❌ N/A     | Not in ACP protocol                           |
| Token usage          | ❌ Gap     | ACP doesn't include usage in responses        |
| Interactive approval | ❌ Gap     | ACP `session/request_permission` not yet impl |

## Adding Kiro to New Code

When adding features that enumerate providers, ensure `"kiro"` appears alongside `"codex"` and `"claudeAgent"`. Key locations:

- `ProviderKind` schema (`packages/contracts/src/orchestration.ts`)
- `normalizeProviderKind` (`apps/web/src/composerDraftStore.ts`)
- `decodeProviderKind` (`apps/server/src/provider/Layers/ProviderSessionDirectory.ts`)
- Provider iteration loops (search for `["codex", "claudeAgent"`)
- Default fallbacks (search for `?? "codex"`)
- `PROVIDER_ORDER` (`apps/server/src/serverSettings.ts`)
