import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { AgentBrain, functionCalls } from "../src/agent/brain.js";
import type { AgentContext } from "../src/agent/types.js";

const context: AgentContext = {
  nowMs: 1000,
  mode: "chat",
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
    const request = requests[0] as { tool_choice: string; tools: Array<{ strict: boolean }>; reasoning: { effort: string }; input: Array<{ content: Array<{ type: string; detail?: string }> }>; };
    expect(request.tool_choice).toBe("required");
    expect(request.tools).toHaveLength(5);
    expect(request.tools.every((tool) => tool.strict)).toBe(true);
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(request.input[0]?.content[1]).toMatchObject({ type: "input_image", detail: "low" });
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
