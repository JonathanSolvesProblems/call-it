import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ObsFrameSource } from "./obs-frame-source.js";

const source = new ObsFrameSource();
const startedAt = Date.now();
source.start();

try {
  while (source.latest(1).length === 0) {
    if (Date.now() - startedAt > 30_000) throw new Error("Timed out waiting for an OBS frame after 30 seconds.");
    await delay(100);
  }
  const frame = source.latest(1)[0];
  if (!frame) throw new Error("OBS did not return a frame.");
  const output = join(process.cwd(), "tmp", "frame.jpg");
  await mkdir(join(process.cwd(), "tmp"), { recursive: true });
  const bytes = Buffer.from(frame.jpegBase64, "base64");
  await writeFile(output, bytes);
  console.log(`Saved ${output}: ${bytes.byteLength} bytes, grabbed in ${Date.now() - startedAt} ms.`);
} finally {
  await source.stop();
}
