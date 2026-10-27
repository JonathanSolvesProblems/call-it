import { createHash } from "node:crypto";
import OBSWebSocket from "obs-websocket-js";
import { setTimeout as delay } from "node:timers/promises";
import { FrameRingBuffer, type Frame, type FrameSource } from "./frame-source.js";

interface ObsFrameSourceOptions {
  url?: string;
  password?: string;
  frameSeconds?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export class ObsFrameSource implements FrameSource {
  private readonly obs = new OBSWebSocket();
  private readonly frames = new FrameRingBuffer<Frame>(5);
  private readonly url: string;
  private readonly password: string | undefined;
  private readonly frameSeconds: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private connected = false;
  private stopped = true;
  private nextRetryAtMs = 0;
  private loopPromise?: Promise<void>;

  constructor(options: ObsFrameSourceOptions = {}) {
    this.url = options.url ?? process.env.OBS_WS_URL ?? "ws://127.0.0.1:4455";
    this.password = options.password ?? process.env.OBS_WS_PASSWORD;
    this.frameSeconds = options.frameSeconds ?? parsePositiveNumber(process.env.FRAME_SECONDS, 2);
    this.logger = options.logger ?? console;
    this.obs.on("ConnectionClosed", (error) => {
      this.connected = false;
      this.nextRetryAtMs = Date.now() + 5000;
      if (!this.stopped) this.logger.warn(`OBS disconnected: ${error.message}. Retrying in 5 seconds.`);
    });
  }

  latest(n: number): Frame[] {
    return this.frames.latest(n);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.captureLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.connected) {
      try { await this.obs.disconnect(); } catch { /* The socket may already be closed. */ }
    }
    await this.loopPromise;
  }

  private async captureLoop(): Promise<void> {
    while (!this.stopped) {
      if (!this.connected && this.nextRetryAtMs > Date.now()) {
        await delay(this.nextRetryAtMs - Date.now());
        if (this.stopped) break;
      }
      try {
        if (!this.connected) {
          await this.obs.connect(this.url, this.password);
          this.connected = true;
          this.nextRetryAtMs = 0;
          this.logger.info(`Connected to OBS at ${this.url}.`);
        }

        const startedAt = Date.now();
        const { currentProgramSceneName } = await this.obs.call("GetCurrentProgramScene");
        const { imageData } = await this.obs.call("GetSourceScreenshot", {
          sourceName: currentProgramSceneName,
          imageFormat: "jpg",
          imageWidth: parsePositiveNumber(process.env.OBS_FRAME_WIDTH, 1280),
          imageCompressionQuality: 70,
        });
        const jpegBase64 = imageData.replace(/^data:image\/jpeg;base64,/, "");
        const bytes = Buffer.from(jpegBase64, "base64");
        this.frames.push({
          timestampMs: Date.now(),
          jpegBase64,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        await delay(Math.max(0, this.frameSeconds * 1000 - (Date.now() - startedAt)));
      } catch (error) {
        this.connected = false;
        this.nextRetryAtMs = Date.now() + 5000;
        this.logger.warn(`OBS frame capture failed: ${errorMessage(error)}. Retrying in 5 seconds.`);
        if (this.stopped) break;
        try { await this.obs.disconnect(); } catch { /* Ignore a socket that is already closed. */ }
        await delay(5000);
      }
    }
  }
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
