import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { LineTap } from "./line-tap.js";
import {
  createWireRecord,
  newRecordingId,
  type McpWireDirection,
  type McpWireRecord,
} from "./wire-record.js";

export interface StdioProxyOptions {
  command: string;
  args?: string[];
  input: Readable;
  output: Writable;
  stderr?: Writable;
  recordingId?: string;
  onRecord?: (record: McpWireRecord) => void;
}

export interface StdioProxyResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  records: McpWireRecord[];
}

export function runStdioProxy(options: StdioProxyOptions): Promise<StdioProxyResult> {
  const { command, args = [], input, output, stderr, onRecord } = options;
  const recordingId = options.recordingId ?? newRecordingId();
  const records: McpWireRecord[] = [];
  let sequence = 0;

  const emit = (direction: McpWireDirection, raw: string): void => {
    const record = createWireRecord({ recordingId, sequence, direction, raw });
    sequence += 1;
    records.push(record);
    onRecord?.(record);
  };

  const clientTap = new LineTap((line) => emit("client_to_server", line));
  const serverTap = new LineTap((line) => emit("server_to_client", line));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", stderr ? "pipe" : "inherit"],
    });

    const onInputData = (chunk: Buffer | string): void => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      clientTap.push(data);
      if (child.stdin && !child.stdin.write(data)) input.pause();
    };
    const onInputEnd = (): void => {
      clientTap.end();
      child.stdin?.end();
    };
    const onInputError = (): void => {
      child.kill();
    };
    const onChildStdout = (chunk: Buffer): void => {
      serverTap.push(chunk);
      if (!output.write(chunk)) child.stdout?.pause();
    };
    const onChildStdoutEnd = (): void => {
      serverTap.end();
    };
    const onOutputDrain = (): void => {
      child.stdout?.resume();
    };
    const onStdinDrain = (): void => {
      input.resume();
    };
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");

    const cleanup = (): void => {
      input.off("data", onInputData);
      input.off("end", onInputEnd);
      input.off("error", onInputError);
      output.off("drain", onOutputDrain);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      input.pause();
      (input as Readable & { unref?: () => void }).unref?.();
    };

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clientTap.end();
      serverTap.end();
      cleanup();
      fn();
    };

    child.once("error", (err) => settle(() => reject(err)));
    child.once("close", (code, signal) =>
      settle(() => resolve({ exitCode: code, signal, records })),
    );

    child.stdin?.on("error", () => {});
    child.stdin?.on("drain", onStdinDrain);
    child.stdout?.on("data", onChildStdout);
    child.stdout?.on("end", onChildStdoutEnd);
    if (stderr && child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
    }
    output.on("drain", onOutputDrain);
    input.on("data", onInputData);
    input.on("end", onInputEnd);
    input.on("error", onInputError);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}
