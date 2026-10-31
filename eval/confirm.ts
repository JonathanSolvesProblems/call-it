import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrain, resolutionConfirmation } from "../src/agent/brain.js";
import { buildConfirmationContext, loadConfirmationCases } from "./confirm-context.js";

const runArgument = process.argv[2];
const runs = runArgument === undefined ? 5 : Number(runArgument);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Usage: npm run eval:confirm -- [runs], where runs is a positive integer.");

const brain = new AgentBrain();
const testCases = await loadConfirmationCases();
const results = [];
for (const testCase of testCases) {
  let confirmCount = 0;
  let rejectCount = 0;
  let invalidCount = 0;
  for (let run = 0; run < runs; run += 1) {
    const context = await buildConfirmationContext(testCase);
    const result = resolutionConfirmation(await brain.call(context));
    if (result.status === "confirm") confirmCount += 1;
    else if (result.status === "reject") rejectCount += 1;
    else invalidCount += 1;
  }
  const result = {
    id: testCase.id,
    expected: testCase.data.expected,
    runs,
    confirmCount,
    rejectCount,
    invalidCount,
  };
  results.push(result);
  console.log(`${result.id}: confirm ${confirmCount}/${runs}, reject ${rejectCount}/${runs}, invalid ${invalidCount}/${runs}, expected ${result.expected}`);
}

const resultDirectory = join(process.cwd(), "eval", "results");
await mkdir(resultDirectory, { recursive: true });
const outputPath = join(resultDirectory, `confirm-${new Date().toISOString().slice(0, 10)}.json`);
await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), model: brain.model, results }, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
