import { setTimeout as delay } from "node:timers/promises";
import { OverlayServer } from "./server.js";
import type { OverlayDecision, OverlayState } from "./state.js";

const overlay = new OverlayServer();
await overlay.listen();
const decisions: OverlayDecision[] = [];
let timestampMs = Date.now();
const publishDecision = (tool: string, model: string, reason: string, guardResult = "accepted") => {
  decisions.push({ timestampMs: timestampMs += 1000, tool, model, reason, guardResult });
  overlay.update({ lastDecisionReason: reason, decisions: decisions.slice(-50), demoData: true });
};
const showBet = (bet: NonNullable<OverlayState["bet"]>, tool: string, model: string, reason: string, guardResult?: string) => {
  publishDecision(tool, model, reason, guardResult);
  overlay.update({ bet, demoData: true });
};

const openBet = {
  id: "demo-dragon-bet",
  question: "Does the team take the next dragon?",
  outcomes: [{ title: "They take it", points: 0, bettors: 0 }, { title: "They back away", points: 0, bettors: 0 }],
  status: "open" as const,
  secondsLeft: 30,
};
overlay.update({ demoData: true, paused: false, adBreak: false });
showBet(openBet, "open_bet", "gpt-5.4-mini", "A major objective fight is about to begin.");
await delay(2500);
showBet({ ...openBet, outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }], secondsLeft: 18 }, "wait", "gpt-5.4-mini", "Chat has 17 bettors in the pool.");
await delay(2500);
showBet({ ...openBet, outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }], status: "locked", secondsLeft: 0 }, "lock_bet", "gpt-5.4-mini", "Both teams are committed to the fight.");
await delay(2500);
showBet({ ...openBet, outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }], status: "checking", secondsLeft: 0, proposedOutcomeIndex: 0 }, "resolve_bet", "gpt-5.4-mini", "The first look proposes that the team takes the dragon.");
await delay(2500);
showBet({
  ...openBet,
  outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }],
  status: "resolved",
  secondsLeft: 0,
  winningOutcomeIndex: 1,
  resultReason: "The newer frame shows the team retreating before the dragon falls.",
  winnerCount: 3,
  biggestPayout: 2200,
  biggestWinnerLogin: "dragonfan",
  checkedBySecondLook: true,
  clipUrl: "https://clips.twitch.tv/DemoClipForCallIt",
}, "confirm_resolution", "gpt-6.1-sol", "Confirmed that the team backed away.", "corrected from They take it to They back away");
console.log("DEMO: corrected confirmation, payout, and clip are showing. The winner card will hide after 25 seconds.");
await delay(26_000);
console.log("DEMO: winner card should now be hidden.");

const shutdown = async () => {
  await overlay.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
