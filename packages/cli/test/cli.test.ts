import { describe, expect, it } from "vitest";
import { CLI_VERSION, main } from "../src/index.js";

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("actiontape cli", () => {
  it("prints version", () => {
    const { lines, write } = capture();
    expect(main(["--version"], write)).toBe(0);
    expect(lines[0]).toContain(CLI_VERSION);
  });

  it("prints help with exit code 0", () => {
    const { lines, write } = capture();
    expect(main([], write)).toBe(0);
    expect(main(["--help"], write)).toBe(0);
    expect(lines.join("\n")).toContain("Usage:");
  });

  it("exits non-zero on unknown arguments", () => {
    const { write } = capture();
    expect(main(["--bogus"], write)).toBe(1);
  });
});
