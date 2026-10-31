import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Frame } from "./frame-source.js";

export class FrameArchive {
  constructor(private readonly directory = join(process.cwd(), "data", "frames"), private readonly limit = 2000) {}

  async save(frames: Frame[]): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    const paths: string[] = [];
    for (const frame of frames) {
      const filename = `${String(frame.timestampMs).padStart(13, "0")}.jpg`;
      await writeFile(join(this.directory, filename), Buffer.from(frame.jpegBase64, "base64"));
      paths.push(join("data", "frames", filename).replaceAll("\\", "/"));
    }
    const files = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d+\.jpg$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => Number(right.slice(0, -4)) - Number(left.slice(0, -4)));
    await Promise.all(files.slice(this.limit).map((filename) => rm(join(this.directory, filename), { force: true })));
    return paths;
  }
}
