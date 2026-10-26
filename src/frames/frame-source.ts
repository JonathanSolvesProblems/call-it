export interface Frame {
  timestampMs: number;
  jpegBase64: string;
  sha256: string;
}

export interface FrameSource {
  latest(n: number): Frame[];
}

export class FrameRingBuffer<T> {
  private readonly items: T[] = [];

  constructor(readonly capacity = 5) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Frame ring buffer capacity must be a positive integer.");
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  latest(n: number): T[] {
    if (!Number.isInteger(n) || n < 0) throw new Error("Frame count must be a non-negative integer.");
    return this.items.slice(Math.max(0, this.items.length - n));
  }
}
