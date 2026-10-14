import type { ReadResult, Stream } from "./types.ts";
import { StringDecoder } from "node:string_decoder";

/** A bounded byte ring with one stream bit per retained byte. Cursors count all bytes. */
export class OutputBuffer {
  private data = Buffer.alloc(0);
  private stderrBits = new Uint8Array(0);
  private storageCapacity = 0;
  totalBytes = 0;

  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("Output buffer capacity must be a positive safe integer");
    this.capacity = capacity;
  }

  get retainedFrom(): number {
    return Math.max(0, this.totalBytes - this.capacity);
  }

  append(stream: Stream, data: Buffer): void {
    if (!data.length) return;
    const totalBytes = this.totalBytes + data.length;
    if (!Number.isSafeInteger(totalBytes))
      throw new Error("Output byte cursor exceeded safe range");

    this.ensureStorage(Math.min(totalBytes, this.capacity));
    const retainedLength = Math.min(data.length, this.capacity);
    const sourceStart = data.length - retainedLength;
    const start = totalBytes - retainedLength;
    let copied = 0;
    while (copied < retainedLength) {
      const position = (start + copied) % this.storageCapacity;
      const length = Math.min(retainedLength - copied, this.storageCapacity - position);
      this.data.set(data.subarray(sourceStart + copied, sourceStart + copied + length), position);
      this.setStreamRange(position, length, stream);
      copied += length;
    }
    this.totalBytes = totalBytes;
  }

  read(cursor: number, maxBytes: number): ReadResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("Cursor must be a non-negative integer byte offset");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.capacity) {
      throw new Error("Invalid output read limit");
    }
    if (cursor > this.totalBytes) throw new Error("Cursor is beyond current output");
    const start = Math.max(cursor, this.retainedFrom);
    const end = start + Math.min(maxBytes, this.totalBytes - start);
    const chunks: ReadResult["chunks"] = [];
    for (let chunkStart = start; chunkStart < end; ) {
      const stream = this.streamAt(chunkStart);
      const chunkEnd = this.nextStreamChange(chunkStart, end, stream);
      chunks.push(this.readChunk(chunkStart, chunkEnd, stream));
      chunkStart = chunkEnd;
    }
    return {
      cursor,
      nextCursor: end,
      retainedFrom: this.retainedFrom,
      gap: cursor < this.retainedFrom,
      chunks,
    };
  }

  private streamAt(offset: number): Stream {
    const position = offset % this.storageCapacity;
    return this.stderrBits[position >> 3] & (1 << (position & 7)) ? "stderr" : "stdout";
  }

  private setStreamRange(start: number, length: number, stream: Stream): void {
    const end = start + length;
    let index = start;
    while (index < end && (index & 7) !== 0) this.setStreamBit(index++, stream);
    const fullByteEnd = end - (end & 7);
    if (index < fullByteEnd) {
      this.stderrBits.fill(stream === "stderr" ? 0xff : 0, index >> 3, fullByteEnd >> 3);
      index = fullByteEnd;
    }
    while (index < end) this.setStreamBit(index++, stream);
  }

  private setStreamBit(index: number, stream: Stream): void {
    const mask = 1 << (index & 7);
    const byte = index >> 3;
    this.stderrBits[byte] =
      stream === "stderr" ? this.stderrBits[byte] | mask : this.stderrBits[byte] & ~mask;
  }

  private nextStreamChange(start: number, end: number, stream: Stream): number {
    let absolute = start;
    while (absolute < end) {
      const ringStart = absolute % this.storageCapacity;
      const segmentLength = Math.min(end - absolute, this.storageCapacity - ringStart);
      const ringEnd = ringStart + segmentLength;
      let index = ringStart;
      while (index < ringEnd) {
        const bitIndex = index & 7;
        const available = Math.min(8 - bitIndex, ringEnd - index);
        const bits = this.stderrBits[index >> 3];
        let different = stream === "stderr" ? ~bits & 0xff : bits;
        different &= ((1 << available) - 1) << bitIndex;
        if (different) {
          let changedBit = bitIndex;
          while ((different & (1 << changedBit)) === 0) changedBit++;
          return absolute + index - ringStart + changedBit - bitIndex;
        }
        index += available;
      }
      absolute += segmentLength;
    }
    return end;
  }

  private readChunk(start: number, end: number, stream: Stream): ReadResult["chunks"][number] {
    const data = Buffer.alloc(end - start);
    let copied = 0;
    while (copied < data.length) {
      const position = (start + copied) % this.storageCapacity;
      const length = Math.min(data.length - copied, this.storageCapacity - position);
      this.data.copy(data, copied, position, position + length);
      copied += length;
    }
    return { stream, start, end, data };
  }

  private ensureStorage(required: number): void {
    if (required <= this.storageCapacity) return;
    const nextCapacity = Math.min(
      this.capacity,
      Math.max(required, this.storageCapacity === 0 ? 64 : this.storageCapacity * 2),
    );
    const nextData = Buffer.alloc(nextCapacity);
    const nextStderrBits = new Uint8Array(Math.ceil(nextCapacity / 8));
    const retainedStart = Math.max(0, this.totalBytes - this.storageCapacity);
    for (let offset = retainedStart; offset < this.totalBytes; offset++) {
      const previousPosition = offset % this.storageCapacity;
      const nextPosition = offset % nextCapacity;
      nextData[nextPosition] = this.data[previousPosition];
      if (this.stderrBits[previousPosition >> 3] & (1 << (previousPosition & 7)))
        nextStderrBits[nextPosition >> 3] |= 1 << (nextPosition & 7);
    }
    this.data = nextData;
    this.stderrBits = nextStderrBits;
    this.storageCapacity = nextCapacity;
  }
}

/** Decode each stream independently so UTF-8 sequences split across chunks stay intact. */
export function outputPreview(read: ReadResult): string {
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  const lines: string[] = [];
  for (const chunk of read.chunks) {
    const text = decoders[chunk.stream].write(chunk.data);
    if (text) lines.push(`[${chunk.stream}] ${text}`);
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const trailing = decoders[stream].end();
    if (trailing) lines.push(`[${stream}] ${trailing}`);
  }
  return lines.join("\n");
}
