import { setTimeout as delay } from "node:timers/promises";
import type { FrameSource } from "../frames/frame-source.js";
import { FrameArchive } from "../frames/frame-archive.js";
import type { OverlayServer } from "../overlay/server.js";
import { AgentBrain, functionCalls, type FunctionCall } from "./brain.js";
import { DecisionLog, type DecisionEntry } from "./decision-log.js";
import { validateAction } from "./guards.js";
import type { ActiveBetContext, AgentAction, AgentContext, OpenBetAction } from "./types.js";

export interface AgentExecutor {
  getAgentBetContext(nowMs: number): { bet: ActiveBetContext | null; lastOpenedAtMs: number | null };
  overlayBet(nowMs: number): ReturnType<OverlayServer["getState"]>["bet"];
  setPaused(paused: boolean): void;
  setAdBreak(adBreak: boolean): void;
  openBet(action: OpenBetAction, nowMs: number): Promise<void>;
  lockBet(reason: string, nowMs: number): Promise<void>;
  resolveBet(outcomeIndex: number, evidence: string, reason: string, nowMs: number): Promise<void>;
  restoreBetStatus(status: "open" | "locked", lockedAtMs?: number): Promise<void>;
  cancelBet(reason: string, nowMs: number): Promise<void>;
  checkDeadlines(nowMs: number, maxBetSeconds: number, resolutionPending?: boolean): Promise<"timeout" | "window_end" | null>;
}

export interface AgentLoopOptions {
  frames: FrameSource;
  brain: Pick<AgentBrain, "model" | "call">;
  executor: AgentExecutor;
  decisions: DecisionLog;
  overlay: OverlayServer;
  tickSeconds?: number;
  minGapSeconds?: number;
  maxBetSeconds?: number;
  memorySummary?: string;
  mode?: "chat" | "native";
  frameArchive?: FrameArchive;
  clock?: () => number;
  onDecision?: (entry: DecisionEntry) => void;
}

export class AgentLoop {
  private live = false;
  private paused = false;
  private adBreak = false;
  private worker: Promise<void> | undefined;
  private readonly clock: () => number;
  private readonly tickSeconds: number;
  private readonly minGapSeconds: number;
  private readonly maxBetSeconds: number;
  private readonly mode: "chat" | "native";
  private readonly frameArchive: FrameArchive;
  private pendingResolution: NonNullable<AgentContext["pendingResolution"]> | undefined;
  private nextTickAtMs = 0;

  constructor(private readonly options: AgentLoopOptions) {
    this.clock = options.clock ?? Date.now;
    this.tickSeconds = positiveNumber(options.tickSeconds ?? Number(process.env.TICK_SECONDS), 4);
    this.minGapSeconds = positiveNumber(options.minGapSeconds ?? Number(process.env.MIN_GAP_SECONDS), 180);
    this.maxBetSeconds = positiveNumber(options.maxBetSeconds ?? Number(process.env.MAX_BET_SECONDS), 900);
    this.mode = options.mode ?? "chat";
    this.frameArchive = options.frameArchive ?? new FrameArchive();
  }

  setLive(live: boolean): void {
    this.live = live;
    if (live && !this.worker) {
      this.worker = this.run().finally(() => {
        this.worker = undefined;
        if (this.live) this.setLive(true);
      });
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.options.executor.setPaused(paused);
  }

  setAdBreak(active: boolean): void {
    this.adBreak = active;
    this.options.executor.setAdBreak(active);
  }

  status(): "offline" | "paused" | "ad break" | "running" {
    if (!this.live) return "offline";
    if (this.paused) return "paused";
    if (this.adBreak) return "ad break";
    return "running";
  }

  async stop(): Promise<void> {
    this.live = false;
    await this.worker;
  }

  async tickOnce(): Promise<void> {
    await this.runTick();
  }

  private async run(): Promise<void> {
    while (this.live) {
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      await this.runTick();
      if (this.live) await delay(Math.max(0, this.nextTickAtMs - this.clock()));
    }
  }

  private async runTick(): Promise<void> {
    const tickStartedAt = this.clock();
    const frames = this.options.frames.latest(3);
    let frameHashes = frames.map((frame) => frame.sha256);
    let frameFiles: string[] = [];
    const deadline = await this.options.executor.checkDeadlines(tickStartedAt, this.maxBetSeconds, Boolean(this.pendingResolution));
    if (deadline) {
      if (deadline === "timeout") this.pendingResolution = undefined;
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: deadline, arguments: {}, guardResult: "accepted: automatic bet deadline", latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, deadline === "timeout" ? "Bet timed out and was refunded." : "Bet window ended and was locked.");
      return;
    }

    if (this.paused || this.adBreak) {
      const status = this.adBreak ? "ad_break" : "paused";
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: status, arguments: {}, guardResult: "model call skipped", latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, this.adBreak ? "Ad break active. Waiting before the next model call." : "Paused by the streamer.");
      return;
    }

    const newestFrame = frames.at(-1);
    if (!newestFrame || tickStartedAt - newestFrame.timestampMs > 10_000) {
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: "no_frames", arguments: {}, guardResult: "model call skipped: no current frame", latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, "No current frame is available. Waiting for OBS.");
      return;
    }

    const framesForModel = this.pendingResolution
      ? frames.filter((frame) => frame.timestampMs > this.pendingResolution!.latestFrameTimestampMs)
      : frames;
    if (this.pendingResolution && framesForModel.length === 0) {
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes: [], frameFiles, model: this.options.brain.model,
        tool: "awaiting_confirmation_frame", arguments: { outcome_index: this.pendingResolution.outcomeIndex },
        guardResult: "model call skipped: waiting for a frame newer than the proposal", latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, "Checking the result when a new frame arrives.");
      return;
    }
    frameHashes = framesForModel.map((frame) => frame.sha256);

    try {
      frameFiles = await this.frameArchive.save(framesForModel);
    } catch (error) {
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: "frame_archive_error", arguments: {}, guardResult: `model call skipped: could not archive frames: ${errorMessage(error)}`,
        latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, "Could not save the current frames. Waiting for the next tick.");
      return;
    }

    const betContext = this.options.executor.getAgentBetContext(tickStartedAt);
    const secondsUntilNewBetAllowed = betContext.lastOpenedAtMs === null
      ? 0
      : Math.max(0, Math.ceil((betContext.lastOpenedAtMs + this.minGapSeconds * 1000 - tickStartedAt) / 1000));
    const context: AgentContext = {
      nowMs: tickStartedAt,
      mode: this.mode,
      frames: framesForModel,
      bet: betContext.bet,
      lastOpenedAtMs: betContext.lastOpenedAtMs,
      decisions: this.options.decisions.latest().map((decision) => ({
        timestamp: decision.timestamp,
        tool: decision.tool,
        arguments: decision.arguments,
        guardResult: decision.guardResult,
      })),
      memorySummary: this.options.memorySummary ?? "No stored channel memory summary yet.",
      adBreak: this.adBreak,
      secondsUntilNewBetAllowed,
      ...(this.pendingResolution ? { pendingResolution: this.pendingResolution } : {}),
    };
    if (this.pendingResolution) {
      if (!context.bet) {
        this.pendingResolution = undefined;
        await this.record({
          timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
          tool: "reject_resolution", arguments: { reason: "The bet is no longer active." },
          guardResult: "pending resolution discarded because the bet is no longer active", latencyMs: 0, inputTokens: 0, outputTokens: 0,
        }, "The pending result was cleared because its bet is no longer active.");
        return;
      }
      await this.confirmPendingResolution(context, frameHashes, frameFiles);
      return;
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let modelLatencyMs = 0;
    let tool = "wait";
    let args: unknown = {};
    let guardResult = "model returned no function_call; treated as wait";
    let reason = "Waiting for a clearer moment.";
    let correctionError: string | undefined;

    try {
      let modelCallStartedAt = this.clock();
      let response = await this.options.brain.call(context);
      modelLatencyMs += Math.max(0, this.clock() - modelCallStartedAt);
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      let calls = functionCalls(response);
      let decoded = calls.length === 1 ? decodeCall(calls[0]!) : undefined;
      let validationError = calls.length === 0
        ? "Model returned no function_call."
        : calls.length !== 1
          ? "Exactly one function call is required per tick."
          : decoded?.error;
      if (decoded?.action) {
        const current = this.options.executor.getAgentBetContext(this.clock());
        const guardTime = this.clock();
        validationError = validateAction(decoded.action, {
          nowMs: guardTime,
          mode: this.mode,
          bet: current.bet,
          lastOpenedAtMs: current.lastOpenedAtMs,
          minGapSeconds: this.minGapSeconds,
          live: this.live,
          paused: this.paused,
          adBreak: this.adBreak,
          frameTimestampsMs: context.frames.map((frame) => frame.timestampMs),
        }) ?? undefined;
      }

      if (calls.length > 1 || (calls.length === 1 && validationError && decoded?.call)) {
        const correction = calls.length > 1 ? "Exactly one function call is required per tick." : validationError ?? "Invalid tool call.";
        correctionError = correction;
        modelCallStartedAt = this.clock();
        response = await this.options.brain.call(context, {
          previousResponseId: response.id,
          outputs: calls.map((call) => ({ callId: call.callId, error: correction })),
        });
        modelLatencyMs += Math.max(0, this.clock() - modelCallStartedAt);
        this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
        inputTokens += response.usage?.input_tokens ?? 0;
        outputTokens += response.usage?.output_tokens ?? 0;
        calls = functionCalls(response);
        decoded = calls.length === 1 ? decodeCall(calls[0]!) : undefined;
        validationError = calls.length === 0
          ? "Correction response returned no function_call; treated as wait."
          : calls.length !== 1
            ? "Correction response returned more than one function_call; treated as wait."
            : decoded?.error;
        if (decoded?.action) {
          const guardTime = this.clock();
          const correctedContext = this.options.executor.getAgentBetContext(guardTime);
          validationError = validateAction(decoded.action, {
            nowMs: guardTime, bet: correctedContext.bet, lastOpenedAtMs: correctedContext.lastOpenedAtMs,
            mode: this.mode,
            minGapSeconds: this.minGapSeconds, live: this.live, paused: this.paused, adBreak: this.adBreak,
            frameTimestampsMs: context.frames.map((frame) => frame.timestampMs),
          }) ?? undefined;
        }
      }

      if (calls.length === 1 && decoded?.action && !validationError) {
        const action = decoded.action;
        tool = action.tool;
        args = action.arguments;
        reason = reasonFor(action);
        guardResult = correctionError ? `accepted after one correction: ${correctionError}` : "accepted";
        if (action.tool === "resolve_bet") {
          const activeBet = this.options.executor.getAgentBetContext(this.clock()).bet;
          if (activeBet) {
            this.pendingResolution = {
              outcomeIndex: action.arguments.outcome_index,
              outcome: activeBet.outcomes[action.arguments.outcome_index]!,
              evidence: action.arguments.evidence,
              reason: action.arguments.reason,
              proposedAtMs: this.clock(),
              previousStatus: activeBet.status,
              ...(activeBet.lockedAtMs === undefined ? {} : { previousLockedAtMs: activeBet.lockedAtMs }),
              latestFrameTimestampMs: Math.max(...context.frames.map((frame) => frame.timestampMs)),
            };
            guardResult = "accepted: pending second-look confirmation";
            reason = "Checking the proposed result.";
          }
        } else {
          try {
            await this.execute(action, this.clock());
          } catch (error) {
            guardResult = `accepted; execution failed: ${errorMessage(error)}`;
          }
        }
        if (action.tool === "cancel_bet" && /scene (?:has )?left|left the scene|scene changed|left the moment/i.test(action.arguments.reason)) {
          guardResult += "; accepted scene-left exception";
        }
      } else if (calls.length === 1 && decoded?.call) {
        tool = "wait";
        args = { rejectedTool: decoded.call.name, rejectedArguments: decoded.call.arguments };
        guardResult = `invalid call after one correction: ${correctionError ?? "invalid action"}; second error: ${validationError ?? "invalid action"}; treated as wait`;
      } else if (calls.length > 1) {
        guardResult = "multiple function_call items after correction; treated as wait";
      } else if (validationError) {
        guardResult = validationError;
      }
    } catch (error) {
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      tool = "error";
      args = {};
      guardResult = `model call failed: ${errorMessage(error)}`;
      reason = "Model call failed. Waiting for the next tick.";
    }

    await this.record({
      timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model, tool, arguments: args,
      guardResult, latencyMs: modelLatencyMs, inputTokens, outputTokens,
    }, reason);
  }

  private async execute(action: AgentAction, nowMs: number): Promise<void> {
    switch (action.tool) {
      case "wait": return;
      case "open_bet": return this.options.executor.openBet(action.arguments, nowMs);
      case "lock_bet": return this.options.executor.lockBet(action.arguments.reason, nowMs);
      case "resolve_bet": return this.options.executor.resolveBet(action.arguments.outcome_index, action.arguments.evidence, action.arguments.reason, nowMs);
      case "cancel_bet": return this.options.executor.cancelBet(action.arguments.reason, nowMs);
    }
  }

  private async record(entry: DecisionEntry, reason: string): Promise<void> {
    await this.options.decisions.append(entry);
    const latestFrame = this.options.frames.latest(1)[0];
    this.options.overlay.update({
      bet: this.overlayBet(this.clock()),
      lastDecisionReason: reason,
      decisions: this.options.decisions.latest().map((decision) => ({ timestampMs: Date.parse(decision.timestamp), reason: reasonFromEntry(decision) })),
      ...(latestFrame ? { latestFrameJpegBase64: latestFrame.jpegBase64 } : {}),
    });
    this.options.onDecision?.(entry);
  }

  private overlayBet(nowMs: number): ReturnType<OverlayServer["getState"]>["bet"] {
    const bet = this.options.executor.overlayBet(nowMs);
    return bet && this.pendingResolution
      ? { ...bet, status: "checking", proposedOutcomeIndex: this.pendingResolution.outcomeIndex }
      : bet;
  }

  private async confirmPendingResolution(
    context: AgentContext,
    frameHashes: string[],
    frameFiles: string[],
  ): Promise<void> {
    const startedAt = this.clock();
    try {
      const response = await this.options.brain.call(context);
      const latencyMs = Math.max(0, this.clock() - startedAt);
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      const decision = decodeConfirmation(functionCalls(response));
      const pending = this.pendingResolution;
      if (!pending) return;
      if (decision.status === "invalid") {
        await this.record({
          timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
          tool: "resolution_confirmation_invalid", arguments: { outcome_index: pending.outcomeIndex, evidence: pending.evidence },
          guardResult: "model did not call confirm_resolution or reject_resolution; proposal remains pending",
          latencyMs, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        }, "The proposed result is still being checked.");
        return;
      }
      if (decision.status === "confirm") {
        this.pendingResolution = undefined;
        let guardResult = "model confirmed the exact subject and outcome using newer frames";
        try {
          await this.options.executor.resolveBet(pending.outcomeIndex, pending.evidence, pending.reason, this.clock());
        } catch (error) {
          guardResult = `model confirmed; settlement failed: ${errorMessage(error)}`;
        }
        await this.record({
          timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
          tool: "confirm_resolution",
          arguments: { outcome_index: pending.outcomeIndex, outcome: pending.outcome, evidence: pending.evidence, reason: pending.reason },
          guardResult, latencyMs, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        }, pending.reason);
        return;
      }

      await this.options.executor.restoreBetStatus(pending.previousStatus, pending.previousLockedAtMs);
      this.pendingResolution = undefined;
      await this.record({
        timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: "reject_resolution",
        arguments: { reason: decision.reason, outcome_index: pending.outcomeIndex, outcome: pending.outcome, evidence: pending.evidence },
        guardResult: "model rejected the proposed resolution; bet returned to its previous status",
        latencyMs, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
      }, decision.reason);
    } catch (error) {
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      const pending = this.pendingResolution;
      await this.record({
        timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: "resolution_confirmation_error", arguments: pending ? { outcome_index: pending.outcomeIndex, evidence: pending.evidence } : {},
        guardResult: `model confirmation failed; proposal remains pending: ${errorMessage(error)}`,
        latencyMs: Math.max(0, this.clock() - startedAt), inputTokens: 0, outputTokens: 0,
      }, "The proposed result is still being checked.");
    }
  }
}

function decodeCall(call: FunctionCall | undefined): { call?: FunctionCall; action?: AgentAction; error?: string } | undefined {
  if (!call) return undefined;
  let args: unknown;
  try { args = JSON.parse(call.arguments); }
  catch { return { call, error: "Arguments are not valid JSON." }; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { call, error: "Arguments must be a JSON object." };
  const value = args as Record<string, unknown>;
  if (call.name === "wait") return { call, action: { tool: "wait", arguments: {} } };
  if (call.name === "open_bet" && typeof value.question === "string" && Array.isArray(value.outcomes) && value.outcomes.every((item) => typeof item === "string") && typeof value.window_seconds === "number" && typeof value.reason === "string") {
    return { call, action: { tool: "open_bet", arguments: { question: value.question, outcomes: value.outcomes as string[], window_seconds: value.window_seconds, reason: value.reason } } };
  }
  if (call.name === "lock_bet" && typeof value.reason === "string") return { call, action: { tool: "lock_bet", arguments: { reason: value.reason } } };
  if (call.name === "resolve_bet" && typeof value.outcome_index === "number" && typeof value.evidence === "string" && typeof value.reason === "string") return { call, action: { tool: "resolve_bet", arguments: { outcome_index: value.outcome_index, evidence: value.evidence, reason: value.reason } } };
  if (call.name === "cancel_bet" && typeof value.reason === "string") return { call, action: { tool: "cancel_bet", arguments: { reason: value.reason } } };
  return { call, error: `Unknown tool or invalid arguments for ${call.name}.` };
}

function decodeConfirmation(calls: FunctionCall[]): { status: "confirm" } | { status: "reject"; reason: string } | { status: "invalid" } {
  if (calls.length === 1) {
    const call = calls[0]!;
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (call.name === "confirm_resolution" && args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0) {
        return { status: "confirm" };
      }
      if (call.name === "reject_resolution" && args && typeof args === "object" && !Array.isArray(args)) {
        const reason = (args as Record<string, unknown>).reason;
        if (typeof reason === "string" && reason.trim()) return { status: "reject", reason };
      }
    } catch { /* Invalid confirmation output rejects the proposal safely. */ }
  }
  return { status: "invalid" };
}

function reasonFor(action: AgentAction): string {
  if (action.tool === "open_bet" || action.tool === "lock_bet" || action.tool === "cancel_bet") return action.arguments.reason;
  if (action.tool === "resolve_bet") return action.arguments.reason;
  return "Waiting for a clearer moment.";
}

function reasonFromEntry(entry: DecisionEntry): string {
  if (entry.tool === "open_bet" && typeof entry.arguments === "object" && entry.arguments && "reason" in entry.arguments) return String(entry.arguments.reason);
  if ((entry.tool === "lock_bet" || entry.tool === "cancel_bet") && typeof entry.arguments === "object" && entry.arguments && "reason" in entry.arguments) return String(entry.arguments.reason);
  if ((entry.tool === "resolve_bet" || entry.tool === "confirm_resolution") && typeof entry.arguments === "object" && entry.arguments && "reason" in entry.arguments) return String(entry.arguments.reason);
  if (entry.tool === "reject_resolution" && typeof entry.arguments === "object" && entry.arguments && "reason" in entry.arguments) return String(entry.arguments.reason);
  return entry.tool === "window_end" ? "Bet window ended and was locked." : entry.tool === "timeout" ? "Bet timed out and was refunded." : "Waiting for a clearer moment.";
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
