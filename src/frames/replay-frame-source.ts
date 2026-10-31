import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Frame, FrameSource } from "./frame-source.js";

export class ReplayFrameSource implements FrameSource {
  private readonly clockStartedAtMs: number;
  private readonly frames: Array<{ offsetMs: number; frame: Frame }>;

  private constructor(frames: Array<{ offsetMs: number; frame: Frame }>, private readonly clock: () => number, private readonly vodStartedAtMs: number, clockStartedAtMs: number) {
    this.frames = frames;
    this.clockStartedAtMs = clockStartedAtMs;
  }

  static async fromFolder(folderPath: string, clock: () => number = Date.now, vodStartedAtMs = 0, clockStartedAtMs = clock()): Promise<ReplayFrameSource> {
    const entries = await readdir(folderPath, { withFileTypes: true });
    const offsets = entries
      .filter((entry) => entry.isFile() && /^\d+\.jpg$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, offsetSeconds: Number.parseInt(entry.name.slice(0, -4), 10) }))
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds);

    const frames: Array<{ offsetMs: number; frame: Frame }> = [];
    for (const { name, offsetSeconds } of offsets) {
      const bytes = await readFile(join(folderPath, name));
      const offsetMs = offsetSeconds * 1000;
      frames.push({
        offsetMs,
        frame: {
          timestampMs: vodStartedAtMs + offsetMs,
          jpegBase64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    }
    return new ReplayFrameSource(frames, clock, vodStartedAtMs, clockStartedAtMs);
  }

  latest(n: number): Frame[] {
    if (!Number.isInteger(n) || n < 0) throw new Error("Frame count must be a non-negative integer.");
    const elapsedMs = Math.max(0, this.clock() - this.clockStartedAtMs);
    const available = this.frames.filter((item) => item.offsetMs <= elapsedMs);
    const selected: Frame[] = [];
    for (let i = available.length - 1; i >= 0 && selected.length < n; i -= 1) {
      const candidate = available[i]!.frame;
      const newer = selected.at(-1);
      if (!newer || newer.timestampMs - candidate.timestampMs >= 2000) selected.push(candidate);
    }
    return selected.reverse();
  }
}
