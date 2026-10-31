import OpenAI from "openai";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses.js";
import { CALLIT_TOOLS, RESOLUTION_CONFIRMATION_TOOLS } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { AgentContext } from "./types.js";

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
        ? `${SYSTEM_PROMPT}\n\nThis is a second-look confirmation. Compare the proposed full subject name and evidence with the exact bet question. Only frames newer than timestamp ${context.pendingResolution?.latestFrameTimestampMs} are new for this second look. The original evidence cannot confirm itself. Confirm only if newer frames clearly show the exact subject's outcome. If its health bar is above zero, or the name is missing, similar, or from an old combat log line, reject. If unsure, reject.`
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
  const text = [
    `Current bet: ${JSON.stringify(bet)}`,
    `Active bet limits for ${context.mode} mode: question up to ${context.mode === "native" ? 45 : 90} characters, outcome titles up to 25 characters, 2 to 10 outcomes, window 30 to 1800 seconds. Write within these limits.`,
    `Seconds until a new bet is allowed: ${Math.max(0, context.secondsUntilNewBetAllowed)}.`,
    ...(context.pendingResolution ? [`Pending resolution proposal: ${JSON.stringify(context.pendingResolution)}. Use only frame timestamps newer than ${context.pendingResolution.latestFrameTimestampMs} to confirm. Decide with confirm_resolution or reject_resolution.`] : []),
    `Recent decisions: ${JSON.stringify(context.decisions.slice(-10))}`,
    `Channel memory summary: ${context.memorySummary}`,
    `Ad break active: ${context.adBreak ? "yes" : "no"}`,
    `Frames are listed with timestamps and hashes. Cite the timestamp when resolving: ${JSON.stringify(context.frames.map(({ timestampMs, sha256 }) => ({ timestampMs, sha256 })))}`,
  ].join("\n");
  const content = [
    { type: "input_text" as const, text },
    ...context.frames.map((frame) => ({
      type: "input_image" as const,
      image_url: `data:image/jpeg;base64,${frame.jpegBase64}`,
      detail,
    })),
  ];
  return [{ role: "user", content }];
}
