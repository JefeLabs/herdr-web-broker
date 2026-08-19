/** One NDJSON frame per line. Over WebSockets each message is one frame and
 * this codec is not needed; it exists for raw socket transports. */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

export class NdjsonDecoder {
  #buf = "";

  /** Feed a chunk; returns every complete frame it finishes. Throws on a
   * malformed line — callers should close the connection. */
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
    return frames;
  }
}
