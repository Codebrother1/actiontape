import { createActionEnvelope } from "@actiontape/core";
import { describe, expect, it } from "vitest";
import { evaluateContract } from "../src/index.js";
import type { ActionContract } from "../src/index.js";

const envelope = createActionEnvelope({
  protocol: "mcp",
  recordingId: "recording-1",
  operation: "tools/call",
  target: "filesystem/read_file",
  arguments: { path: "/tmp/a.txt" },
});

describe("evaluateContract", () => {
  it("passes when the contract produces no violations", () => {
    const contract: ActionContract = {
      name: "filesystem-read-only",
      check: (e) => (e.target.startsWith("filesystem/read") ? [] : ["non-read target"]),
    };

    const result = evaluateContract(contract, envelope);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.contract).toBe("filesystem-read-only");
  });

  it("reports violations when the contract fails", () => {
    const contract: ActionContract = {
      name: "no-writes",
      check: (e) => [
        { message: `unexpected target ${e.target}` },
        `operation ${e.operation} is not allowed`,
      ],
    };

    const result = evaluateContract(contract, envelope);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[1]).toEqual({ message: "operation tools/call is not allowed" });
  });
});
