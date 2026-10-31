import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContext } from "../src/agent/types.js";
import type { resolutionConfirmation } from "../src/agent/brain.js";

export function scoreConfirmation(
  expected: Pick<ConfirmationCaseFile, "expected" | "expectedOutcomeIndex">,
  actual: ReturnType<typeof resolutionConfirmation>,
): "confirm" | "wrongOutcome" | "reject" | "invalid" {
  if (actual.status === "confirm") {
    return expected.expectedOutcomeIndex !== undefined && actual.outcomeIndex !== expected.expectedOutcomeIndex ? "wrongOutcome" : "confirm";
  }
  return actual.status;
}

export interface ConfirmationCaseFile {
  source: string;
  question: string;
  outcomes: string[];
  outcomeIndex: number;
  evidence: string;
  reason: string;
  proposal: string[];
  newer: string[];
  expected: "confirm" | "reject";
  expectedOutcomeIndex?: number;
}

export interface ConfirmationCase {
  id: string;
  directory: string;
  data: ConfirmationCaseFile;
}

export async function loadConfirmationCases(directory = join(process.cwd(), "eval", "confirm-cases")): Promise<ConfirmationCase[]> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cases: ConfirmationCase[] = [];
  for (const id of names) {
    const caseDirectory = join(directory, id);
    const data = JSON.parse(await readFile(join(caseDirectory, "case.json"), "utf8")) as ConfirmationCaseFile;
    if (!data.question || !Array.isArray(data.outcomes) || !data.proposal?.length || !data.newer?.length || !["confirm", "reject"].includes(data.expected) ||
      (data.expectedOutcomeIndex !== undefined && (!Number.isInteger(data.expectedOutcomeIndex) || data.expectedOutcomeIndex < 0 || data.expectedOutcomeIndex >= data.outcomes.length))) {
      throw new Error(`Confirmation case ${id} is missing required fields.`);
    }
    cases.push({ id, directory: caseDirectory, data });
  }
  return cases;
}

export async function buildConfirmationContext(testCase: ConfirmationCase, nowMs = Date.now()): Promise<AgentContext> {
  const readFrames = async (names: string[]) => Promise.all(names.map(async (filename, index) => {
    const bytes = await readFile(join(testCase.directory, filename));
    const seconds = Number.parseFloat(filename.replace(/\.jpg$/i, ""));
    return {
      timestampMs: Number.isFinite(seconds) ? seconds * 1000 : index * 1000,
      jpegBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
  const proposalFrames = await readFrames(testCase.data.proposal);
  const frames = await readFrames(testCase.data.newer);
  const latestFrameTimestampMs = Math.max(...proposalFrames.map((frame) => frame.timestampMs));
  const outcome = testCase.data.outcomes[testCase.data.outcomeIndex];
  if (!outcome) throw new Error(`Confirmation case ${testCase.id} has an invalid outcomeIndex.`);
  return {
    nowMs,
    mode: "chat",
    frames,
    proposalFrames,
    bet: {
      status: "locked",
      question: testCase.data.question,
      outcomes: [...testCase.data.outcomes],
      pools: testCase.data.outcomes.map(() => ({ points: 0, bettors: 0 })),
      openedAtMs: Math.max(0, Math.min(...proposalFrames.map((frame) => frame.timestampMs)) - 30_000),
      lockedAtMs: Math.max(0, Math.min(...proposalFrames.map((frame) => frame.timestampMs)) - 1_000),
      expiresAtMs: nowMs + 60_000,
    },
    lastOpenedAtMs: null,
    decisions: [],
    memorySummary: "No stored channel memory summary yet.",
    adBreak: false,
    secondsUntilNewBetAllowed: 0,
    pendingResolution: {
      outcomeIndex: testCase.data.outcomeIndex,
      outcome,
      evidence: testCase.data.evidence,
      reason: testCase.data.reason,
      proposedAtMs: latestFrameTimestampMs,
      previousStatus: "locked",
      latestFrameTimestampMs,
    },
  };
}
