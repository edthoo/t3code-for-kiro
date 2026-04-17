import { describe, expect, it } from "vitest";
import { classifyToolItemType } from "./KiroAdapter.ts";

describe("classifyToolItemType", () => {
  it("classifies file write tools", () => {
    expect(classifyToolItemType("write_file")).toBe("file_change");
    expect(classifyToolItemType("editFile")).toBe("file_change");
    expect(classifyToolItemType("apply_patch")).toBe("file_change");
  });

  it("classifies file read tools", () => {
    expect(classifyToolItemType("read_file")).toBe("file_change");
    expect(classifyToolItemType("grep_search")).toBe("file_change");
    expect(classifyToolItemType("glob_files")).toBe("file_change");
  });

  it("classifies command execution tools", () => {
    expect(classifyToolItemType("shell_exec")).toBe("command_execution");
    expect(classifyToolItemType("run_bash")).toBe("command_execution");
    expect(classifyToolItemType("execute_command")).toBe("command_execution");
  });

  it("defaults to mcp_tool_call for unknown tools", () => {
    expect(classifyToolItemType("custom_tool")).toBe("mcp_tool_call");
    expect(classifyToolItemType("fetch_url")).toBe("mcp_tool_call");
  });

  it("is case-insensitive", () => {
    expect(classifyToolItemType("WriteFile")).toBe("file_change");
    expect(classifyToolItemType("SHELL_EXEC")).toBe("command_execution");
  });
});
