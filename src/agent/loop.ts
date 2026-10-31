import { setTimeout as delay } from "node:timers/promises";
import type { FrameSource } from "../frames/frame-source.js";
import { FrameArchive } from "../frames/frame-archive.js";
import type { OverlayServer } from "../overlay/server.js";
import { AgentBrain, functionCalls, resolutionConfirmation, type FunctionCall } from "./brain.js";
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
  lockBetForResolution(nowMs: number): Promise<void>;
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
  decisionMetadata?: () => Pick<DecisionEntry, "vodOffsetSeconds">;
  archiveFrames?: boolean;
  onModelCall?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onModelCallStart?: () => void;
  maxModelCalls?: number;
  onStop?: (reason: string) => void;
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
  private pendingProposalFrames: NonNullable<AgentContext["proposalFrames"]> = [];
  private confirmationFailures = 0;
  private nextTickAtMs = 0;
  private modelCalls = 0;
  private previousNewestFrameHash: string | undefined;
  private budgetStopSignaled = false;

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

  async runReplayTicks(tickCount: number, advanceClock: () => void, onTick?: () => void): Promise<void> {
    this.live = true;
    for (let tick = 0; tick < tickCount && this.live; tick += 1) {
      await this.runTick();
      onTick?.();
      if (this.live && tick + 1 < tickCount) advanceClock();
    }
    this.live = false;
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
    const previousNewestFrameHash = this.previousNewestFrameHash;
    this.previousNewestFrameHash = frames.at(-1)?.sha256;
    let frameHashes = frames.map((frame) => frame.sha256);
    let frameFiles: string[] = [];
    if (this.isModelBudgetReached()) {
      await this.stopForModelBudget(tickStartedAt, frameHashes, frameFiles);
      return;
    }
    const deadline = await this.options.executor.checkDeadlines(tickStartedAt, this.maxBetSeconds, Boolean(this.pendingResolution));
    if (deadline) {
      if (deadline === "timeout") this.clearPendingResolution();
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
    const sameAsPreviousFrame = newestFrame.sha256 === previousNewestFrameHash;
    if (sameAsPreviousFrame) {
      await this.record({
        timestamp: new Date(tickStartedAt).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
        tool: "skipped_tick", arguments: {}, guardResult: "model call skipped: newest frame hash unchanged from previous tick",
        latencyMs: 0, inputTokens: 0, outputTokens: 0,
      }, "Frame unchanged since the previous tick. Skipping this tick.");
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
      if (this.options.archiveFrames !== false) frameFiles = await this.frameArchive.save(framesForModel);
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
      ...(this.pendingResolution ? { proposalFrames: this.pendingProposalFrames } : {}),
    };
    if (this.pendingResolution) {
      if (!context.bet) {
        this.clearPendingResolution();
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
      this.modelCalls += 1;
      this.options.onModelCallStart?.();
      let response = await this.options.brain.call(context);
      this.options.onModelCall?.({ inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 });
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
        if (this.options.maxModelCalls !== undefined && this.modelCalls >= this.options.maxModelCalls) {
          calls = [];
          decoded = undefined;
          validationError = "Model call budget reached before the correction call.";
        } else {
          modelCallStartedAt = this.clock();
          this.modelCalls += 1;
          this.options.onModelCallStart?.();
          response = await this.options.brain.call(context, {
            previousResponseId: response.id,
            outputs: calls.map((call) => ({ callId: call.callId, error: correction })),
          });
          this.options.onModelCall?.({ inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 });
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
            const previousStatus = activeBet.status;
            const previousLockedAtMs = activeBet.lockedAtMs;
            if (activeBet.status === "open") await this.options.executor.lockBetForResolution(this.clock());
            this.pendingResolution = {
              outcomeIndex: action.arguments.outcome_index,
              outcome: activeBet.outcomes[action.arguments.outcome_index]!,
              evidence: action.arguments.evidence,
              reason: action.arguments.reason,
              proposedAtMs: this.clock(),
              previousStatus,
              ...(previousLockedAtMs === undefined ? {} : { previousLockedAtMs }),
              latestFrameTimestampMs: Math.max(...context.frames.map((frame) => frame.timestampMs)),
            };
            this.pendingProposalFrames = context.frames.map((frame) => ({ ...frame }));
            this.confirmationFailures = 0;
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
    await this.options.decisions.append({ ...entry, ...this.options.decisionMetadata?.() });
    const latestFrame = this.options.frames.latest(1)[0];
    this.options.overlay.update({
      bet: this.overlayBet(this.clock()),
      lastDecisionReason: reason,
      decisions: this.options.decisions.latest().map((decision) => ({ timestampMs: Date.parse(decision.timestamp), reason: reasonFromEntry(decision) })),
      ...(latestFrame ? { latestFrameJpegBase64: latestFrame.jpegBase64 } : {}),
    });
    this.options.onDecision?.(entry);
    if (entry.tool !== "model_call_budget_reached" && this.isModelBudgetReached()) {
      await this.stopForModelBudget(Date.parse(entry.timestamp), entry.frameHashes, entry.frameFiles ?? []);
    }
  }

  private isModelBudgetReached(): boolean {
    return this.options.maxModelCalls !== undefined && this.modelCalls >= this.options.maxModelCalls;
  }

  private async stopForModelBudget(timestampMs: number, frameHashes: string[], frameFiles: string[]): Promise<void> {
    if (this.budgetStopSignaled) return;
    this.budgetStopSignaled = true;
    this.live = false;
    await this.record({
      timestamp: new Date(timestampMs).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
      tool: "model_call_budget_reached", arguments: { modelCalls: this.modelCalls },
      guardResult: "model call budget reached; no further model calls will be made", latencyMs: 0, inputTokens: 0, outputTokens: 0,
    }, "model call budget reached");
    this.options.onStop?.("model call budget reached");
  }

  private overlayBet(nowMs: number): ReturnType<OverlayServer["getState"]>["bet"] {
    const bet = this.options.executor.overlayBet(nowMs);
    return bet && this.pendingResolution
      ? { ...bet, status: "checking", proposedOutcomeIndex: this.pendingResolution.outcomeIndex }
      : bet;
  }

  private clearPendingResolution(): void {
    this.pendingResolution = undefined;
    this.pendingProposalFrames = [];
    this.confirmationFailures = 0;
  }

  private async failPendingResolution(
    pending: NonNullable<AgentContext["pendingResolution"]>,
    frameHashes: string[],
    frameFiles: string[],
    reason: string,
    latencyMs: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    await this.options.executor.restoreBetStatus(pending.previousStatus, pending.previousLockedAtMs);
    this.clearPendingResolution();
    await this.record({
      timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
      tool: "confirmation_failed",
      arguments: { reason, outcome_index: pending.outcomeIndex, outcome: pending.outcome, evidence: pending.evidence },
      guardResult: "two consecutive confirmation calls failed or returned invalid tools; bet returned to its previous status without settlement",
      latencyMs, inputTokens, outputTokens,
    }, "Could not confirm the result. The bet remains open for another decision.");
  }

  private async confirmPendingResolution(
    context: AgentContext,
    frameHashes: string[],
    frameFiles: string[],
  ): Promise<void> {
    const startedAt = this.clock();
    try {
      this.modelCalls += 1;
      this.options.onModelCallStart?.();
      const response = await this.options.brain.call(context);
      this.options.onModelCall?.({ inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 });
      const latencyMs = Math.max(0, this.clock() - startedAt);
      this.nextTickAtMs = this.clock() + this.tickSeconds * 1000;
      const decision = resolutionConfirmation(response);
      const pending = this.pendingResolution;
      if (!pending) return;
      if (decision.status === "invalid") {
        this.confirmationFailures += 1;
        if (this.confirmationFailures >= 2) {
          await this.failPendingResolution(pending, frameHashes, frameFiles, "Two consecutive confirmation calls failed or returned invalid tools.", latencyMs, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);
          return;
        }
        await this.record({
          timestamp: new Date(this.clock()).toISOString(), frameHashes, frameFiles, model: this.options.brain.model,
          tool: "resolution_confirmation_invalid", arguments: { outcome_index: pending.outcomeIndex, evidence: pending.evidence },
          guardResult: "model did not call confirm_resolution or reject_resolution; proposal remains pending",
          latencyMs, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
        }, "The proposed result is still being checked.");
        return;
      }
      if (decision.status === "confirm") {
        this.clearPendingResolution();
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
      this.clearPendingResolution();
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
      if (pending) {
        this.confirmationFailures += 1;
        if (this.confirmationFailures >= 2) {
          await this.failPendingResolution(pending, frameHashes, frameFiles, `Two consecutive confirmation calls failed: ${errorMessage(error)}`, Math.max(0, this.clock() - startedAt), 0, 0);
          return;
        }
      }
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
