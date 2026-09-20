import { StringDecoder } from "node:string_decoder";

export class LineTap {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | Uint8Array): void {
    this.buffered += this.decoder.write(chunk);
    let index = this.buffered.indexOf("\n");
    while (index !== -1) {
      const line = this.buffered.slice(0, index);
      this.buffered = this.buffered.slice(index + 1);
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      index = this.buffered.indexOf("\n");
    }
  }

  end(): void {
    this.buffered += this.decoder.end();
    const line = this.buffered;
    this.buffered = "";
    if (line.length > 0) {
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }
}
