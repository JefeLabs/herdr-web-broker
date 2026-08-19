/** One NDJSON frame per line. Over WebSockets each message is one frame and
 * this codec is not needed; it exists for raw socket transports. */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

const MAX_BUF_BYTES = 1_048_576;

export class NdjsonDecoder {
  #buf = "";

  /** Feed a chunk; returns every complete frame it finishes. Throws on a
   * malformed line, or on an unterminated buffer past MAX_BUF_BYTES — callers
   * should close the connection either way. */
  push(chunk: Buffer | string): unknown[] {
    this.#buf += chunk.toString();
    const frames: unknown[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 1);
      if (line.length === 0) continue;
      frames.push(JSON.parse(line));
    }
    if (Buffer.byteLength(this.#buf) > MAX_BUF_BYTES) {
      throw new Error(`ndjson line exceeds ${MAX_BUF_BYTES} bytes without a newline`);
    }
    return frames;
  }
}
