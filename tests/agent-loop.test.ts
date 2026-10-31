import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, type AgentExecutor } from "../src/agent/loop.js";
import { DecisionLog } from "../src/agent/decision-log.js";
import type { FrameSource } from "../src/frames/frame-source.js";
import { FrameArchive } from "../src/frames/frame-archive.js";
import { OverlayServer } from "../src/overlay/server.js";

const directories: string[] = [];
const currentFrame = { timestampMs: 20_000, jpegBase64: "ZmFrZQ==", sha256: "frame-hash" };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function modelResponse(name: string, args: string, id: string): Response {
  return {
    id,
    output: [{ type: "function_call", call_id: `call-${id}`, name, arguments: args }],
    usage: { input_tokens: 10, output_tokens: 3 },
  } as unknown as Response;
}

describe("agent loop tool validation", () => {
  it.each([
    ["confirm_resolution", true],
    ["reject_resolution", false],
  ] as const)("settles a proposal only after the second-look model calls %s", async (confirmationTool, settles) => {
    const directory = await mkdtemp(join(tmpdir(), "callit-two-look-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const frames = [currentFrame];
    let nowMs = 20_000;
    let onFirstDecision!: () => void;
    let onSecondDecision!: () => void;
    const firstDecision = new Promise<void>((resolve) => { onFirstDecision = resolve; });
    const secondDecision = new Promise<void>((resolve) => { onSecondDecision = resolve; });
    const call = vi.fn()
      .mockResolvedValueOnce(modelResponse("resolve_bet", JSON.stringify({
        outcome_index: 0,
        evidence: "Glass-Backed Tide Wisp shows 0 HP in the newest frame.",
        reason: "The Glass-Backed Tide Wisp went down.",
      }), "proposal"))
      .mockResolvedValueOnce(modelResponse(confirmationTool, confirmationTool === "confirm_resolution" ? "{}" : JSON.stringify({ reason: "The newer frame shows the Tide Wisp alive." }), "second-look"));
    let activeBet: NonNullable<ReturnType<AgentExecutor["getAgentBetContext"]>["bet"]> | null = {
      status: "open",
      question: "Will Glass-Backed Tide Wisp be defeated?",
      outcomes: ["It dies", "It survives"],
      pools: [{ points: 100, bettors: 1 }, { points: 50, bettors: 1 }],
      openedAtMs: 9_000,
      expiresAtMs: 60_000,
    };
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: activeBet, lastOpenedAtMs: 9_000 }),
      overlayBet: () => activeBet ? { question: activeBet.question, outcomes: [{ title: "It dies", points: 100, bettors: 1 }, { title: "It survives", points: 50, bettors: 1 }], status: activeBet.status, secondsLeft: 0 } : null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(),
      lockBetForResolution: vi.fn(async (atMs: number) => {
        if (activeBet?.status === "open") {
          activeBet.status = "locked";
          activeBet.lockedAtMs = atMs;
        }
      }),
      resolveBet: vi.fn(async () => { activeBet = null; }),
      restoreBetStatus: vi.fn(async (status, lockedAtMs) => {
        if (activeBet) {
          activeBet.status = status;
          if (status === "open") delete activeBet.lockedAtMs;
          else activeBet.lockedAtMs = lockedAtMs;
        }
      }),
      cancelBet: vi.fn(), checkDeadlines: vi.fn(async () => null),
    };
    const overlay = new OverlayServer();
    const loop = new AgentLoop({
      frames: { latest: () => frames.slice(-3) },
      brain: { model: "gpt-5.4-mini", call },
      executor,
      decisions,
      overlay,
      frameArchive: new FrameArchive(join(directory, "frames")),
      tickSeconds: 0.01,
      clock: () => nowMs,
      onDecision: (entry) => {
        if (entry.tool === "resolve_bet") onFirstDecision();
        if (entry.tool === confirmationTool) onSecondDecision();
      },
    });

    loop.setLive(true);
    await firstDecision;
    expect(executor.resolveBet).not.toHaveBeenCalled();
    expect(overlay.getState().bet?.status).toBe("checking");
    await loop.stop();

    nowMs = 24_000;
    frames.push({ ...currentFrame, timestampMs: nowMs, sha256: "frame-hash-new" });
    loop.setLive(true);
    await secondDecision;
    await loop.stop();

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      pendingResolution: { outcome: "It dies", evidence: "Glass-Backed Tide Wisp shows 0 HP in the newest frame." },
      proposalFrames: [{ timestampMs: 20_000 }],
      frames: [{ timestampMs: 24_000 }],
      secondsUntilNewBetAllowed: 165,
    });
    expect(executor.resolveBet).toHaveBeenCalledTimes(settles ? 1 : 0);
    expect(executor.lockBetForResolution).toHaveBeenCalledTimes(1);
    expect(executor.lockBet).not.toHaveBeenCalled();
    expect(executor.restoreBetStatus).toHaveBeenCalledTimes(settles ? 0 : 1);
    if (!settles) expect(executor.restoreBetStatus).toHaveBeenCalledWith("open", undefined);
    const entries = (await readFile(decisions.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; arguments: { evidence?: string }; guardResult: string });
    expect(entries[0]).toMatchObject({ tool: "resolve_bet", arguments: { evidence: "Glass-Backed Tide Wisp shows 0 HP in the newest frame." }, guardResult: "accepted: pending second-look confirmation" });
    expect(entries[1]?.tool).toBe(confirmationTool);
    if (!settles) expect(overlay.getState().bet?.status).toBe("open");
  });

  it("returns one invalid action to the model and waits if the correction is still invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-loop-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn()
      .mockResolvedValueOnce(modelResponse("lock_bet", JSON.stringify({ reason: "lock it" }), "response-1"))
      .mockResolvedValueOnce(modelResponse("resolve_bet", JSON.stringify({ outcome_index: 0, evidence: "visible", reason: "The outcome is clear." }), "response-2"));
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }),
      overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(), lockBetForResolution: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
      checkDeadlines: vi.fn(async () => null),
    };
    const frames: FrameSource = { latest: () => [currentFrame] };
    const loop = new AgentLoop({
      frames,
      brain: { model: "gpt-5.4-mini", call },
      executor,
      decisions,
      overlay: new OverlayServer(),
      frameArchive: new FrameArchive(join(directory, "frames")),
      clock: () => 20_000,
    });

    await loop.tickOnce();

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[1]).toMatchObject({ previousResponseId: "response-1", outputs: [{ callId: "call-response-1" }] });
    expect(executor.resolveBet).not.toHaveBeenCalled();
    const row = JSON.parse(await readFile(decisions.filePath, "utf8")) as { tool: string; guardResult: string; inputTokens: number; outputTokens: number; frameFiles: string[] };
    expect(row.tool).toBe("wait");
    expect(row.guardResult).toContain("one correction");
    expect(row.inputTokens).toBe(20);
    expect(row.outputTokens).toBe(6);
    expect(row.frameFiles).toHaveLength(1);
  });

  it("drops a proposal after two failed confirmations and restores the previous status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-confirm-failed-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn()
      .mockResolvedValueOnce(modelResponse("resolve_bet", JSON.stringify({ outcome_index: 0, evidence: "Target is dead.", reason: "The target was defeated." }), "proposal"))
      .mockResolvedValueOnce(modelResponse("wait", "{}", "invalid-confirmation-1"))
      .mockRejectedValueOnce(new Error("temporary model failure"));
    let activeBet: NonNullable<ReturnType<AgentExecutor["getAgentBetContext"]>["bet"]> | null = {
      status: "open", question: "Will it be defeated?", outcomes: ["Yes", "No"],
      pools: [{ points: 10, bettors: 1 }, { points: 0, bettors: 0 }], openedAtMs: 1_000, expiresAtMs: 60_000,
    };
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: activeBet, lastOpenedAtMs: 1_000 }),
      overlayBet: () => activeBet ? { question: activeBet.question, outcomes: [], status: activeBet.status, secondsLeft: 0 } : null,
      setPaused: vi.fn(), setAdBreak: vi.fn(), openBet: vi.fn(), lockBet: vi.fn(),
      lockBetForResolution: vi.fn(async (atMs) => { if (activeBet) { activeBet.status = "locked"; activeBet.lockedAtMs = atMs; } }),
      resolveBet: vi.fn(),
      restoreBetStatus: vi.fn(async (status, lockedAtMs) => { if (activeBet) { activeBet.status = status; if (status === "open") delete activeBet.lockedAtMs; else activeBet.lockedAtMs = lockedAtMs; } }),
      cancelBet: vi.fn(), checkDeadlines: vi.fn(async () => null),
    };
    let frameIndex = 0;
    let notify!: () => void;
    const failed = new Promise<void>((resolve) => { notify = resolve; });
    const loop = new AgentLoop({
      frames: { latest: () => [{ ...currentFrame, timestampMs: Date.now(), sha256: `frame-${frameIndex++}` }] }, brain: { model: "gpt-5.4-mini", call }, executor, decisions,
      overlay: new OverlayServer(), frameArchive: new FrameArchive(join(directory, "frames")),
      tickSeconds: 0.01,
      onDecision: (entry) => { if (entry.tool === "confirmation_failed") notify(); },
    });
    loop.setLive(true);
    await failed;
    await loop.stop();

    expect(call).toHaveBeenCalledTimes(3);
    expect(executor.resolveBet).not.toHaveBeenCalled();
    expect(executor.restoreBetStatus).toHaveBeenCalledWith("open", undefined);
    expect(activeBet?.status).toBe("open");
    const rows = (await readFile(decisions.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string });
    expect(rows.at(-1)?.tool).toBe("confirmation_failed");
  });

  it("logs automatic timeouts without calling the model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-timeout-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn();
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }),
      overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(), lockBetForResolution: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
      checkDeadlines: vi.fn(async () => "timeout" as const),
    };
    const loop = new AgentLoop({
      frames: { latest: () => [] },
      brain: { model: "gpt-5.4-mini", call },
      executor,
      decisions,
      overlay: new OverlayServer(),
      clock: () => 20_000,
    });

    await loop.tickOnce();
    const row = JSON.parse(await readFile(decisions.filePath, "utf8")) as { tool: string; guardResult: string };
    expect(row).toMatchObject({ tool: "timeout", guardResult: "accepted: automatic bet deadline" });
    expect(call).not.toHaveBeenCalled();
  });

  it("stops at the model call budget and records the budget stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-budget-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn().mockResolvedValue(modelResponse("lock_bet", JSON.stringify({ reason: "lock now" }), "budget-invalid"));
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }), overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(), openBet: vi.fn(), lockBet: vi.fn(), lockBetForResolution: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
      checkDeadlines: vi.fn(async () => null),
    };
    const stopped = vi.fn();
    const loop = new AgentLoop({
      frames: { latest: () => [{ ...currentFrame }] }, brain: { model: "gpt-5.4-mini", call }, executor, decisions,
      overlay: new OverlayServer(), frameArchive: new FrameArchive(join(directory, "frames")), clock: () => 20_000,
      maxModelCalls: 1, onStop: stopped,
    });
    await loop.tickOnce();
    await loop.tickOnce();

    expect(call).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith("model call budget reached");
    const rows = (await readFile(decisions.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; guardResult: string });
    expect(rows.at(-1)).toMatchObject({ tool: "model_call_budget_reached", guardResult: "model call budget reached; no further model calls will be made" });
  });

  it("skips a tick when the newest frame hash is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-static-frame-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn().mockResolvedValue(modelResponse("wait", "{}", "static-wait"));
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }), overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(), openBet: vi.fn(), lockBet: vi.fn(), lockBetForResolution: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
      checkDeadlines: vi.fn(async () => null),
    };
    const loop = new AgentLoop({
      frames: { latest: () => [{ ...currentFrame }] }, brain: { model: "gpt-5.4-mini", call }, executor, decisions,
      overlay: new OverlayServer(), frameArchive: new FrameArchive(join(directory, "frames")), clock: () => 20_000,
    });
    await loop.tickOnce();
    await loop.tickOnce();

    expect(call).toHaveBeenCalledTimes(1);
    const rows = (await readFile(decisions.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; guardResult: string });
    expect(rows.at(-1)).toMatchObject({ tool: "skipped_tick", guardResult: "model call skipped: newest frame hash unchanged from previous tick" });
  });

  it.each([
    ["empty", []],
    ["stale", [{ ...currentFrame, timestampMs: 9_999 }]],
  ])("logs no_frames and skips the model for %s frames", async (_label, availableFrames) => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-no-frames-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn();
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }),
      overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(), lockBetForResolution: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
      checkDeadlines: vi.fn(async () => null),
    };
    const loop = new AgentLoop({
      frames: { latest: () => availableFrames } as FrameSource,
      brain: { model: "gpt-5.4-mini", call },
      executor,
      decisions,
      overlay: new OverlayServer(),
      clock: () => 20_000,
    });

    await loop.tickOnce();

    expect(call).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(decisions.filePath, "utf8"))).toMatchObject({
      tool: "no_frames",
      guardResult: "model call skipped: no current frame",
    });
  });
});
