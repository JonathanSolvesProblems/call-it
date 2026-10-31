# Phase 0 card

Filled in before the first commit. Every fill marker gets a real answer, and a field
with a RED condition met is either fixed (say how) or the verdict is not GO. The
commit hook blocks commits while any fill marker remains or the verdict is not GO.
Long-form reasoning for each field: `~/.claude/hackathon-archive.md`, section
"Gate checks, long form", and the rules cited in brackets.

Working idea: **Call It**. An agent that watches a streamer's game and runs Twitch
Predictions on its own: it opens a bet when a moment starts, locks it, resolves it
from what it saw, and refunds when it is unsure. Sources for every field are the
event's Overview, Rules and Resources pages (read 2026-10-25), the 2024 Twitch
Streamer Tools gallery (all 53 entries) and winner posts, the 2019 TwitchCon
gallery, Devpost-wide project search, and the Twitch Predictions guide.

## 1. Event, odds, currency [rules 16, 29, 75, 79, 92]
- Event, deadline, results date: Codex x TwitchCon Hackathon (Devpost, sponsor Amazon Advertising LLC for Twitch, with OpenAI). Submissions Oct 23 to **Nov 2, 2026, 2:00 PM PT**. Judging Nov 5 to 15. Winners announced live at TwitchCon San Diego on or around Nov 15; top 5 get stage time at the Codex booth.
- Entries (gallery count, or last edition's): 605 registered, gallery unpublished. Last Twitch edition (Streamer Tools Hackathon 2024) had 894 registered and **53 submissions** (5.9%), so expect roughly 35 to 60 entries here. 5 cash places, so the base rate is roughly 8 to 14%, the best odds of any open event this month.
- Prizes I am eligible for, and the track I enter (smallest defensible, plus every parallel track): one pool, no tracks: 1st $10,000, 2nd $6,000, 3rd $4,000, two runner-ups $2,500. Eligibility: Quebec residents are excluded; Jonathan confirmed on Sept 21 that he is not a Quebec resident.
- What the event pays out for (its currency), and proof I can produce it in the window: a judges' score on four equal criteria (Innovation, Potential Impact "useful or entertaining for streamers and their communities", Technological implementation "how well does it use Codex", Design "easy to use and fun to watch"), after a pass/fail on theme fit and Codex use. Mintable: a working Twitch integration in a video plus a **Codex session ID for the thread where most of the project was built**. That last item means the build itself runs in Codex, not in Claude Code.
- Other builds I am running in this window: YouCamSkin2 (due Nov 2) and MetaVR (due Nov 18). Jonathan confirmed on 2026-10-25 that YouCamSkin2 is not a conflict for this build. Floodplain, Still Works and Last Seen are submitted. Field well under 1,000, so not RED.
- Codex plan: none needed. The FAQ says "Use the free version of Codex. Free usage has limits," so the build has to spend its Codex budget on code: a written spec and AGENTS.md go in before the first thread, and I keep headroom for final fixes.
- RED: currency I cannot mint; only an open catch-all track; field over 1,000 entries while another major build is running.

## 2. The winners' verb [check 1, rules 76, 87, 93]
- Three winners of the last comparable event, and what each one's user ended the session HOLDING: 2024: **PixelWars** (viewers hold a battle their chat fought against another community, paid in Bits); **tcghud** (the streamer holds a live HUD naming the trading card on camera with its price); **Stream Together Timeline** (a timeline of collab sessions and their clips). Runner-ups: viewers holding control of mobs in the streamer's Minecraft world; a chat game of finding the light switch on a blacked-out screen. 2019: **OK Gamers** ("Ok gamers, right or left?", chat steers) and **Summon TV** (viewers spawn wolves and weather in the streamer's game for Bits).
- That in one verb, and the adjectives on its object from the title, subtitle and track text: chat **plays along**, live, on the streamer's own content. Event text: "Give chat a way to play along, help streamers create together, or add something new to enhance the content they stream"; criteria adjectives: "creative and novel", "useful or entertaining", "fun to watch".
- What my user ends the session holding: chat holds a bet on the exact moment it is watching and the channel points it won; the streamer holds a stream where predictions ran all session with no hands off the controller, plus a clip and a VOD marker for every resolved call.
- RED: they make and I check; I am building beside the main event (governor, watcher, infrastructure, wrapper, auditor). Pass: the agent makes the play (the bets chat plays), it does not audit anything.

## 3. A person, and how often [rules 12, 22, 93, 95, 98]
- The person (me, someone I interviewed, or a labelled composite) and the moment the story opens on: me. I streamed casually (WoW and other games), never Partner, no mods, no footage kept. The moment: mid pull, both hands on the keyboard, and anything chat could play along with had to wait until I let go. Predictions are Twitch's chat betting game, and they need someone to open, lock and resolve each one, which is a mod's job on big channels and nobody's job on small ones. The demo is me streaming again with Call It running. Do not claim chat asked me for predictions back then unless Jonathan confirms it (Predictions launched on Twitch in late 2020).
- Times per month they hit this task: every stream, several moments per stream; a 3 to 5 stream week is 12 to 20 streams a month, each with many prediction-worthy moments. Passes the floor of 4 by a wide margin.
- RED: no person; story opens on a statistic; under 4 a month at an event whose text says chore, repetitive, everyday or background (unless the agent keeps working on a schedule between visits); the idea came from hardware I own. Pass, with the composite labelled as one.

## 4. The loop [rule 103]
- "At step X the model chooses between A, B and C, based on what it just observed": every few seconds an OpenAI vision model receives the latest frames, the open prediction (if any) and the channel's memory, and chooses one tool: **wait**, **open** a prediction (it writes the question, 2 to 10 outcomes and the window from what is on screen), **lock** it early (the moment is about to resolve), **resolve** it to outcome k (citing the frame it saw), or **cancel and refund** (it lost sight of the moment or the result is ambiguous). The streamer can veto any call with one chat command.
- RED: no real branch; the model only classifies or summarises at steps my code fixed; the only agent-framework object is a chat. Pass: five actions, the model picks which and when; code only enforces Twitch's limits (one active prediction, 2 to 10 outcomes).

## 5. Where the result lands [rules 4, 27, 33, 101, 103]
- The system the result is written into, which the user already opens (email, ticket, PR, filing, calendar, the sponsor's product): Twitch itself. Native Channel Points Predictions (Helix Create and End Prediction), an announcement in chat, a Twitch clip (Create Clip) and a stream marker (Create Stream Marker) at every resolution, so the streamer's Clips and VOD already hold the moments afterwards. **Gate: the Predictions API works only for Affiliate or Partner channels (Twitch docs: "Running predictions is available to partners and affiliates only").**
- What the agent keeps and does on its own after the first run: it starts by itself on EventSub `stream.online`, pauses on `channel.ad_break.begin`, and keeps a per-channel memory of which kinds of moments chat bet heavily on (from `channel.prediction.progress`) and which it had to refund, which shapes what it opens next stream.
- RED: the only destination is a page I built; nothing persists; nothing happens after the report. **Resolved 2026-10-25: Jonathan's channel is not Affiliate.** Re-aimed so the gap is the pitch: Predictions are locked behind Affiliate, and a small streamer like me never had them. Call It runs in two modes chosen from the channel's `broadcaster_type`: **chat mode** (any channel: the bet is posted in chat, viewers bet with `!1` / `!2` and a persisted points balance, payouts announced in chat, the way small-channel bots like Nightbot and StreamElements already run points) and **native mode** (Affiliate and Partner: real Channel Points Predictions). Both modes post a Twitch clip and a stream marker per resolution, which need no Affiliate status. The live demo runs chat mode on my channel; native mode is tested against the Twitch CLI mock API and labelled as such unless an Affiliate friend runs it live. Chat, clips and VOD markers are systems the streamer already opens, so this is not a page I built.

## 6. The headline number [check 5, rules 59, 65, 67, 102, 104]
- The number, in world units (seconds, dollars, cases, people): out of N predictions the agent opened on its own across X hours of real chess streams, how many it resolved the same way the official game record did, and how many it refunded rather than guess. Second number: predictions run per hour against the zero a solo streamer runs mid-game.
- Who grades it, that I did not build and cannot influence: the chess.com public game archive and the Lichess game export (result, moves and timestamps of the very games on the VODs). Chess is chosen for the grade because it has an official record; the agent itself reads only pixels and is game-agnostic.
- The sponsor-model call that produces it: the OpenAI vision call that chooses `resolve(k)` or `cancel`, logged per call with the frames it saw.
- Can it be collected (would a busy stranger answer this in one sentence): yes, it needs no counterparty; both archives are public APIs, and Twitch VODs are public.
- If the system beats an official record, that sentence, written as a win: not applicable yet. If it catches a game where the stream overlay and the official record disagree (a disconnect, an abort), that goes in the tagline.
- RED: my code grades my code; a counterfactual my code both causes and counts; it needs information counterparties withhold. Pass.

## 7. Sponsor surface [check 6, rules 72, 88, 97, 105]
- The sponsor's primitive (models, APIs, tools, SDK features, managed services, data volume): Twitch: chat, overlays, Helix API, EventSub, Extensions. OpenAI: Codex as the build tool (the judged usage), and OpenAI models at runtime.
- Every service and bonus item the brief lists, with my planned use beside each: **Chat**: EventSub `channel.chat.message` for the veto command and Send Chat Message for calls. **Overlay**: an OBS browser source showing what the agent saw and why it called it. **Twitch API**: Create Prediction, End Prediction (LOCKED, RESOLVED, CANCELED), Get Predictions, Create Clip, Create Stream Marker, Get Streams. **EventSub**: `stream.online`, `stream.offline`, `channel.prediction.begin`, `.progress`, `.lock`, `.end`, `channel.ad_break.begin`, `channel.chat.message`. **Extension**: skipped on purpose; the FAQ warns review takes 5 to 14 days and judges cannot install an unreviewed one. **Codex**: one main build thread (session ID), AGENTS.md, Codex cloud tasks for parallel work, Codex code review on each PR, and the "how I used Codex" segment of the video. **OpenAI runtime**: a vision model with tool calling for the loop; optional voice announcer.
- Winners' or nearest neighbours' count of that primitive, against my planned count: 2024 winners each touched 2 to 4 Twitch surfaces (PixelWars: Extension, Bits, chat; tcghud: overlay plus vision). Planned: 4 of the 5 listed surfaces and about 14 endpoints and subscriptions. Codex usage count of winners is unknowable before results.
- Data size, against what the sponsor's product is for: live streams plus hours of public VOD footage for the measurement; predictions are a per-stream feature, so stream-hours is the right unit.
- The ablation (same task, sponsor switched off) and what I expect it to show: same VOD hours with the vision model off: zero predictions opened, since nothing else watches the game. Second ablation: memory off against memory on, measured as refunds per hour.
- RED: my count is below the winners' median; a named bonus skipped; the product still works with the sponsor switched off. Pass (the Extension is a listed path, not a bonus, and skipping it follows the FAQ).

## 8. The crowd, measured [check 7, rules 30, 71, 94, 99]
- Gallery search terms, and how many taglines state my thesis (or funded products, if the gallery is dark): event gallery unpublished. Proxy: Devpost-wide search "twitch codex" (24 results, about 16 look like this event's entries): chat-driven games 6 (Mythweave, Chat Detective, RallyRoom, CHAOS//ARENA, Chat Makes a Movie, ChatSprint), chat drives Codex 3 to 4 (Chat Ships It, Never Ending Build, Jitters on stream, Paige), clip tools 4 (ClipScout, Clippy, ClipEZ, PixelPulse), AI co-hosts 2 (Paige, Wrenone). **Predictions: 0.** Devpost history for "twitch prediction": Prediction.chat (event-detection overlay POC, no betting loop), HypeMarket and StreamStakes (esports and speedrun betting sites, not native predictions), Dedpool (LoL gambling on Theta). Existing tools: Streamer.bot can resolve predictions programmatically, triggered by hand; no vision-driven auto-prediction product found.
- Did that crowd win last time? The biggest neighbour's size number, against mine: no prediction entry among the 2024 edition's 53. The crowd this time sits on chat games and chat-drives-Codex; I am outside both. Re-run this field when the gallery publishes.
- devpost.com/stephensookra checked (Devpost events): checked 2026-10-25; no Twitch or Codex x TwitchCon entry in his portfolio.
- RED: the crowd is losing; the crowd is winning and mine is the smallest build in it. Pass.

## 9. Who pays the sponsor [check 8, rules 69, 70, 78]
- Who pays the sponsor, and does this make them buy more: the sponsor is Amazon Advertising on behalf of Twitch, which earns from ads, subs and Bits, all of which grow with watch time and chat engagement. Predictions running all stream keep viewers watching to see their bet resolve, including through ad breaks (a call opened before the break resolves after it). OpenAI gets a working Twitch product built in Codex with its vision model in the loop.
- Would the sponsor's sales team show it on Monday: yes: "your channel runs predictions by itself" is a Twitch feature pitch to small streamers, and Codex booth staff can demo it.
- RED: it argues their customers out of buying; the headline is the sponsor's product failing. Pass.

## 10. Traps and name [check 2, rules 40, 44, 63, 100]
- User and subject (if different, is the subject a person being measured): user is the streamer; subject is the game on screen. Viewers opt in by betting. Nobody is measured without asking.
- The genre in three seconds, "it is X but with Y": "a Twitch prediction bot, but it watches your game and opens, locks and pays out the bets itself."
- Name checked in the package registry, GitHub, the hackathon gallery and my own projects: "Call It": GitHub repo search for callit + twitch returns 0; the gallery is unpublished; not used in my projects. npm still to check before the repo is named.
- RED: a human subject who did not ask; no nameable genre; infrastructure as the product; the name is taken in my namespace. Pass. Note for the write-up: channel points have no cash value; say "chat bets channel points", never "gambling".

## 11. Pitch and tagline [check 4, rules 56, 104]
- "[person] can [want] and [outcome with a price on it]": a small streamer with no mods and no Affiliate badge can give chat the betting game Twitch keeps for Affiliates, on every clutch moment, without touching anything, and goes from zero bets mid-game to [N per hour], each one resolved the way the official game record says. On Affiliate channels the same agent drives real Channel Points Predictions.
- Tagline draft, leading with the best result as a win: "Call It watches your game and runs your Twitch predictions: across [X] hours of real chess streams it called [Y of N] the way the official game record did, and refunded the rest instead of guessing." Numbers filled on measurement day.

## 12. Demo [rules 25, 54, 101]
- The final shot (the thing the verb produces, or a live success landing in field 5's system, never a number being revealed): live on Twitch, a bet the agent opened on its own resolves the second the moment ends: the payout message in chat, the clip link posted under it, and my hands still on the keyboard.
- The first live end-to-end success, on real data, with the sponsor's model in the loop, by (date, day 3 at the latest): **Oct 28, 2026**: a real stream on my channel, a bet opened, locked and resolved by the model in chat mode, with a clip posted.

## Verdict

**Verdict:** GO (2026-10-25).

Answered 2026-10-25: YouCamSkin2 is not a conflict; no paid Codex plan needed (free tier per FAQ, upgrade only if the cap stops the build); the person is Jonathan, a former casual WoW streamer; his channel is not Affiliate; he will supply an OpenAI API key for the runtime model. The build runs in one Codex thread (CLI 0.144.4 and the Codex app are installed); Claude Code does the card, spec, review and measurement, disclosed in the write-up.

Fixes made for each RED: field 5's conditional RED (no Affiliate channel) is fixed by chat mode as the primary path, with native Predictions as the Affiliate path, tested on the Twitch CLI mock and labelled as such. No other field is RED.
