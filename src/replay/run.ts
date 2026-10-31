import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentBrain } from "../agent/brain.js";
import { DecisionLog } from "../agent/decision-log.js";
import { AgentLoop } from "../agent/loop.js";
import { ReplayFrameSource } from "../frames/replay-frame-source.js";
import { OverlayServer } from "../overlay/server.js";
import { ReplayBetExecutor } from "./replay-executor.js";

export interface VodMetadata {
  vodId: string;
  channel: string;
  url: string;
  startedAt: string;
}

export interface ReplayOptions {
  brain?: Pick<AgentBrain, "model" | "call">;
  outputRoot?: string;
  tickSeconds?: number;
  log?: (message: string) => void;
}

export interface ReplayResult {
  vod: VodMetadata;
  directory: string;
  decisionCount: number;
  betCount: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  startedAtMs: number;
  endedAtMs: number;
}

export async function runReplay(folderArg: string, args: string[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const folder = resolve(folderArg);
  const vod = JSON.parse(await readFile(join(folder, "vod.json"), "utf8")) as VodMetadata;
  if (!vod.vodId || !vod.channel || !vod.url || !Number.isFinite(Date.parse(vod.startedAt))) throw new Error(`Invalid vod.json in ${folder}.`);
  const startedAtMs = Date.parse(vod.startedAt);
  const frames = await readdir(folder);
  const offsets = frames.filter((name) => /^\d+\.jpg$/i.test(name)).map((name) => Number.parseInt(name.slice(0, -4), 10));
  if (!offsets.length) throw new Error(`No <vodOffsetSeconds>.jpg frames in ${folder}.`);
  const flags = parseReplayFlags(args, Math.max(...offsets));
  const tickSeconds = options.tickSeconds ?? positive(Number(process.env.TICK_SECONDS), 4);
  const fromMs = startedAtMs + flags.fromSeconds * 1000;
  const toSeconds = flags.toSeconds;
  const totalTicks = Math.floor((toSeconds - flags.fromSeconds) / tickSeconds) + 1;
  let nowMs = fromMs;
  const clock = () => nowMs;
  const frameSource = await ReplayFrameSource.fromFolder(folder, clock, startedAtMs, startedAtMs);
  const suffix = flags.memoryOff ? "-nomemory" : "";
  const safeVodId = vod.vodId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const outputDirectory = resolve(options.outputRoot ?? join(process.cwd(), "eval", "runs"), `${safeVodId}${suffix}`);
  await mkdir(outputDirectory, { recursive: true });
  const decisions = new DecisionLog(join(outputDirectory, "decisions.jsonl"));
  await writeFile(decisions.filePath, "", "utf8");
  const overlay = new OverlayServer();
  const log = options.log ?? console.log;
  const executor = new ReplayBetExecutor(overlay, startedAtMs, log);
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let completedTicks = 0;
  const brain = options.brain ?? new AgentBrain();
  const loop = new AgentLoop({
    frames: frameSource,
    brain,
    executor,
    decisions,
    overlay,
    mode: "chat",
    memorySummary: "No stored channel memory summary yet.",
    clock,
    tickSeconds,
    archiveFrames: false,
    decisionMetadata: () => ({ vodOffsetSeconds: (nowMs - startedAtMs) / 1000 }),
    onModelCall: (usage) => {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    },
    onModelCallStart: () => { modelCalls += 1; },
  });
  await loop.runReplayTicks(totalTicks, () => {
    completedTicks += 1;
    if (completedTicks % 50 === 0) log(`Replay tick ${completedTicks}/${totalTicks}: ${modelCalls} model calls, ${inputTokens} input tokens, ${outputTokens} output tokens.`);
    nowMs += tickSeconds * 1000;
  });
  await writeFile(join(outputDirectory, "bets.json"), `${JSON.stringify(executor.bets, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "run.json"), `${JSON.stringify({ vod, memoryOff: flags.memoryOff, fromSeconds: flags.fromSeconds, toSeconds, tickSeconds, ticks: totalTicks }, null, 2)}\n`, "utf8");
  log(`Replay complete: ${modelCalls} model calls, ${inputTokens} input tokens, ${outputTokens} output tokens.`);
  return {
    vod,
    directory: outputDirectory,
    decisionCount: (await readFile(decisions.filePath, "utf8")).split(/\r?\n/).filter(Boolean).length,
    betCount: executor.bets.length,
    modelCalls,
    inputTokens,
    outputTokens,
    startedAtMs: fromMs,
    endedAtMs: nowMs,
  };
}

export function parseReplayFlags(args: string[], defaultToSeconds: number): { fromSeconds: number; toSeconds: number; memoryOff: boolean } {
  let fromSeconds = 0;
  let toSeconds = defaultToSeconds;
  let memoryOff = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--memory") {
      if (args[index + 1] !== "off") throw new Error("Only --memory off is supported.");
      memoryOff = true;
      index += 1;
    } else if (arg === "--from" || arg === "--to") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} must be a non-negative number of seconds.`);
      if (arg === "--from") fromSeconds = value;
      else toSeconds = value;
      index += 1;
    } else throw new Error(`Unknown replay option ${arg}.`);
  }
  if (toSeconds < fromSeconds) throw new Error("--to must be at or after --from.");
  return { fromSeconds, toSeconds, memoryOff };
}

function positive(value: number, fallback: number): number { return Number.isFinite(value) && value > 0 ? value : fallback; }
