# Call It: spec

An agent that watches a streamer's game and runs bets for chat on its own: it opens a bet
when a moment starts, locks it, resolves it from what it saw, and refunds when it is unsure.
Built for the Codex x TwitchCon Hackathon (deadline 2026-11-02, 2:00 PM PT).

## Who it is for

A small streamer with no mods. Mid-game, both hands are busy, so nobody runs Predictions,
and on channels without Affiliate status Twitch's Predictions feature does not exist at all.
Call It runs the bets for them every stream, with no clicks.

## Modes

Chosen at startup from Get Users `broadcaster_type`:

- **chat mode** (any channel, the default and the live demo): the bot posts the bet in chat;
  viewers bet with `!1 <amount|all>`, `!2 <amount|all>` (up to `!10`); every viewer starts
  with 1,000 points, balances persist across streams (`!points` shows yours). Winners split
  the losing pool in proportion to their stake, like Twitch Predictions. Refunds return stakes.
- **native mode** (`affiliate` or `partner`): real Channel Points Predictions through Helix
  Create Prediction and End Prediction (LOCKED, RESOLVED, CANCELED). Tested against the
  Twitch CLI mock API; say so wherever it is described.

Both modes post a Twitch clip (Create Clip) and a stream marker (Create Stream Marker) when a
bet resolves, and post the clip URL in chat.

## The agent loop

Every `TICK_SECONDS` (default 4) while the stream is live and not in an ad break:

1. Grab the latest frame (OBS WebSocket v5 `GetSourceScreenshot` of the program scene, JPEG,
   about 768 px wide). Keep the last 3 frames.
2. Call the OpenAI Responses API with: the 3 frames, the current bet state (none / open /
   locked, with question, outcomes, seconds elapsed), the last 10 decisions, and the channel
   memory summary. The model must call exactly one tool:
   - `wait()`
   - `open_bet(question, outcomes[2..10], window_seconds, reason)`
   - `lock_bet(reason)`
   - `resolve_bet(outcome_index, evidence)`: evidence names what in which frame shows it
   - `cancel_bet(reason)`: refund; for when it lost sight of the moment or it is ambiguous
3. Code validates and executes. Code never picks the action; it only enforces limits:
   - one bet at a time; `open_bet` only when none is open, and not within `MIN_GAP_SECONDS`
     (default 60) of the last one
   - `lock_bet` / `resolve_bet` / `cancel_bet` only when a bet exists
   - no `resolve_bet` in the first 10 seconds after open
   - a bet still unresolved after `MAX_BET_SECONDS` (default 900) is cancelled by code, and
     that is logged as a timeout, not as a model decision
   - Twitch limits (verify against the Helix reference): title at most 45 characters,
     outcome titles at most 25, 2 to 10 outcomes, prediction window 30 to 1800 seconds.
     On an invalid call, return the error to the model once; if it fails again, `wait`.
4. Append every decision to `data/decisions.jsonl`: timestamp, frame hashes, model, tool,
   arguments, validation result, latency, tokens.

Model: `OPENAI_MODEL` from env. Use a fast vision-capable model from the OpenAI API models
list; check it reads a game frame correctly before wiring the loop.

## Streamer controls (broadcaster and mods, in chat)

`!callit pause`, `!callit resume`, `!callit cancel` (refund the open bet), `!callit status`.

## Twitch surfaces

- Auth: user access token via the Device Code Grant flow (no public URL needed); the bot can
  be the broadcaster's own account. Scopes (verify against the docs): `user:read:chat`,
  `user:write:chat`, `user:bot`, `channel:bot`, `clips:edit`, `channel:manage:broadcast`,
  `channel:read:ads`, `channel:manage:predictions`, `channel:read:predictions`.
- EventSub over WebSocket (`wss://eventsub.wss.twitch.tv/ws`): `stream.online` (start the
  loop), `stream.offline` (stop), `channel.chat.message` (bets and commands),
  `channel.ad_break.begin` (pause opening for the ad's duration), and in native mode
  `channel.prediction.begin`, `.progress`, `.lock`, `.end`.
- Helix: Get Users, Get Streams, Send Chat Message, Create Clip, Create Stream Marker, and in
  native mode Create Prediction, End Prediction, Get Predictions.

## Overlay

A local web page served by the app, added to OBS as a browser source. Shows the open bet
(question, outcomes, pool per outcome, time left), and after each decision one line of why
("opened: boss pull started, health bar at 100%"). Styled to read at stream size. It must be
fun to watch: the bet card appears, fills as chat bets, flips to the winner.

## Memory

`data/memory/<channel>.json`: per bet, the question, the outcome, participation (bettors and
points staked) and whether it was refunded. Before each stream the app writes a short summary
(which kinds of moments chat bet on most, which kinds it had to refund) that goes into the
model's context. This is what makes stream 5 better than stream 1.

## Replay mode and measurement

- `replay` mode runs the same loop on a folder of frames with timestamps (extracted from a
  public Twitch VOD with yt-dlp and ffmpeg at 1 frame per second), with a fake clock and a
  fake Twitch adapter. Same prompt, same tools, same guards.
- Grader: for chess VODs, the agent's bets are graded against the official game record
  (chess.com public API monthly archives, or the Lichess game export) by a script with no
  model in it. Only bets whose outcome the record can decide are graded (game result,
  game length, castling, queen trade); every other bet is reported as ungraded, never
  counted as correct.
- Output: `eval/results.json` and a short table: bets opened, graded, matched the record,
  refunded, per hour. Ablation: the same VOD hours with memory off.

## Not in scope

A Twitch Extension (review takes 5 to 14 days and judges cannot install an unreviewed one),
real money of any kind, multi-channel hosting, accounts or a web dashboard.

## Done means

On a live stream on my channel: a bet opened by the model, viewers bet in chat, the model
locks and resolves it, payouts are announced, a clip link is posted, and the decision log
shows each model call. Plus a refund case, the replay measurement on real chess VODs, a README
a judge can follow from a clean clone, and native mode passing against the Twitch CLI mock.
