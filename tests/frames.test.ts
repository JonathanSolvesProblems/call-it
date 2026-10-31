import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FrameRingBuffer } from "../src/frames/frame-source.js";
import { ReplayFrameSource } from "../src/frames/replay-frame-source.js";
import { stripImageDataPrefix } from "../src/frames/obs-frame-source.js";
import { FrameArchive } from "../src/frames/frame-archive.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("frame sources", () => {
  it("keeps only the newest entries in the ring buffer", () => {
    const frames = new FrameRingBuffer<number>(3);
    frames.push(1);
    frames.push(2);
    frames.push(3);
    frames.push(4);
    expect(frames.latest(2)).toEqual([3, 4]);
    expect(frames.latest(5)).toEqual([2, 3, 4]);
    expect(frames.latest(0)).toEqual([]);
  });

  it("strips the jpg data URL prefix returned by OBS", () => {
    expect(stripImageDataPrefix("data:image/jpg;base64,ZmFrZQ==")).toBe("ZmFrZQ==");
  });

  it("archives frames with timestamps and keeps only the configured newest count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-frame-archive-"));
    tempDirectories.push(directory);
    const archive = new FrameArchive(directory, 2);
    const saved = await archive.save([0, 1, 2].map((timestampMs) => ({
      timestampMs: 1000 + timestampMs,
      jpegBase64: Buffer.from(`frame-${timestampMs}`).toString("base64"),
      sha256: `hash-${timestampMs}`,
    })));
    expect(saved).toEqual(["data/frames/0000000001000.jpg", "data/frames/0000000001001.jpg", "data/frames/0000000001002.jpg"]);
    expect((await readdir(directory)).sort()).toEqual(["0000000001001.jpg", "0000000001002.jpg"]);
  });

  it("serves replay frames according to the injected clock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-replay-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "000000.jpg"), Buffer.from("frame zero"));
    await writeFile(join(directory, "000002.jpg"), Buffer.from("frame two"));
    await writeFile(join(directory, "000005.jpg"), Buffer.from("frame five"));
    await writeFile(join(directory, "notes.txt"), "ignored");
    let now = 1000;

    const replay = await ReplayFrameSource.fromFolder(directory, () => now);
    expect(replay.latest(3).map((frame) => frame.timestampMs)).toEqual([0]);
    now = 2999;
    expect(replay.latest(3).map((frame) => frame.timestampMs)).toEqual([0]);
    now = 3000;
    expect(replay.latest(3).map((frame) => frame.timestampMs)).toEqual([0, 2000]);
    now = 6000;
    expect(replay.latest(2).map((frame) => frame.timestampMs)).toEqual([2000, 5000]);
  });
});
