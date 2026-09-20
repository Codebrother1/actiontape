import { describe, expect, it } from "vitest";
import { LineTap } from "../src/index.js";

function collect(): { lines: string[]; tap: LineTap } {
  const lines: string[] = [];
  return { lines, tap: new LineTap((line) => lines.push(line)) };
}

describe("LineTap", () => {
  it("reassembles one message split across many chunks", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from('{"jsonrpc":"2.'));
    tap.push(Buffer.from('0","id":'));
    tap.push(Buffer.from('1,"method":"ping"}'));
    tap.push(Buffer.from("\n"));
    tap.end();
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
  });

  it("emits several messages arriving in one chunk", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'));
    tap.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("handles a multibyte UTF-8 character split across Buffer boundaries", () => {
    const { lines, tap } = collect();
    const payload = Buffer.from('{"text":"héllo 🙂"}\n', "utf8");
    const cut = payload.indexOf(0xf0);
    tap.push(payload.subarray(0, cut + 1));
    tap.push(payload.subarray(cut + 1, cut + 3));
    tap.push(payload.subarray(cut + 3));
    tap.end();
    expect(lines).toEqual(['{"text":"héllo 🙂"}']);
    expect(JSON.parse(lines[0]!)).toEqual({ text: "héllo 🙂" });
  });

  it("strips the trailing CR on CRLF input", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n'));
    tap.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes a trailing unterminated line on end", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from('{"a":1}\n{"tail":true}'));
    tap.end();
    expect(lines).toEqual(['{"a":1}', '{"tail":true}']);
  });

  it("emits no extra line when the stream ends with a newline", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from('{"a":1}\n'));
    tap.end();
    expect(lines).toEqual(['{"a":1}']);
  });

  it("passes non-JSON lines through to the observer", () => {
    const { lines, tap } = collect();
    tap.push(Buffer.from("this is not json\n"));
    tap.end();
    expect(lines).toEqual(["this is not json"]);
  });
});
