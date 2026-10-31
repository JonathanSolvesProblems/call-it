# Call It

Call It watches your game through OBS and runs prediction bets in your Twitch chat: it opens them, locks them, settles them and clips the moment.

## Who it is for

Call It is for small streamers who do not have moderators to run bets while they play. Twitch Predictions require Affiliate or Partner status, so many small channels cannot use them. Call It runs the same kind of prediction in chat with points that have no cash value.

## How it works

1. [ObsFrameSource](src/frames/obs-frame-source.ts) captures a JPEG from OBS every 2 seconds. It uses `OBS_SOURCE_NAME` when set, otherwise it captures the program scene.
2. Every 4 seconds, [AgentLoop](src/agent/loop.ts) sends the newest 3 frames, the active bet, and recent decisions to the OpenAI Responses API. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. The model must choose one tool: `wait`, `open_bet`, `lock_bet`, `resolve_bet`, or `cancel_bet`.
3. [guards.ts](src/agent/guards.ts) enforces limits. It allows one active bet; enforces the minimum gap between bets (except for a boss); limits questions to 90 characters in chat mode, outcomes to 25 characters, outcomes per bet to 2 through 10, and bet windows to 30 through 1,800 seconds; keeps a bet open at least 30 seconds before locking or resolving unless the outcome is already visible; and waits at least 20 seconds before cancellation unless the scene left the moment. It also blocks actions while offline, paused, or in an ad break. A timeout refunds the bet. Invalid tool calls get one correction attempt.
4. Before paying a proposed result, [AgentBrain](src/agent/brain.ts) makes a second call with `OPENAI_RESOLVE_MODEL` (default `gpt-6.1-sol`). It sees the proposal frames and newer frames, then confirms an outcome or rejects it. A confirmation can correct the first outcome.
5. [ChatBetService](src/bets/chat-mode.ts) updates balances and announces the result or refund. While the channel is live, [TwitchMomentRecorder](src/twitch/moment-recorder.ts) creates a marker and clip after the payout message, then posts the clip link. [ChatBetLedger](src/bets/chat-ledger.ts) stores the result, clip details, and marker position.

## Setup

Tested on Windows with Node.js 22 and npm. From a clean clone:

```powershell
npm install
Copy-Item .env.example .env
```

Create a **Public** Twitch app. No redirect URL is needed because Call It uses the Device Code Grant. Enable OBS WebSocket in OBS, then set the values below in `.env`. Never commit `.env`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `TWITCH_CLIENT_ID` | Public Twitch app Client ID. | required |
| `OPENAI_API_KEY` | OpenAI API key for the agent. | required |
| `OPENAI_MODEL` | Model for normal agent ticks. | `gpt-5.4-mini` |
| `OPENAI_RESOLVE_MODEL` | Model for second-look payout confirmation. | `gpt-6.1-sol` |
| `OPENAI_IMAGE_DETAIL` | Image detail sent to the model: `high`, `low`, or `auto`. | `high` |
| `OBS_WS_URL` | OBS WebSocket address. | `ws://127.0.0.1:4455` |
| `OBS_WS_PASSWORD` | OBS WebSocket password, if configured. | blank |
| `OBS_SOURCE_NAME` | OBS source to capture, such as `Window Capture`; blank captures the program scene. | blank |
| `OBS_FRAME_WIDTH` | Screenshot width in pixels. | `1280` |
| `FRAME_SECONDS` | OBS capture interval. | `2` |
| `TICK_SECONDS` | Agent tick interval. | `4` |
| `MIN_GAP_SECONDS` | Minimum time between opening bets. | `180` |
| `MAX_BET_SECONDS` | Maximum bet lifetime before an automatic refund. | `900` |
| `CALLIT_FORCE_LIVE` | Run the agent while Twitch reports the channel offline. | `0` |
| `CALLIT_MAX_MINUTES` | Runtime cap when force-live is enabled. | `30` |
| `CALLIT_MAX_MODEL_CALLS` | Live model-call cap. Blank uses 600 in live mode and no cap in replay. | `600` live |
| `OVERLAY_PORT` | Local overlay web server port. | `4545` |

On first launch, authorize the Twitch account in the terminal using the displayed device code. The token is stored in `data/token.json`.

## Run it

```powershell
npm run live
```

For an offline test, set `CALLIT_FORCE_LIVE=1`. Force-live stops after `CALLIT_MAX_MINUTES`; set a small `CALLIT_MAX_MODEL_CALLS` to cap test spend too. At a 4-second tick, one hour is about 900 normal model calls, before confirmation and correction calls.

Viewers can use `!1 100`, `!2 all` (up to `!10`), or `!1` for a 100-point bet. `!points` shows a balance. The broadcaster and moderators can use `!callit pause`, `!callit resume`, `!callit cancel`, and `!callit status`.

Add `http://127.0.0.1:4545/overlay` as an OBS browser source. The debug page is at `http://127.0.0.1:4545/debug`.

## Measure

Replay a folder of one-frame-per-second JPEGs named by VOD offset, with a `vod.json` file:

```powershell
npm run replay -- <folder>
npm run replay -- <folder> --from 0 --to 600 --max-calls 150
npm run grade -- <runDir> <games.json>
npm run eval:confirm -- 5
```

Replay uses the same prompts, tools, guards, and second look with a fake clock. Its chat and moment recorders only log and never call Twitch. The grader has no model and makes no network calls. It compares game-result bets with the supplied chess.com game records. Confirmation evaluation uses the configured resolve model and the cases in `eval/confirm-cases/`.

## Results

Measured on real Twitch VODs of Anna Cramling playing chess.com blitz. [eval/grade.ts](eval/grade.ts) grades each game-result payout against chess.com's public game archive. The grader has no model in it.

| | Tuning VOD, before fixes | Held-out VOD |
| --- | --- | --- |
| VOD | [2912243465](https://www.twitch.tv/videos/2912243465) (Oct 27) | [2893451280](https://www.twitch.tv/videos/2893451280) (Oct 6) |
| Hours / games | 2.81 / 14 | 2.42 / 13 |
| Bets the agent opened on its own | 21 | 22 |
| Game-result payouts graded | 10 | 12 |
| Matched the chess.com record | 4 | **10** |
| Did not match | 6 | 2 |
| Refunded instead of guessing | 3 | 8 |
| Ungraded | 8 | 2 |

- The held-out VOD was never used for tuning. It ran on commit `0215e17`: 2,179 model calls, 11.3M input tokens.
- Both held-out misses were bets opened after a game had already ended. A prompt rule added after the run targets this; the held-out run was not repeated, so it stays an untuned number.
- The second look on `gpt-6.1-sol` stepped in on 11 of 18 proposed payouts in the held-out run: it corrected the winner 5 times and rejected 6 payouts that used another game's result. All 11 were right by the record.
- `npm run eval:confirm` passes 40 of 40 checks on 8 saved cases (6 chess, 2 from my own game).
- Limits of this measurement: one streamer and one site, so the held-out VOD tests unseen games, not an unseen layout (other chess streamers' VODs were subscriber-only). The grader was fixed after seeing the held-out run; the fixes made it stricter on timing and tolerant of misspelled names. The first grade is kept in [grade-before-grader-fix.json](eval/results/2893451280-heldout/grade-before-grader-fix.json) (7 of 7 matched).

Files: [eval/results/2893451280-heldout/](eval/results/2893451280-heldout/) and [eval/results/2912243465-run1/](eval/results/2912243465-run1/), each with the bets, the full decision log and `grade-final.json`.

## Limits

Call It runs bets in chat mode only. Native Channel Points Predictions for Affiliate channels, and a per-channel memory of which moments chat bets on most, are future work. Clips and stream markers are attempted only while Twitch reports the channel live. The agent sees pixels and can misread them. The second look reduces payout mistakes, but does not guarantee correctness. The broadcaster or a moderator can use `!callit cancel` to refund an active bet. Live mode defaults to a 600-call cap; force-live also stops after 30 minutes.

## How it was built

The project was built in OpenAI Codex in one main thread (session ID: `01a175ec-d56d-77c1-b2ca-0b079719d3ee`). Planning, prompt review, live testing, and evaluation runs were done with Claude Code. The prompts sent to Codex are recorded in [CODEX_PROMPTS.md](CODEX_PROMPTS.md).
