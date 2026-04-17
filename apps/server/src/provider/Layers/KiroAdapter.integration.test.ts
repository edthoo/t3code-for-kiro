/**
 * Integration test for Kiro CLI ACP protocol.
 *
 * Requires `kiro-cli` to be installed and authenticated.
 * Run with: KIRO_INTEGRATION=1 bun run test -- --run src/provider/Layers/KiroAdapter.integration.test.ts
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

function createAcpHarness() {
  const child = spawn("kiro-cli", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
  const messages: JsonRpcMessage[] = [];
  let buffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        messages.push(JSON.parse(t));
      } catch {}
    }
  });

  return {
    send(msg: object) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    messages,
    waitForMessage(predicate: (m: JsonRpcMessage) => boolean, timeoutMs = 10_000) {
      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const start = Date.now();
        const poll = setInterval(() => {
          const found = messages.find(predicate);
          if (found) {
            clearInterval(poll);
            resolve(found);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(poll);
            reject(new Error("Timed out waiting for message"));
          }
        }, 100);
      });
    },
    kill() {
      child.kill();
    },
  };
}

describe.skipIf(!process.env.KIRO_INTEGRATION)("KiroAdapter ACP integration", () => {
  it("completes initialize handshake", async () => {
    const harness = createAcpHarness();
    try {
      harness.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "t3-integration-test", version: "1.0.0" },
        },
      });

      const resp = await harness.waitForMessage((m) => m.id === 0);
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();

      const result = resp.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentInfo).toBeDefined();
    } finally {
      harness.kill();
    }
  });

  it("creates a new session", async () => {
    const harness = createAcpHarness();
    try {
      harness.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "t3-integration-test", version: "1.0.0" },
        },
      });
      harness.send({ jsonrpc: "2.0", method: "initialized" });
      await harness.waitForMessage((m) => m.id === 0);

      harness.send({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      });

      const resp = await harness.waitForMessage((m) => m.id === 1, 15_000);
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();

      const result = resp.result as Record<string, unknown>;
      expect(typeof result.sessionId).toBe("string");
      expect((result.sessionId as string).length).toBeGreaterThan(0);
    } finally {
      harness.kill();
    }
  });
});
