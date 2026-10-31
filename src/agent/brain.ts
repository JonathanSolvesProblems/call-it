import OpenAI from "openai";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses.js";
import { CALLIT_TOOLS, RESOLUTION_CONFIRMATION_TOOLS } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { AgentContext } from "./types.js";

export const RESOLUTION_CONFIRMATION_INSTRUCTIONS = `This is a second-look confirmation of a proposed result. You get two sets of frames: PROPOSAL frames (what the first look saw) and NEWER frames (captured after the proposal). Confirm only if both hold:
1. A PROPOSAL frame shows the exact subject of the bet, by its full name, with the outcome: a target frame or nameplate reading Dead or 0 HP, a defeat, reset or victory banner naming it, or the player's own death. A combat log line, an experience line, or loot alone is not enough, and a similar name never counts.
2. No NEWER frame contradicts it: the exact subject is not shown alive with health above zero, and the fight against it is not still going.
After a kill the proof often disappears within seconds, so NEWER frames do not need to repeat it. If the subject's health is above zero in any frame after the proposal, reject. If unsure, reject.`;

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export class AgentBrain {
  readonly model: string;
  readonly imageDetail: "low" | "high" | "auto";
  private readonly client: OpenAI;

  constructor(env: NodeJS.ProcessEnv = process.env, client?: OpenAI) {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!client && !apiKey) throw new Error("Missing OPENAI_API_KEY. Add your API key to .env.");
    this.client = client ?? new OpenAI({ apiKey });
    this.model = env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
    const detail = env.OPENAI_IMAGE_DETAIL?.trim().toLowerCase() || "high";
    if (detail !== "low" && detail !== "high" && detail !== "auto") throw new Error("OPENAI_IMAGE_DETAIL must be low, high, or auto.");
    this.imageDetail = detail;
  }

  async call(context: AgentContext, retry?: { previousResponseId: string; outputs: Array<{ callId: string; error: string }> }): Promise<Response> {
    const input = retry
      ? retry.outputs.map(({ callId, error }) => ({
          type: "function_call_output" as const,
          call_id: callId,
          output: JSON.stringify({ error }),
        } satisfies ResponseInputItem))
      : makeInput(context, this.imageDetail);
    const confirming = Boolean(context.pendingResolution);
    const base = {
      model: this.model,
      instructions: confirming
        ? RESOLUTION_CONFIRMATION_INSTRUCTIONS
        : SYSTEM_PROMPT,
      input,
      tools: confirming ? RESOLUTION_CONFIRMATION_TOOLS : CALLIT_TOOLS,
      tool_choice: "required" as const,
      parallel_tool_calls: false,
      ...(retry ? { previous_response_id: retry.previousResponseId } : {}),
    };
    if (/^gpt-[56](?:[.-]|$)/i.test(this.model)) {
      return this.client.responses.create({ ...base, reasoning: { effort: "low" } });
    }
    return this.client.responses.create(base);
  }
}

export function functionCalls(response: Response): FunctionCall[] {
  return response.output.flatMap((item) => item.type === "function_call"
    ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }]
    : []);
}

export function resolutionConfirmation(response: Response): { status: "confirm" } | { status: "reject"; reason: string } | { status: "invalid" } {
  const calls = functionCalls(response);
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
    } catch { /* Malformed output is treated as an invalid confirmation. */ }
  }
  return { status: "invalid" };
}

function makeInput(context: AgentContext, detail: "low" | "high" | "auto"): ResponseInputItem[] {
  const bet = context.bet
    ? {
        status: context.bet.status,
        question: context.bet.question,
        outcomes: context.bet.outcomes.map((title, index) => ({ title, points: context.bet?.pools[index]?.points ?? 0, bettors: context.bet?.pools[index]?.bettors ?? 0 })),
        seconds_elapsed: Math.max(0, Math.floor((context.nowMs - context.bet.openedAtMs) / 1000)),
        seconds_left: Math.max(0, Math.ceil((context.bet.expiresAtMs - context.nowMs) / 1000)),
      }
    : { status: "none" };
  const proposalFrames = context.pendingResolution ? context.proposalFrames ?? [] : [];
  const frameGroups = context.pendingResolution
    ? [
        `PROPOSAL frames (images follow in this order): ${JSON.stringify(proposalFrames.map(({ timestampMs, sha256 }) => ({ timestampMs, sha256 })))}`,
        `NEWER frames (images follow in this order): ${JSON.stringify(context.frames.map(({ timestampMs, sha256 }) => ({ timestampMs, sha256 })))}`,
      ]
    : [`Frames are listed with timestamps and hashes. Cite the timestamp when resolving: ${JSON.stringify(context.frames.map(({ timestampMs, sha256 }) => ({ timestampMs, sha256 })))}`];
  const text = [
    `Current bet: ${JSON.stringify(bet)}`,
    `Active bet limits for ${context.mode} mode: question up to ${context.mode === "native" ? 45 : 90} characters, outcome titles up to 25 characters, 2 to 10 outcomes, window 30 to 1800 seconds. Write within these limits.`,
    `Seconds until a new bet is allowed: ${Math.max(0, context.secondsUntilNewBetAllowed)}.`,
    ...(context.pendingResolution ? [`Pending resolution proposal: ${JSON.stringify(context.pendingResolution)}. Decide with confirm_resolution or reject_resolution.`] : []),
    `Recent decisions: ${JSON.stringify(context.decisions.slice(-10))}`,
    `Channel memory summary: ${context.memorySummary}`,
    `Ad break active: ${context.adBreak ? "yes" : "no"}`,
    ...frameGroups,
  ].join("\n");
  const content = [
    { type: "input_text" as const, text },
    ...proposalFrames.map((frame) => ({
      type: "input_image" as const,
      image_url: `data:image/jpeg;base64,${frame.jpegBase64}`,
      detail,
    })),
    ...context.frames.map((frame) => ({
      type: "input_image" as const,
      image_url: `data:image/jpeg;base64,${frame.jpegBase64}`,
      detail,
    })),
  ];
  return [{ role: "user", content }];
}
