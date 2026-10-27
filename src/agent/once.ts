import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgentBrain, functionCalls } from "./brain.js";
import type { AgentContext } from "./types.js";

const paths = process.argv.slice(2);
if (paths.length < 1 || paths.length > 3) throw new Error("Usage: npm run agent:once -- <jpg> [<jpg> <jpg>]");

const nowMs = Date.now();
const frames = await Promise.all(paths.map(async (path, index) => {
  const bytes = await readFile(path);
  return {
    timestampMs: nowMs - (paths.length - index - 1) * 1000,
    jpegBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}));
const context: AgentContext = {
  nowMs,
  mode: "chat",
  frames,
  bet: null,
  lastOpenedAtMs: null,
  decisions: [],
  memorySummary: "No stored channel memory summary yet.",
  adBreak: false,
};
const brain = new AgentBrain();
const response = await brain.call(context);
const calls = functionCalls(response);
if (calls.length !== 1) {
  console.log(JSON.stringify({ tool: "wait", arguments: {}, detail: "Response did not contain exactly one function call." }, null, 2));
} else {
  const call = calls[0]!;
  let args: unknown;
  try { args = JSON.parse(call.arguments); } catch { args = call.arguments; }
  console.log(JSON.stringify({ tool: call.name, arguments: args }, null, 2));
}
