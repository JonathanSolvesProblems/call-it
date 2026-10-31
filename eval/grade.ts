import { gradeRun } from "./grade-lib.js";

const [runDirectory, gamesFile, ...extra] = process.argv.slice(2);
if (!runDirectory || !gamesFile || extra.length) throw new Error("Usage: npm run grade -- <runDir> <games.json>");
const result = await gradeRun(runDirectory, gamesFile);
console.log(`VOD ${result.vodId}${result.memoryOff ? " (no memory)" : ""}`);
console.log("Metric                 Value");
console.log(`VOD hours              ${result.vodHours.toFixed(2)}`);
console.log(`Bets opened            ${result.betsOpened}`);
console.log(`Bets per hour          ${result.betsPerHour.toFixed(2)}`);
console.log(`Graded                 ${result.graded}`);
console.log(`Matched the record     ${result.matchedRecord}`);
console.log(`Did not match          ${result.didNotMatch}`);
console.log(`Refunded               ${result.refunded}`);
console.log(`Ungraded               ${result.ungraded}`);
for (const [reason, count] of Object.entries(result.ungradedReasons)) console.log(`  ${reason}: ${count}`);
const safeVodId = result.vodId.replace(/[^a-zA-Z0-9._-]/g, "_");
console.log(`Wrote eval/results/chess-${safeVodId}${result.memoryOff ? "-nomemory" : ""}.json`);
