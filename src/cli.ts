import { loadConfig } from "./config.js";
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
  console.log(`Stream live: ${streamLive ? "yes" : "no"}`);

  const eventsub = new EventSubClient(helix, broadcaster.id, bot.id, {
    onChatMessage: async (event) => {
      const command = event.message.text.trim().toLowerCase();
      if (command !== "!callit status") return;
      const moderator = event.badges.some((badge) => badge.set_id === "moderator") || event.chatter_user_id === broadcaster.id;
      if (!moderator) return;
      streamLive = (await helix.getStreams(broadcaster.id)).length > 0;
      await helix.sendChatMessage(broadcaster.id, bot.id, `Call It is in ${mode} mode. Stream is ${streamLive ? "live" : "offline"}.`);
    },
    onStreamOnline: () => { streamLive = true; console.log("Stream is live."); },
    onStreamOffline: () => { streamLive = false; console.log("Stream is offline."); },
    onAdBreak: () => { console.log("Ad break started."); },
  });
  await eventsub.start();
  const shutdown = () => { eventsub.stop(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const command = process.argv[2];
if (command === "live") await live();
else if (command === "replay") throw new Error("Replay mode is not implemented in this slice.");
else throw new Error("Usage: npm run live | npm run replay -- <folder>");
