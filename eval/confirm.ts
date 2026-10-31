import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrain, resolutionConfirmation } from "../src/agent/brain.js";
import { buildConfirmationContext, loadConfirmationCases, scoreConfirmation } from "./confirm-context.js";

const runArgument = process.argv[2];
const runs = runArgument === undefined ? 5 : Number(runArgument);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Usage: npm run eval:confirm -- [runs], where runs is a positive integer.");

const brain = new AgentBrain();
const testCases = await loadConfirmationCases();
const results = [];
for (const testCase of testCases) {
  let confirmCount = 0;
  let wrongOutcomeCount = 0;
  let rejectCount = 0;
  let invalidCount = 0;
  for (let run = 0; run < runs; run += 1) {
    const context = await buildConfirmationContext(testCase);
    const result = resolutionConfirmation(await brain.call(context));
    const score = scoreConfirmation(testCase.data, result);
    if (score === "confirm") confirmCount += 1;
    else if (score === "wrongOutcome") wrongOutcomeCount += 1;
    else if (score === "reject") rejectCount += 1;
    else invalidCount += 1;
  }
  const result = {
    id: testCase.id,
    expected: testCase.data.expected,
    ...(testCase.data.expectedOutcomeIndex === undefined ? {} : { expectedOutcomeIndex: testCase.data.expectedOutcomeIndex }),
    runs,
    confirmCount,
    wrongOutcomeCount,
    rejectCount,
    invalidCount,
  };
  results.push(result);
  console.log(`${result.id}: confirm ${confirmCount}/${runs}, wrong outcome ${wrongOutcomeCount}/${runs}, reject ${rejectCount}/${runs}, invalid ${invalidCount}/${runs}, expected ${result.expected}${testCase.data.expectedOutcomeIndex === undefined ? "" : ` outcome ${testCase.data.expectedOutcomeIndex}`}`);
}

const resultDirectory = join(process.cwd(), "eval", "results");
await mkdir(resultDirectory, { recursive: true });
const outputPath = join(resultDirectory, `confirm-${new Date().toISOString().slice(0, 10)}.json`);
await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), model: brain.resolveModel, results }, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
