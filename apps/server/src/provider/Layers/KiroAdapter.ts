/**
 * KiroAdapterLive - ACP (Agent Client Protocol) adapter for Kiro CLI.
 *
 * Spawns `kiro-cli acp` as a child process, communicates via JSON-RPC 2.0
 * over stdio, and maps ACP session notifications to canonical
 * ProviderRuntimeEvent events.
 *
 * @module KiroAdapterLive
 */
import {
  type CanonicalItemType,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { KiroAdapter, type KiroAdapterShape } from "../Services/KiroAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "kiro" as const;

// ── JSON-RPC types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg;
}

// ── ACP child process wrapper ─────────────────────────────────────────

interface AcpProcess {
  send(request: JsonRpcRequest): void;
  sendNotification(method: string, params?: unknown): void;
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  onExit(handler: () => void): void;
  kill(): void;
  readonly alive: boolean;
}

function spawnAcpProcess(binaryPath: string, cwd: string, approvalPolicy?: string, model?: string): AcpProcess {
  const args = ["acp"];
  // Map T3 approval policy to ACP trust flags
  if (approvalPolicy === "never" || approvalPolicy === "on-failure") {
    args.push("--trust-all-tools");
  }
  if (model) {
    args.push("--model", model);
  }

  // Use node:child_process so this works under both Bun and Node (Electron).
  const { spawn: nodeSpawn } = require("node:child_process") as typeof import("node:child_process");
  const child = nodeSpawn(binaryPath, args, {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });

  let alive = true;
  const messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  let buffer = "";

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        for (const handler of messageHandlers) handler(msg);
      } catch {
        // Skip non-JSON lines
      }
    }
  });

  const exitHandlers: Array<() => void> = [];

  child.on("exit", () => {
    alive = false;
    for (const handler of exitHandlers) handler();
  });

  return {
    send(request) {
      if (!alive) return;
      child.stdin!.write(JSON.stringify(request) + "\n");
    },
    sendNotification(method, params) {
      if (!alive) return;
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    kill() {
      alive = false;
      child.kill();
    },
    get alive() {
      return alive;
    },
  };
}

// ── Session context ───────────────────────────────────────────────────

interface KiroSessionContext {
  session: ProviderSession;
  process: AcpProcess;
  acpSessionId: string | undefined;
  nextRpcId: number;
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  stopped: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const newEventId = () => EventId.make(crypto.randomUUID());

function eventBase(threadId: ThreadId, turnId?: TurnId) {
  return {
    eventId: newEventId(),
    provider: PROVIDER as "kiro",
    threadId,
    createdAt: nowIso(),
    ...(turnId ? { turnId } : {}),
  };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const lower = toolName.toLowerCase();
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch"))
    return "file_change";
  if (lower.includes("read") || lower.includes("grep") || lower.includes("glob"))
    return "file_change";
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("command"))
    return "command_execution";
  return "mcp_tool_call";
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  if (cause instanceof ProviderAdapterSessionNotFoundError) return cause;
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? `${method} failed: ${cause.message}` : `${method} failed`,
    cause,
  });
}

function sendRpc(ctx: KiroSessionContext, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ctx.nextRpcId++;
    // session/prompt can run for minutes — no timeout for it
    const timeoutMs = method === "session/prompt" ? 0 : 30_000;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (ctx.pendingRequests.has(id)) {
            ctx.pendingRequests.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }
        }, timeoutMs)
      : null;
    ctx.pendingRequests.set(id, {
      resolve: (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      },
    });
    ctx.process.send({ jsonrpc: "2.0", id, method, params });

    // If the process exits while we're waiting, reject immediately
    ctx.process.onExit(() => {
      if (ctx.pendingRequests.has(id)) {
        ctx.pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`ACP process exited during ${method}`));
      }
    });
  });
}

// ── Adapter implementation ────────────────────────────────────────────

export const makeKiroAdapterLive = Effect.fn("makeKiroAdapterLive")(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<string, KiroSessionContext>();

  const emitEvent = (event: ProviderRuntimeEvent) => {
    Effect.runSync(Queue.offer(eventQueue, event));
  };

  const handleNotification = (ctx: KiroSessionContext, method: string, params: unknown) => {
    if (method !== "session/update") return;
    const raw = params as { sessionId?: string; update?: Record<string, unknown> };
    const update = raw.update;
    if (!update) return;
    const updateType = update.sessionUpdate as string | undefined;
    const threadId = ctx.session.threadId;
    const turnId = ctx.session.activeTurnId;

    switch (updateType) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        const text = content?.text ?? "";
        if (!text) break;
        emitEvent({
          ...eventBase(threadId, turnId),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: text },
        });
        break;
      }
      case "tool_call": {
        const status = update.status as string | undefined;
        const toolName = (update.title as string) ?? "tool";
        const itemId = RuntimeItemId.make((update.toolCallId as string) ?? crypto.randomUUID());
        const itemType = classifyToolItemType(toolName);

        if (status === "completed" || status === "error") {
          emitEvent({
            ...eventBase(threadId, turnId),
            itemId,
            type: "item.completed",
            payload: { itemType, status: status === "error" ? "failed" : "completed", title: toolName },
          });
        } else {
          emitEvent({
            ...eventBase(threadId, turnId),
            itemId,
            type: "item.started",
            payload: { itemType, title: toolName },
          });
        }
        break;
      }
      case "tool_call_update": {
        const itemId = RuntimeItemId.make((update.toolCallId as string) ?? "unknown");
        const status = update.status as string | undefined;
        if (status === "completed" || status === "error") {
          emitEvent({
            ...eventBase(threadId, turnId),
            itemId,
            type: "item.completed",
            payload: { itemType: "mcp_tool_call", status: status === "error" ? "failed" : "completed" },
          });
        } else {
          emitEvent({
            ...eventBase(threadId, turnId),
            itemId,
            type: "item.updated",
            payload: { itemType: "mcp_tool_call" },
          });
        }
        break;
      }
      case "plan": {
        const entries = update.entries as Array<{ content?: string; status?: string }> | undefined;
        if (entries?.length) {
          const planMarkdown = entries.map((e) => `- [${e.status ?? "pending"}] ${e.content ?? ""}`).join("\n");
          emitEvent({
            ...eventBase(threadId, turnId),
            type: "turn.proposed.completed",
            payload: { planMarkdown },
          });
        }
        break;
      }
    }
  };

  const requireSession = (threadId: ThreadId): KiroSessionContext => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped)
      throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return ctx;
  };

  const startSession: KiroAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (e) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Failed to read settings: ${e.message}`,
              cause: e,
            }),
        ),
      );
      const binaryPath = settings.providers.kiro.binaryPath;
      const cwd = input.cwd ?? config.cwd;
      const threadId = input.threadId;
      const ts = nowIso();

      const proc = spawnAcpProcess(binaryPath, cwd, input.approvalPolicy, input.modelSelection?.model);
      const ctx: KiroSessionContext = {
        session: {
          provider: PROVIDER,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd,
          threadId,
          createdAt: ts,
          updatedAt: ts,
        },
        process: proc,
        acpSessionId: undefined,
        nextRpcId: 0,
        pendingRequests: new Map(),
        stopped: false,
      };

      proc.onMessage((msg) => {
        if (isResponse(msg)) {
          const pending = ctx.pendingRequests.get(msg.id);
          if (pending) {
            ctx.pendingRequests.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        } else {
          handleNotification(ctx, msg.method, msg.params);
        }
      });

      sessions.set(threadId, ctx);

      // ACP initialize
      yield* Effect.tryPromise({
        try: () =>
          sendRpc(ctx, "initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: "t3-code", version: "1.0.0" },
          }),
        catch: (e) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: `ACP initialize failed: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          }),
      });

      // Send initialized notification (ACP/LSP pattern)
      ctx.process.sendNotification("initialized");

      // Create or load session
      const sessionResult = yield* Effect.tryPromise({
        try: () =>
          input.resumeCursor
            ? sendRpc(ctx, "session/load", { sessionId: input.resumeCursor as string, cwd })
            : sendRpc(ctx, "session/new", { cwd, mcpServers: [] }),
        catch: (e) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: `ACP session creation failed: ${e instanceof Error ? e.message : String(e)}`,
            cause: e,
          }),
      });

      const acpSessionId = (sessionResult as Record<string, unknown>)?.sessionId as
        | string
        | undefined;
      ctx.acpSessionId = acpSessionId;
      ctx.session = {
        ...ctx.session,
        status: "ready",
        updatedAt: nowIso(),
        ...(acpSessionId ? { resumeCursor: acpSessionId } : {}),
      };

      emitEvent({
        ...eventBase(threadId),
        type: "session.started",
        payload: { resume: acpSessionId },
      });
      emitEvent({ ...eventBase(threadId), type: "thread.started", payload: {} });

      return ctx.session;
    });

  const sendTurn: KiroAdapterShape["sendTurn"] = (input) =>
    Effect.try({
      try: () => {
        const ctx = requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: nowIso(),
        };

        emitEvent({ ...eventBase(input.threadId, turnId), type: "turn.started", payload: {} });

        const content: Array<{ type: string; text?: string }> = [];
        if (input.input) content.push({ type: "text", text: input.input });

        // Fire and forget — responses come via session/update notifications,
        // turn completes when the session/prompt RPC response arrives
        void sendRpc(ctx, "session/prompt", {
          sessionId: ctx.acpSessionId,
          prompt: content.length > 0 ? content : [{ type: "text", text: "" }],
        })
          .then((result) => {
            const res = result as Record<string, unknown> | undefined;
            const stopReason = (res?.stopReason as string) ?? "end_turn";
            const state = stopReason === "cancelled" ? "cancelled" : "completed";
            emitEvent({
              ...eventBase(input.threadId, turnId),
              type: "turn.completed",
              payload: { state },
            });
            ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
          })
          .catch((error: unknown) => {
            emitEvent({
              ...eventBase(input.threadId, turnId),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: error instanceof Error ? error.message : "Unknown error",
              },
            });
            ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
          });

        return { threadId: input.threadId, turnId, resumeCursor: ctx.acpSessionId };
      },
      catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
    });

  const interruptTurn: KiroAdapterShape["interruptTurn"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      if (ctx?.acpSessionId) {
        ctx.process.sendNotification("session/cancel", { sessionId: ctx.acpSessionId });
      }
    });

  const stopSession: KiroAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      if (ctx) {
        ctx.stopped = true;
        ctx.process.kill();
        sessions.delete(threadId);
        emitEvent({
          ...eventBase(threadId),
          type: "session.exited",
          payload: { reason: "stopped" },
        });
      }
    });

  const stopAll: KiroAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      for (const [threadId, ctx] of sessions) {
        ctx.stopped = true;
        ctx.process.kill();
        emitEvent({
          ...eventBase(threadId as ThreadId),
          type: "session.exited",
          payload: { reason: "stopped" },
        });
      }
      sessions.clear();
    });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession,
    listSessions: () => Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.try({
        try: () => {
          requireSession(threadId);
          return { threadId, turns: [] };
        },
        catch: (cause) => toRequestError(threadId, "readThread", cause),
      }),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Thread rollback is not supported by the Kiro ACP protocol.",
        }),
      ),
    stopAll,
    streamEvents: Stream.fromQueue(eventQueue),
  } satisfies KiroAdapterShape;
});

export const KiroAdapterLive = Layer.effect(KiroAdapter, makeKiroAdapterLive());
