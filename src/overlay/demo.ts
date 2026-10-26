import { setTimeout as delay } from "node:timers/promises";
import { OverlayServer } from "./server.js";
import type { OverlayDecision, OverlayState } from "./state.js";

const overlay = new OverlayServer();
await overlay.listen();
const decisions: OverlayDecision[] = [];
const publishDecision = (reason: string) => {
  decisions.push({ timestampMs: Date.now(), reason });
  overlay.update({ lastDecisionReason: reason, decisions: decisions.slice(-10) });
};
const showBet = (bet: NonNullable<OverlayState["bet"]>, reason: string) => {
  publishDecision(reason);
  overlay.update({ bet, demoData: true });
};

overlay.update({ demoData: true, paused: false, adBreak: false });
showBet({
  question: "Does the team take the next dragon?",
  outcomes: [{ title: "They take it", points: 0, bettors: 0 }, { title: "They back away", points: 0, bettors: 0 }],
  status: "open",
  secondsLeft: 30,
}, "Opened: a dragon fight is forming.");
await delay(2500);
showBet({
  question: "Does the team take the next dragon?",
  outcomes: [{ title: "They take it", points: 1420, bettors: 8 }, { title: "They back away", points: 760, bettors: 5 }],
  status: "open",
  secondsLeft: 22,
}, "Chat is picking a side.");
await delay(2500);
showBet({
  question: "Does the team take the next dragon?",
  outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }],
  status: "locked",
  secondsLeft: 0,
}, "Locked: the teams are committed.");
await delay(2500);
showBet({
  question: "Does the team take the next dragon?",
  outcomes: [{ title: "They take it", points: 1820, bettors: 11 }, { title: "They back away", points: 930, bettors: 6 }],
  status: "resolved",
  secondsLeft: 0,
  winningOutcomeIndex: 0,
}, "Resolved: the dragon was secured.");
await delay(4500);
showBet({
  question: "Does the team get the next pick?",
  outcomes: [{ title: "They find a pick", points: 1200, bettors: 7 }, { title: "No pick", points: 810, bettors: 4 }],
  status: "open",
  secondsLeft: 30,
}, "Opened: both teams are setting up.");
await delay(3000);
showBet({
  question: "Does the team get the next pick?",
  outcomes: [{ title: "They find a pick", points: 1200, bettors: 7 }, { title: "No pick", points: 810, bettors: 4 }],
  status: "refunded",
  secondsLeft: 0,
}, "Refunded: the fight disappeared from view.");

const shutdown = async () => {
  await overlay.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
