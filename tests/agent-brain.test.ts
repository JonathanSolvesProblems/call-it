import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { AgentBrain, functionCalls, RESOLUTION_CONFIRMATION_INSTRUCTIONS } from "../src/agent/brain.js";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";
import type { AgentContext } from "../src/agent/types.js";
import { buildConfirmationContext, loadConfirmationCases } from "../eval/confirm-context.js";

const context: AgentContext = {
  nowMs: 1000,
  mode: "chat",
  secondsUntilNewBetAllowed: 0,
  frames: [{ timestampMs: 1000, jpegBase64: "ZmFrZQ==", sha256: "hash-1" }],
  bet: null,
  lastOpenedAtMs: null,
  decisions: [],
  memorySummary: "No stored summary.",
  adBreak: false,
};

function response(output: Response["output"] = []): Response {
  return { id: "response-1", output, usage: { input_tokens: 9, output_tokens: 4 } } as Response;
}

describe("agent Responses API request", () => {
  it("uses strict required tools, image detail, defaults, and low reasoning for GPT-5", async () => {
    const requests: unknown[] = [];
    const client = { responses: { create: vi.fn(async (request: unknown) => { requests.push(request); return response(); }) } } as unknown as OpenAI;
    const brain = new AgentBrain({ OPENAI_API_KEY: "test-key", OPENAI_IMAGE_DETAIL: "low" }, client);
    await brain.call(context);

    expect(brain.model).toBe("gpt-5.4-mini");
    expect(brain.imageDetail).toBe("low");
    const request = requests[0] as { tool_choice: string; tools: Array<{ strict: boolean }>; reasoning: { effort: string }; input: Array<{ content: Array<{ type: string; detail?: string; text?: string }> }>; };
    expect(request.tool_choice).toBe("required");
    expect(request.tools).toHaveLength(5);
    expect(request.tools.every((tool) => tool.strict)).toBe(true);
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(request.input[0]?.content[1]).toMatchObject({ type: "input_image", detail: "low" });
    expect(request.input[0]?.content[0]?.text).toContain("Seconds until a new bet is allowed: 0");
  });

  it("uses only confirmation tools and includes the proposed evidence on the second look", async () => {
    const requests: unknown[] = [];
    const client = { responses: { create: vi.fn(async (request: unknown) => { requests.push(request); return response(); }) } } as unknown as OpenAI;
    const brain = new AgentBrain({ OPENAI_API_KEY: "test-key" }, client);
    await brain.call({
      ...context,
      pendingResolution: {
        outcomeIndex: 0,
        outcome: "It dies",
        evidence: "Glass-Backed Tide Wisp shows 0 HP in the new frame.",
        reason: "The Glass-Backed Tide Wisp went down.",
        proposedAtMs: 1000,
        previousStatus: "locked",
        latestFrameTimestampMs: 1000,
      },
    });
    const request = requests[0] as { tools: Array<{ name: string }>; instructions: string; input: Array<{ content: Array<{ text?: string }> }> };
    expect(request.tools.map((tool) => tool.name)).toEqual(["confirm_resolution", "reject_resolution"]);
    expect(request.instructions).toContain("second-look confirmation");
    expect(request.input[0]?.content[0]?.text).toContain("Glass-Backed Tide Wisp shows 0 HP");
  });

  it("sends proposal frames before newer frames with labels and timestamps on the shared confirmation path", async () => {
    const cases = await loadConfirmationCases();
    const testCase = cases.find(({ id }) => id === "true-kill-tide-wisp");
    expect(testCase).toBeDefined();
    const confirmationContext = await buildConfirmationContext(testCase!, 100_000);
    const requests: unknown[] = [];
    const client = { responses: { create: vi.fn(async (request: unknown) => { requests.push(request); return response(); }) } } as unknown as OpenAI;
    const brain = new AgentBrain({ OPENAI_API_KEY: "test-key" }, client);
    await brain.call(confirmationContext);

    const request = requests[0] as { instructions: string; input: Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }> };
    const content = request.input[0]?.content ?? [];
    const text = content[0]?.text ?? "";
    expect(request.instructions).toBe(`${SYSTEM_PROMPT}\n\n${RESOLUTION_CONFIRMATION_INSTRUCTIONS}`);
    expect(request.instructions).toContain("A name label with no health bar, or with a loot marker, is a corpse, not a living enemy.");
    expect(text).toContain("PROPOSAL frames");
    expect(text).toContain("NEWER frames");
    for (const frame of confirmationContext.proposalFrames ?? []) expect(text).toContain(String(frame.timestampMs));
    for (const frame of confirmationContext.frames) expect(text).toContain(String(frame.timestampMs));
    expect(content.slice(1).map((part) => part.image_url)).toEqual([
      ...(confirmationContext.proposalFrames ?? []).map((frame) => `data:image/jpeg;base64,${frame.jpegBase64}`),
      ...confirmationContext.frames.map((frame) => `data:image/jpeg;base64,${frame.jpegBase64}`),
    ]);
  });

  it("omits reasoning for non-GPT-5/6 models and sends low effort for GPT-6", async () => {
    const requests: unknown[] = [];
    const client = { responses: { create: vi.fn(async (request: unknown) => { requests.push(request); return response(); }) } } as unknown as OpenAI;
    const brain = new AgentBrain({ OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-4.1-mini" }, client);
    await brain.call(context);
    expect(requests[0]).not.toHaveProperty("reasoning");
    const gpt6 = new AgentBrain({ OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-6-luna" }, client);
    await gpt6.call(context);
    expect(requests[1]).toMatchObject({ reasoning: { effort: "low" } });
  });

  it("extracts function_call items from response.output", () => {
    const call = { type: "function_call", call_id: "call-1", name: "wait", arguments: "{}" } as Response["output"][number];
    expect(functionCalls(response([call]))).toEqual([{ callId: "call-1", name: "wait", arguments: "{}" }]);
  });
});
