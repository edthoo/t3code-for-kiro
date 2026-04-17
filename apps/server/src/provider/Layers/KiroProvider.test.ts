import { describe, expect, it } from "vitest";
import { getKiroModelCapabilities, parseKiroAuthFromOutput } from "./KiroProvider.ts";

describe("getKiroModelCapabilities", () => {
  it("returns capabilities for known model", () => {
    const caps = getKiroModelCapabilities("kiro-default");
    expect(caps.reasoningEffortLevels).toHaveLength(3);
    expect(caps.supportsFastMode).toBe(false);
  });

  it("returns default capabilities for unknown model", () => {
    const caps = getKiroModelCapabilities("unknown-model");
    expect(caps.reasoningEffortLevels).toHaveLength(3);
  });

  it("returns default capabilities for null/undefined", () => {
    expect(getKiroModelCapabilities(null)).toBeDefined();
    expect(getKiroModelCapabilities(undefined)).toBeDefined();
  });
});

describe("parseKiroAuthFromOutput", () => {
  it("detects authenticated status on exit code 0", () => {
    const result = parseKiroAuthFromOutput({ stdout: "Logged in as user", stderr: "", code: 0 });
    expect(result.status).toBe("ready");
    expect(result.auth.status).toBe("authenticated");
  });

  it("detects unauthenticated from 'not logged in'", () => {
    const result = parseKiroAuthFromOutput({ stdout: "Not logged in", stderr: "", code: 1 });
    expect(result.status).toBe("error");
    expect(result.auth.status).toBe("unauthenticated");
  });

  it("detects unauthenticated from 'not authenticated'", () => {
    const result = parseKiroAuthFromOutput({ stdout: "", stderr: "not authenticated", code: 1 });
    expect(result.status).toBe("error");
    expect(result.auth.status).toBe("unauthenticated");
  });

  it("returns warning for non-zero exit without auth keywords", () => {
    const result = parseKiroAuthFromOutput({ stdout: "", stderr: "some error", code: 1 });
    expect(result.status).toBe("warning");
    expect(result.auth.status).toBe("unknown");
    expect(result.message).toContain("some error");
  });
});
