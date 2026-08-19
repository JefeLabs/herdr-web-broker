/** One NDJSON frame per line. Over WebSockets each message is one frame and
 * this codec is not needed; it exists for raw socket transports. */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

const DEFAULT_MAX_BUF_BYTES = 1_048_576;

export class NdjsonDecoder {
  #buf = "";

  /** maxBufBytes caps the unterminated trailing buffer — callers with
   * legitimately larger single-line frames (e.g. a local, trusted herdr
   * socket) can raise it; the wire-facing default stays conservative. */
  constructor(private maxBufBytes = DEFAULT_MAX_BUF_BYTES) {}

  /** Feed a chunk; returns every complete frame it finishes. Throws on a
   * malformed line, or on an unterminated buffer past maxBufBytes — callers
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
    if (Buffer.byteLength(this.#buf) > this.maxBufBytes) {
      throw new Error(`ndjson line exceeds ${this.maxBufBytes} bytes without a newline`);
    }
    return frames;
  }
}
