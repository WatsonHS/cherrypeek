import { TextDecoder } from "node:util";
import type { Readable } from "node:stream";

export class JsonLineFramer {
  private buffer = Buffer.allocUnsafe(4096);
  private frameBytes = 0;
  private closed = false;

  constructor(
    private readonly stream: Readable,
    private readonly onLine: (line: string) => void,
    private readonly onError: (error: Error) => void,
    private readonly maxFrameBytes = 1024 * 1024,
    private readonly onEnd?: () => void,
  ) {
    stream.on("data", this.handleData);
    stream.once("end", this.handleEnd);
    stream.once("error", this.handleStreamError);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.off("data", this.handleData);
    this.stream.off("end", this.handleEnd);
    this.stream.off("error", this.handleStreamError);
    this.buffer = Buffer.alloc(0);
    this.frameBytes = 0;
  }

  private handleData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let segmentStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      if (!this.append(data.subarray(segmentStart, index))) return;
      this.emitFrame();
      if (this.closed) return;
      segmentStart = index + 1;
    }
    if (segmentStart < data.length) this.append(data.subarray(segmentStart));
  };

  private append(part: Buffer): boolean {
    if (this.closed) return false;
    if (part.length === 0) return true;
    const nextLength = this.frameBytes + part.length;
    if (nextLength > this.maxFrameBytes + 1) {
      this.fail(new Error(`JSON line exceeds ${this.maxFrameBytes} byte limit`));
      return false;
    }
    if (nextLength > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < nextLength) capacity = Math.min(this.maxFrameBytes + 1, capacity * 2);
      const expanded = Buffer.allocUnsafe(capacity);
      this.buffer.copy(expanded, 0, 0, this.frameBytes);
      this.buffer = expanded;
    }
    part.copy(this.buffer, this.frameBytes);
    this.frameBytes = nextLength;
    return true;
  }

  private emitFrame(): void {
    let frame = this.buffer.subarray(0, this.frameBytes);
    this.frameBytes = 0;
    if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, frame.length - 1);
    if (frame.length > this.maxFrameBytes) {
      this.fail(new Error(`JSON line exceeds ${this.maxFrameBytes} byte limit`));
      return;
    }
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      this.onLine(line);
    } catch (error) {
      this.fail(new Error(`Invalid UTF-8 JSON line: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private handleEnd = (): void => {
    if (this.closed) return;
    if (this.frameBytes !== 0) this.fail(new Error("Stdout ended with an incomplete JSON line"));
    else {
      this.close();
      this.onEnd?.();
    }
  };

  private handleStreamError = (error: Error): void => this.fail(error);

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.onError(error);
  }
}
