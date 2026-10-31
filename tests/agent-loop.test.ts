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
      status: "locked",
      question: "Will Glass-Backed Tide Wisp be defeated?",
      outcomes: ["It dies", "It survives"],
      pools: [{ points: 100, bettors: 1 }, { points: 50, bettors: 1 }],
      openedAtMs: 9_000,
      lockedAtMs: 15_000,
      expiresAtMs: 60_000,
    };
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: activeBet, lastOpenedAtMs: 9_000 }),
      overlayBet: () => activeBet ? { question: activeBet.question, outcomes: [{ title: "It dies", points: 100, bettors: 1 }, { title: "It survives", points: 50, bettors: 1 }], status: activeBet.status, secondsLeft: 0 } : null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(),
      resolveBet: vi.fn(async () => { activeBet = null; }),
      restoreBetStatus: vi.fn(),
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
      frames: [{ timestampMs: 24_000 }],
      secondsUntilNewBetAllowed: 165,
    });
    expect(executor.resolveBet).toHaveBeenCalledTimes(settles ? 1 : 0);
    expect(executor.restoreBetStatus).toHaveBeenCalledTimes(settles ? 0 : 1);
    if (!settles) expect(executor.restoreBetStatus).toHaveBeenCalledWith("locked", 15_000);
    const entries = (await readFile(decisions.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; arguments: { evidence?: string }; guardResult: string });
    expect(entries[0]).toMatchObject({ tool: "resolve_bet", arguments: { evidence: "Glass-Backed Tide Wisp shows 0 HP in the newest frame." }, guardResult: "accepted: pending second-look confirmation" });
    expect(entries[1]?.tool).toBe(confirmationTool);
    if (!settles) expect(overlay.getState().bet?.status).toBe("locked");
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
      openBet: vi.fn(), lockBet: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
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

  it("logs automatic timeouts without calling the model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "callit-agent-timeout-"));
    directories.push(directory);
    const decisions = new DecisionLog(join(directory, "decisions.jsonl"));
    const call = vi.fn();
    const executor: AgentExecutor = {
      getAgentBetContext: () => ({ bet: null, lastOpenedAtMs: null }),
      overlayBet: () => null,
      setPaused: vi.fn(), setAdBreak: vi.fn(),
      openBet: vi.fn(), lockBet: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
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
      openBet: vi.fn(), lockBet: vi.fn(), resolveBet: vi.fn(), restoreBetStatus: vi.fn(), cancelBet: vi.fn(),
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
