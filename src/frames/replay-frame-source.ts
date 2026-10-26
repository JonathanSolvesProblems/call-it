import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Frame, FrameSource } from "./frame-source.js";

export class ReplayFrameSource implements FrameSource {
  private readonly startedAtMs: number;
  private readonly frames: Frame[];

  private constructor(frames: Frame[], private readonly clock: () => number) {
    this.frames = frames;
    this.startedAtMs = clock();
  }

  static async fromFolder(folderPath: string, clock: () => number = Date.now): Promise<ReplayFrameSource> {
    const entries = await readdir(folderPath, { withFileTypes: true });
    const offsets = entries
      .filter((entry) => entry.isFile() && /^\d+\.jpg$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, offsetSeconds: Number.parseInt(entry.name.slice(0, -4), 10) }))
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds);

    const frames: Frame[] = [];
    for (const { name, offsetSeconds } of offsets) {
      const bytes = await readFile(join(folderPath, name));
      frames.push({
        timestampMs: offsetSeconds * 1000,
        jpegBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return new ReplayFrameSource(frames, clock);
  }

  latest(n: number): Frame[] {
    if (!Number.isInteger(n) || n < 0) throw new Error("Frame count must be a non-negative integer.");
    const elapsedMs = Math.max(0, this.clock() - this.startedAtMs);
    const available = this.frames.filter((frame) => frame.timestampMs <= elapsedMs);
    return available.slice(Math.max(0, available.length - n));
  }
}
