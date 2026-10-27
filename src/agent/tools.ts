import type OpenAI from "openai";

export const CALLIT_TOOLS = [
  {
    type: "function",
    name: "wait",
    description: "Take no action this tick.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "open_bet",
    description: "Open a chat prediction for a new uncertain game moment that is beginning.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question within the character limit provided in the current context." },
        outcomes: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", description: "Outcome title up to 25 characters." } },
        window_seconds: { type: "integer", minimum: 30, maximum: 1800 },
        reason: { type: "string" },
      },
      required: ["question", "outcomes", "window_seconds", "reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "lock_bet",
    description: "Lock the active bet because its outcome is about to be decided.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "resolve_bet",
    description: "Resolve the active bet only when a supplied frame visibly proves one outcome.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        outcome_index: { type: "integer", minimum: 0 },
        evidence: { type: "string" },
      },
      required: ["outcome_index", "evidence"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cancel_bet",
    description: "Cancel and refund the active bet when its outcome cannot be seen or is ambiguous.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
] satisfies OpenAI.Responses.FunctionTool[];
