import { join } from "node:path";
import { loadConfig } from "./config.js";
import { AgentBrain } from "./agent/brain.js";
import { DecisionLog } from "./agent/decision-log.js";
import { AgentLoop } from "./agent/loop.js";
import { ChatBetLedger } from "./bets/chat-ledger.js";
import { ChatBetService } from "./bets/chat-mode.js";
import { ObsFrameSource } from "./frames/obs-frame-source.js";
import { OverlayServer } from "./overlay/server.js";
import { TwitchAuth } from "./twitch/auth.js";
import { EventSubClient } from "./twitch/eventsub.js";
import { HelixClient } from "./twitch/helix.js";

async function live(): Promise<void> {
  const config = loadConfig();
  const auth = new TwitchAuth(config.twitchClientId, config.tokenPath);
  const helix = new HelixClient(config.twitchClientId, auth);
  const users = await helix.getUsers();
  const bot = users[0];
  if (!bot) throw new Error("The authorized Twitch account could not be loaded.");
  const broadcaster = (await helix.getUsers(bot.login))[0];
  if (!broadcaster) throw new Error(`Could not load broadcaster ${bot.login}.`);
  const mode = broadcaster.broadcaster_type === "affiliate" || broadcaster.broadcaster_type === "partner" ? "native" : "chat";
  console.log(`Channel ${broadcaster.display_name}: broadcaster_type=${broadcaster.broadcaster_type || "none"}, mode=${mode}`);
  let streamLive = (await helix.getStreams(broadcaster.id)).length > 0;
  const forceLive = process.env.CALLIT_FORCE_LIVE === "1";
  console.log(`Stream live: ${streamLive ? "yes" : "no"}`);

  const overlay = new OverlayServer();
  const frames = new ObsFrameSource();
  let eventsub: EventSubClient | undefined;
  const sendChat = async (message: string) => {
    const messageId = await helix.sendChatMessage(broadcaster.id, bot.id, message);
    if (messageId) eventsub?.recordSentChatMessageId(messageId);
  };

  let ledger: ChatBetLedger | undefined;
  let chatBets: ChatBetService | undefined;
  let agent: AgentLoop | undefined;
  if (mode === "chat") {
    ledger = await ChatBetLedger.open(join(process.cwd(), "data", "ledger", `${broadcaster.id}.json`));
    chatBets = new ChatBetService(ledger, sendChat, overlay);
    const decisions = new DecisionLog();
    await decisions.loadRecent();
    agent = new AgentLoop({
      frames,
      brain: new AgentBrain(),
      executor: chatBets,
      decisions,
      overlay,
    });
  } else {
    console.warn("Native prediction mode is not part of this slice. The chat-mode agent loop is not started.");
  }

  await overlay.listen();
  frames.start();

  let adBreakTimer: ReturnType<typeof setTimeout> | undefined;
  eventsub = new EventSubClient(helix, broadcaster.id, bot.id, {
    onChatMessage: async (event) => {
      const text = event.message.text.trim();
      const command = text.toLowerCase();
      if (command === "!points" && chatBets) {
        await sendChat(`@${event.chatter_user_login} has ${chatBets.balance(event.chatter_user_id).toLocaleString()} points.`);
        return;
      }
      if (command.startsWith("!callit ")) {
        const action = command.slice("!callit ".length).trim();
        const privileged = event.chatter_user_id === broadcaster.id || event.badges.some((badge) => badge.set_id === "moderator");
        if (!privileged) return;
        if (action === "status") {
          const state = agent?.status() ?? "not available";
          await sendChat(`Call It: ${mode} mode, stream ${streamLive ? "live" : "offline"}, agent ${state}.`);
        } else if (action === "pause" && agent && chatBets) {
          agent.setPaused(true);
          await sendChat("Call It paused.");
        } else if (action === "resume" && agent && chatBets) {
          agent.setPaused(false);
          await sendChat("Call It resumed.");
        } else if (action === "cancel" && agent && chatBets) {
          if (ledger?.getActiveBet()) await chatBets.cancelBet("cancelled by streamer.");
          else await sendChat("Call It has no active bet.");
        }
        return;
      }
      if (chatBets) await chatBets.handleBetMessage(event.message_id, event.chatter_user_id, text);
    },
    onStreamOnline: () => {
      streamLive = true;
      agent?.setLive(true);
      console.log("Stream is live.");
    },
    onStreamOffline: () => {
      streamLive = false;
      agent?.setLive(forceLive);
      console.log("Stream is offline.");
    },
    onAdBreak: (event) => {
      const duration = typeof event.duration_seconds === "number" && event.duration_seconds > 0 ? event.duration_seconds : 90;
      agent?.setAdBreak(true);
      if (adBreakTimer) clearTimeout(adBreakTimer);
      adBreakTimer = setTimeout(() => agent?.setAdBreak(false), duration * 1000);
      console.log(`Ad break started for about ${duration} seconds.`);
    },
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (adBreakTimer) clearTimeout(adBreakTimer);
      eventsub?.stop();
      await agent?.stop();
      await frames.stop();
      await overlay.close();
    })();
    return cleanupPromise;
  };
  const shutdown = async () => {
    try { await cleanup(); }
    finally { process.exit(0); }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  try {
    await eventsub.start();
  } catch (error) {
    await cleanup();
    throw error;
  }
  agent?.setLive(streamLive || forceLive);
  if (forceLive && !streamLive) console.log("CALLIT_FORCE_LIVE=1 is enabled. The agent loop is running offline for testing.");
}

async function replay(folder: string | undefined): Promise<void> {
  if (!folder) throw new Error("Usage: npm run replay -- <folder>");
  throw new Error(`Replay agent execution is not wired yet for ${folder}.`);
}

const command = process.argv[2];
if (command === "live") await live();
else if (command === "replay") await replay(process.argv[3]);
else throw new Error("Usage: npm run live | npm run replay -- <folder>");
