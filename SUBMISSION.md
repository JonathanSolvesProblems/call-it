# Devpost submission: final values only

One field per block. Paste as is.

## Project name

```
Call It
```

## Tagline

```
An agent that watches your game and runs your Twitch predictions: it opens the bet, locks it, pays out and clips the moment. 10 of 12 payouts matched chess.com's record on a stream it had never seen.
```

## Description

```
I used to stream WoW on a small channel. Mid-pull, both hands on the keyboard, my chat could only watch. Twitch has a betting game for exactly that moment, Predictions, but it is locked behind Affiliate, and even with it someone has to start every bet and call the result by hand.

Call It does that job. It watches the game through OBS and runs prediction bets in chat: it opens them when a fight is about to start, locks them near the end, settles them when the result is on screen, and posts a clip and a stream marker. Any channel can run it. No Affiliate, no mods, no server to host.

What happened on stream

On my own game (Orvandel, an MMO I built), live on Twitch: a boss title card appears and Call It opens "Will The Bellows be defeated?" in chat. A viewer bets !1 300 (my main account, playing the viewer). Near the end of the fight it locks. When the kill banner shows, a fast model proposes the result and a second, stronger model checks the frames before anyone is paid. The payout lands in chat with a clip link, and a marker goes into the VOD. When it cannot see a result, it refunds: it once opened a bet while I was talking to a quest-giver, saw no fight, and gave everyone their points back.

How it decides

Every 4 seconds gpt-5.4-mini sees the last three OBS frames, the bet state and the recent decisions, and must call exactly one tool: wait, open_bet, lock_bet, resolve_bet or cancel_bet. Code never picks the action; it only enforces limits (one bet at a time, a gap between bets, question and outcome length, a timeout refund, spend caps). A proposed payout goes to a second look on gpt-6.1-sol, which sees the proposal frames and the newer frames and settles on the outcome the frames prove, or rejects it. Every decision, with the frames it saw, is in the decision log.

Measured against something I do not control

I replayed real chess streams through the same loop and graded every game-result payout against chess.com's public game records with a script that has no model in it. On a 2.4-hour stream Call It had never seen, 10 of 12 payouts matched the record and it refunded 8 bets instead of guessing. The second look stepped in on 11 of 18 proposed payouts (5 wrong winners corrected, 6 payouts from another game's result rejected) and was right all 11 times. Before those fixes, on the stream I tuned on, it was 4 of 10. Run files, decision logs and grades are in eval/results/.

Built with Codex

All product code was written in OpenAI Codex, in one thread, from SPEC.md and AGENTS.md: 18 prompts, 26 commits, 72 tests. Codex wrote the Twitch EventSub client, the device-code auth, the agent loop and tool schemas, the guards and spend caps, the points ledger and payout math, the second look, the clip and marker calls, the overlay, replay mode and the chess grader. Every prompt I sent is in CODEX_PROMPTS.md in the order it was sent, and the commit history shows the build step by step. I used Claude Code alongside Codex for planning, prompt review, live testing and the evaluation runs.

Twitch surfaces used

EventSub over WebSocket (channel.chat.message, stream.online, stream.offline, channel.ad_break.begin), Helix Send Chat Message, Create Clip, Create Stream Marker, Get Users, Get Streams, the Device Code Grant for login, and an OBS browser-source overlay.

Limits

Chat mode with its own points; native Channel Points Predictions for Affiliate channels are the next step. Clips and markers only while really live. The agent reads pixels and can be wrong, which is why every payout gets a second look and the streamer can refund with !callit cancel. Live mode defaults to a 600-call cap. Measured on one streamer's chess VODs, so the held-out run tests unseen games, not an unseen layout.
```

## Built with

```
typescript, nodejs, openai, codex, twitch-api, eventsub, obs-websocket, vitest, ffmpeg
```

## Links

```
Repository: https://github.com/JonathanSolvesProblems/call-it
Demo video: <youtube url>
Live VOD (Twitch): https://www.twitch.tv/videos/2916119628
Clip Call It made: https://clips.twitch.tv/SoftSpeedyPassionfruitPunchTrees-mnfpV8CfdPDOgDs2
```

## YouTube title

```
Call It: an AI agent runs Twitch predictions while you play (Codex x TwitchCon Hackathon)
```

## YouTube description

```
Call It watches your game through OBS and runs prediction bets in your Twitch chat: it opens them when a fight starts, locks them near the end, settles them when the result is on screen, and posts a clip and a stream marker. Any channel can run it, no Affiliate needed.

Measured on a 2.4-hour chess stream it had never seen: 10 of 12 payouts matched chess.com's official game record, 8 bets refunded instead of guessed. Every payout is checked by a second model before anyone is paid.

Built in OpenAI Codex in one thread (18 prompts, 26 commits, 72 tests) for the Codex x TwitchCon Hackathon.

Repo: https://github.com/JonathanSolvesProblems/call-it
Live VOD: https://www.twitch.tv/videos/2916119628

0:00 Why
0:33 Live on Twitch: a bet opens on its own
0:56 The second look, payout, clip
1:12 When it can't see the result, it refunds
1:24 Graded against chess.com
1:45 Built with Codex
2:10 Setup
2:17 Call it
2:21 Bonus: from the stream
```

## Image gallery

Upload `preview/1-hero.png` through `preview/8-codex.png` in that order. One caption per image is in `preview/captions.md`; copy the block contents only.

## Codex session ID

```
01a175ec-d56d-77c1-b2ca-0b079719d3ee
```

## Testing notes for judges

```
Clean clone, npm install, copy .env.example to .env, add your own Twitch Client ID (public app, device-code login) and OpenAI key, enable OBS WebSocket, npm run live. Everything a judge needs is in README.md. Do not use anyone else's API key: live mode is capped at 600 model calls and 30 minutes in force-live mode. The numbers in the description can be checked without spending anything: eval/results/ holds the run files and grades, and npm run grade re-grades them with no model calls.
```
