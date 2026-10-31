# Codex prompts

Paste these into ONE Codex thread, in order. That thread's session ID goes on the
submission form (`/status` shows it). Start each prompt only after the previous one's
"done when" check passes. Fix prompts from review get pasted into the same thread.

Day plan: slices 1 to 3 by Oct 28 (day 3: first live end-to-end success).

---

## Slice 1: skeleton, Twitch auth, EventSub, chat

Read AGENTS.md, SPEC.md and PHASE0.md. We are building Call It as described in SPEC.md.

This slice: set up the TypeScript project per AGENTS.md (typecheck, test, live scripts,
`.env.example`, `.gitignore` with `.env`, `data/` and `tmp/`), then:

1. Twitch user auth with the Device Code Grant flow, requesting the scopes in SPEC.md.
   Store the token and refresh token in `data/token.json`; refresh on 401 once.
2. A Helix client with Get Users and Send Chat Message.
3. An EventSub WebSocket client: connect, read the welcome `session_id`, create the
   subscriptions for `channel.chat.message`, `stream.online`, `stream.offline`,
   `channel.ad_break.begin`; handle keepalive, `session_reconnect` and revocation.
4. On startup, log the channel's `broadcaster_type` and the mode it implies (chat or native).
5. Chat command `!callit status` (broadcaster or mod only) replies in chat with the mode
   and whether the stream is live.

Done when: `npm run live` with my `.env` connects, and typing `!callit status` in my
channel's chat gets a reply from the bot. Write unit tests for the EventSub message
parsing with recorded sample payloads.

---

## Slice 2: frames and overlay

Slice 2: the agent's eyes and the overlay. Same rules as before (AGENTS.md, SPEC.md).

1. A `FrameSource` interface in `src/frames/`: `latest(n)` returns the last n frames, each
   `{ timestampMs, jpegBase64, sha256 }`.
2. `ObsFrameSource`: connect with obs-websocket-js to `OBS_WS_URL` (default
   `ws://127.0.0.1:4455`) and `OBS_WS_PASSWORD` from env. Every `FRAME_SECONDS` (default 2)
   call `GetCurrentProgramScene`, then `GetSourceScreenshot` on that scene as JPEG, width 768,
   quality 70. Keep a ring buffer of the last 5. If OBS disconnects, log it and retry every
   5 s without crashing the app.
3. `ReplayFrameSource`: reads a folder of JPEGs named by second offset (`000123.jpg`) and
   serves them against an injectable clock, so replay and tests run faster than real time.
4. Overlay server in `src/overlay/`: Node http on `OVERLAY_PORT` (default 4545) serving
   `/overlay` (transparent background, for an OBS browser source at 1920x1080) and `/debug`
   (latest frame thumbnail plus the last 10 decisions, for my demo video), and a `ws` endpoint
   that pushes state: the bet (question, outcomes with points and bettor counts, status
   open / locked / resolved / refunded, seconds left), the last decision's one-line reason,
   and paused / ad break.
5. The overlay must be fun to watch: a bet card that slides in when a bet opens, bars that
   grow as chat bets, a lock state, and a clear winner flip or "refunded" state. Big type,
   readable over gameplay, no external fonts or CDNs.
6. `npm run frames:test`: grab one frame from OBS, save it to `tmp/frame.jpg`, print its size
   and how long the grab took.
7. `npm run overlay:demo`: drives the overlay through open, bets arriving, lock, resolve,
   then a refund, with the page showing a small "DEMO DATA" label the whole time.

Done when: `npm run frames:test` saves a real frame from my OBS, and `npm run overlay:demo`
plays correctly inside an OBS browser source. Tests for the ring buffer and the replay clock.
Commit when done.

## Slice 3: the agent loop and chat-mode bets

Slice 3: the agent loop and chat-mode bets (SPEC.md "The agent loop", "Modes", "Streamer
controls"). This is the slice that has to work live by Oct 28. Your sandbox cannot reach
OpenAI, Twitch or OBS; skip live checks, I run them outside.

1. `src/agent/`: the loop. Each tick, send the last 3 frames from the FrameSource, the bet
   state (none / open / locked with question, outcomes, pool per outcome, seconds elapsed),
   and the last 10 decisions to the OpenAI Responses API with the five function tools from
   SPEC.md (strict schemas, `tool_choice: "required"`, image `detail` from
   `OPENAI_IMAGE_DETAIL`, default `high`). Model from `OPENAI_MODEL`, default `gpt-5.4-mini`;
   send `reasoning: { effort: "low" }` only for gpt-5 and gpt-6 models. Never overlap calls:
   the next tick starts `TICK_SECONDS` (default 4) after the previous call returned. Read
   `response.output` for the function_call; if there is none, log it and treat as wait.
2. The system prompt: the agent runs bets for a small streamer's chat. Open only when a
   moment with an uncertain outcome is starting that will be decided on screen within a few
   minutes (a fight, a boss pull, a race, a risky attempt), name what is on screen (use the
   names the game shows), lock when the outcome is about to be decided, resolve only when a
   frame shows the outcome and cite it, cancel when the moment ended without a visible
   outcome or the scene left it for good. A loading screen or menu during an open bet is a
   reason to wait, not to cancel, unless it lasts more than 60 s. Include 3 short few-shot
   examples for the ambiguous cases (combat already midway: open only if the outcome is
   still open; a loading screen mid-bet: wait; the boss bar gone with no victory or wipe
   shown: cancel). No confidence scores anywhere.
3. Guards in code exactly as SPEC.md lists, each with a vitest test. Code also locks the bet
   when its window ends (logged as `window_end`, like Twitch does) and cancels after
   `MAX_BET_SECONDS` (logged as `timeout`). An invalid tool call returns the error to the
   model once in the same tick; a second invalid call becomes a wait.
4. Decision log: append every tick to `data/decisions.jsonl` (time, frame hashes, model,
   tool, arguments, guard result, latency ms, input and output tokens) and push the latest
   to the overlay and /debug.
5. `src/bets/` chat-mode ledger: `data/ledger/<channel>.json`, 1,000 points to start,
   `!1 200`, `!2 all`, `!1` alone means 100; one outcome per viewer per bet (adding to the same
   outcome is fine); bets only while open; count each chat message once by message id.
   Payout: winners split the losing pool in proportion to their stakes, integer points,
   floor each share and give any remainder to the largest winning stake; refunds return
   every stake. Tests for the payout math including the remainder and a bet with no winners.
6. Chat messages (keep them short, never one per bet placed): on open "BET: <question> |
   !1 <outcome 1> | !2 <outcome 2> ... | closes in <n>s", on lock the pools per outcome,
   on resolve the winning outcome, winner count and the biggest win, on cancel "Refunded:
   <reason>". `!points` replies with the viewer's balance. `!callit pause|resume|cancel|status`
   for broadcaster and mods.
7. Wire it into `npm run live`: start the loop when the stream is live (check on startup and
   on `stream.online`), stop on `stream.offline`, no new bets during an ad break.
   `CALLIT_FORCE_LIVE=1` runs the loop even when offline, for testing.
8. `npm run agent:once -- <jpg> [<jpg> <jpg>]`: one model call on those frames with an empty
   bet state, printing the tool and arguments. I use it to test prompts on real game frames.

Done when typecheck and tests pass. Commit in small steps.

## Slice 3 review fixes

Review fixes for slice 3, from running agent:once on real game frames:

1. Names: at 768 px the model misspells on-screen names ("Canor Ambrose Vey"); at 1280 px it
   reads them right. Make the OBS screenshot width `OBS_FRAME_WIDTH`, default 1280.
2. Question length: the 45/25 character limits are Twitch's native Prediction limits. In chat
   mode allow a question up to 90 characters (outcomes stay at 25). Put the active limits in
   the per-tick context text so the model writes within them instead of burning a
   correction round. Keep 45/25 in native mode. Update the guard tests.
3. No frames: if there are no frames, or the newest frame is older than 10 seconds (OBS
   disconnected), skip the model call and log `no_frames`. Never call the model without
   current frames.
4. Prompt: on-screen text is evidence. Title cards, combat log lines, loot messages and
   victory, defeat or reset banners count as a visible outcome. A title card naming a boss or
   encounter as it appears is the clearest moment to open. Use names exactly as the game
   writes them. Keep it game-agnostic: no game-specific names in the prompt.

Run typecheck and tests, commit.

## Fixes from the first live run (2026-10-30)

Fixes from the first live run on my channel (real model, real OBS, real chat):

1. I patched `src/frames/obs-frame-source.ts`: OBS returns `data:image/jpg;base64,`, not
   `jpeg`, so the prefix was never stripped and every live frame was a broken image. The
   regex is now `/^data:image\/[a-z]+;base64,/`. Commit it with a test using a `jpg` prefix.
2. A bet that resolves with no stakes is recorded and announced as "refunded". On stream that
   reads as a failure. Keep the ledger correct (nobody gains or loses), but announce the
   result: "<winning outcome>! No one bet on this one." Same on the overlay.
3. It cancelled a trash-mob bet 6 s after locking, because no "defeated" banner appeared.
   Small enemies die without a banner. In the prompt: a nameplate marked Dead or at 0 HP, a
   combat log kill or experience line, or loot all count as the outcome. Replace the third
   few-shot example: cancel only when the moment has clearly ended and no outcome has been
   visible for at least 20 seconds. Add a code guard: no `cancel_bet` within 20 s of the
   last lock or open unless the reason says the scene left the moment (log it).
4. It opened a bet on every trash pack, once a minute. Bets should be events: tell the model
   to prefer bosses, elites, big pulls and risky attempts, to skip routine trash, and to
   open at most one bet every 3 minutes unless a boss appears. Default `MIN_GAP_SECONDS` 180.
5. Chat needs time to bet: tell the model to open as a moment is about to start (a boss in
   view before the pull, a title card, a pack being approached), not once it is already
   underway, and code keeps every bet open for at least 30 s before `lock_bet` or
   `resolve_bet` is allowed, unless the outcome is already on screen (then resolve).
6. The overlay is now a source in my OBS scene, so screenshots of the program scene include
   Call It's own bet card, and the model could quote it as evidence. Add `OBS_SOURCE_NAME`:
   when set, screenshot that source (my game window, "Window Capture") instead of the program
   scene. Log which one is used at startup.
7. Save every frame the agent is sent to `data/frames/<timestamp>.jpg` (gitignored, keep the
   last 2,000), so each decision in `data/decisions.jsonl` can be shown next to the frame it
   was made on in the demo video and the write-up.

Run typecheck and tests, commit.

## Fixes from the second live run (2026-10-30)

Fixes from the second live run. The betting path works end to end (a chat bet was counted,
locked and settled). One wrong payout and some chat polish:

1. Wrong payout (most important). The bet was "Will Glass-Backed Tide Wisp be defeated?". The
   model resolved "It dies" citing combat log lines "You gain 55 experience (Tide Wisp)" from
   earlier kills of other, regular Tide Wisps, while the frame it cited showed the
   Glass-Backed Tide Wisp alive at 106/594 HP. Fix in two places:
   a. Prompt: evidence must be about the exact subject of the bet, by its full name, and
      must be new since the bet opened. Old log lines and other enemies with similar names
      never count. If the subject's health bar is visible and above zero, the outcome is not
      decided.
   b. Code: two-look confirmation. A `resolve_bet` does not settle at once; it becomes a
      pending resolution (log it, overlay shows "Checking..."). On the next tick, with new
      frames, make one extra model call that sees the bet, the proposed outcome and the
      evidence, and must call `confirm_resolution` or `reject_resolution(reason)`. Only a
      confirm settles. A reject returns the bet to its previous status and is logged. This
      is a real decision by the model, not a code check.
2. Chat reasons are read by viewers. The lock, cancel and resolve reasons go into chat, so the
   model writes them for viewers ("Couldn't see how that fight ended, points refunded"), never
   "in the supplied frames". Keep the full evidence in the decision log.
3. Skip the LOCKED message when nobody has bet. Keep it when there are stakes.
4. A bet command with no open bet gets one short reply, "No bet open right now", at most once
   every 30 s per channel.
5. Put "seconds until a new bet is allowed" in the per-tick context so the model stops trying
   to open during the gap (each refusal costs a correction call).

Run typecheck and tests, commit. Also commit my `.gitignore` change (`broll/`) and
`CODEX_PROMPTS.md`.

## Second look review (2026-10-31)

```
Review of 7b7789e. I replayed two real cases from the live run through the second look,
5 runs each, with gpt-5.4-mini. Fixtures are in eval/confirm-cases/ (case.json plus frames).

  wrong-payout-wisp-alive (wisp at 77/594 HP):   rejected 5/5. Good.
  true-kill-tide-wisp (target frame "Dead 0/76"): rejected 5/5. Bad.

After a kill the proof disappears within two seconds (the target frame closes, the corpse
only shows a loot marker). The second look only sees newer frames, so it rejects nearly
every real kill and the bet times out. Fix:

1. The second look sees the proposal frames and the newer frames. Store the proposal's
   frames in the pending resolution. In the confirmation input, send the proposal frames
   first, then the newer frames, and say in the text which images are PROPOSAL and which
   are NEWER, with their timestamps. Replace the confirmation instructions with this
   wording, which I tested (rejected 5/5 and confirmed 5/5 on the two cases):

   This is a second-look confirmation of a proposed result. You get two sets of frames:
   PROPOSAL frames (what the first look saw) and NEWER frames (captured after the
   proposal). Confirm only if both hold:
   1. A PROPOSAL frame shows the exact subject of the bet, by its full name, with the
   outcome: a target frame or nameplate reading Dead or 0 HP, a defeat, reset or victory
   banner naming it, or the player's own death. A combat log line, an experience line, or
   loot alone is not enough, and a similar name never counts.
   2. No NEWER frame contradicts it: the exact subject is not shown alive with health above
   zero, and the fight against it is not still going.
   After a kill the proof often disappears within seconds, so NEWER frames do not need to
   repeat it. If the subject's health is above zero in any frame after the proposal,
   reject. If unsure, reject.

2. Lock the bet when a resolution is proposed, so nobody can bet after the outcome is on
   screen. Send no LOCKED chat message for this lock. A reject restores the previous status
   (restoreStatus already does this).
3. A pending resolution cannot hang. After 2 confirmation calls in a row that are invalid
   or fail, drop the proposal, restore the bet, and log it as "confirmation_failed". This
   never settles a bet, so it is safe without a model decision.
4. Add `npm run eval:confirm -- [runs]` (default 5). For each folder in
   eval/confirm-cases/, read case.json, build the pending-resolution context from it, and
   call the same AgentBrain confirmation path the live loop uses (not a copy of the
   prompt). Print each case's confirm and reject counts against "expected", and write
   eval/results/confirm-<ISO date>.json. You have no network, so test it with a fake
   OpenAI client; I will run it for real.
5. Tests: proposal frames reach the confirmation input in the right order and labels;
   proposing a resolution locks the bet and a reject restores it; two failed confirmations
   drop the proposal.

Run typecheck and tests, commit. Also commit eval/confirm-cases/ and CODEX_PROMPTS.md.
```

## Confirmation eval results (2026-10-31)

```
I ran npm run eval:confirm -- 10 on ea1f54a:

  true-kill-tide-wisp:     confirm 1/10 (expected confirm)
  wrong-payout-wisp-alive: reject 10/10 (expected reject)

The rejects say "newer frames still show Tide Wisps alive". Those are corpses: name labels
with a loot marker and no health bar. I tested two changes locally, then reverted them:

  + the corpse sentence below:                  true kill 6/10, wrong payout rejected 10/10
  + the corpse sentence and SYSTEM_PROMPT back: true kill 9/10, wrong payout rejected 10/10

Make both changes:

1. Confirmation instructions are `${SYSTEM_PROMPT}\n\n${RESOLUTION_CONFIRMATION_INSTRUCTIONS}`
   again, not the confirmation text alone.
2. In RESOLUTION_CONFIRMATION_INSTRUCTIONS, right after "and the fight against it is not
   still going.", add: "A name label with no health bar, or with a loot marker, is a corpse,
   not a living enemy."
3. Remove `eval/results/` from .gitignore. Measured results are committed so every number
   in the write-up traces to a file.

Update the fake-client test if it checks the instructions. Run typecheck and tests, commit.
Also commit CODEX_PROMPTS.md.
```

## Slice 6: replay mode and the chess grader (2026-10-31)

```
On 413cb11 the confirmation eval is now 10/10 confirm on the true kill and 10/10 reject on
the wrong payout (eval/results/confirm-2026-10-31.json). Good.

Next is the headline number from SPEC.md "Replay mode and measurement": Call It runs on
real chess stream VODs, and a script with no model in it grades its bets against the
official chess.com game records. I will supply the VOD frame folders and the game records
(you have no network). Build the code and test it on small fixtures.

1. Replay mode: `npm run replay -- <folder> [--memory off] [--from <s>] [--to <s>]`.
   - <folder> holds frames named `<vodOffsetSeconds>.jpg` (1 fps, from ffmpeg) and
     `vod.json`: { "vodId", "channel", "url", "startedAt" (ISO) }.
   - Fake clock that starts at startedAt + from. Each tick advances TICK_SECONDS of VOD
     time. Do not wait in real time: the next tick starts as soon as the last one is done.
   - The frame source returns the 3 frames at or before the clock, 2 seconds apart, like
     live. Reuse ReplayFrameSource if it fits.
   - Same AgentLoop, prompt, tools, guards and second look as live. No OBS, no Twitch calls:
     use the chat ledger in memory with a fake chat sender that only logs the message.
     Treat the stream as live and nobody bets.
   - `--memory off` passes "No stored channel memory summary yet." as the memory summary.
   - Output in `eval/runs/<vodId>[-nomemory]/`: decisions.jsonl (each entry also has
     vodOffsetSeconds) and bets.json, one entry per bet: question, outcomes, openedAt,
     lockedAt, endedAt (ISO and VOD offset), and how it ended: resolved with the outcome
     index and title, cancelled with the reason, or timeout.
   - Print a running count of model calls and input and output tokens every 50 ticks, and
     totals at the end.
2. Grader: `npm run grade -- <runDir> <games.json>`. No model, no network.
   - games.json is a list of games from the chess.com archive: { "url", "white", "black",
     "result": "white" | "black" | "draw", "startedAt", "endedAt" (ISO), "streamer" (the
     streamer's username) }.
   - Match each bet to the game in progress when it opened (startedAt <= openedAt <= endedAt).
     No game: ungraded, reason "no game in progress".
   - Grade only bets about the game result. A bet is about the result when its outcomes map,
     by rules, to the streamer winning, the opponent winning, or a draw. For example the
     streamer's name, "win", "wins", "loses", "lose", the opponent's name, "white", "black",
     "draw", "stalemate". Map the resolved outcome to a result and compare it with the record.
     Anything the rules cannot map is ungraded, with the reason. Never count an ungraded
     bet as correct.
   - Cancelled and timed-out bets on a game are counted as "refunded", not as wrong.
   - Output `eval/results/chess-<vodId>[-nomemory].json` plus a printed table: VOD hours,
     bets opened, bets per hour, graded, matched the record, did not match, refunded,
     ungraded (with reasons).
3. Tests: replay with a fake brain over a fixture folder (clock, frame spacing, outputs);
   grader with a fixture games.json covering a match, a mismatch, a refund, an ungraded bet
   and a bet with no game in progress.

Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Grader fixes from the first chess replay (2026-10-31)

```
I ran replay on 12 minutes of a real VOD (Anna Cramling, eval/chess/2912243465.*). The loop
works: it opened "Who wins Anna Cramling vs Jan Gustafsson?" (outcomes "Anna wins",
"Jan wins", "Draw"), locked it, and resolved "Jan wins" from the chess.com "Black Won"
popup, which matches the record. The full 2h48m run is going now. Two grader bugs:

1. The board shows real names, not usernames. JanistanTV appears as "GM Jan Gustafsson".
   "Jan wins" matches neither username, falls through to the bare "wins" rule, and is graded
   as the streamer winning. That flips results. Fix:
   - games.json now has optional "whiteName" and "blackName" (the chess.com profile name, or
     null). A player is matched by username, by full display name, or by any single word of
     the display name with 3 or more letters ("Anna", "Jan"). Case-insensitive, whole words.
     If one outcome matches both players, it is unmappable.
   - Remove the fallback that maps a bare "win" or "lose" with no player, "streamer",
     "opponent" or colour to the streamer. Use the question instead: if the outcomes are
     Yes / No style, find the player and the verb (win, lose, draw) in the question.
     "Yes" maps to that result. "No" maps to "not that result" and is correct when the
     actual result is anything else. Keep predicted results as sets so this works.
   - An outcome that names someone who is neither player is unmappable.
2. Bets opened on the pairing screen. The model opened a bet 8 s before the record's
   startedAt. A bet opened up to 60 s before a game's startedAt belongs to that game, as long
   as it was not opened during the previous game.

Tests: "Jan wins" and "Jan Gustafsson wins" map to the opponent; "Anna wins" to the streamer;
"Will Anna win?" with Yes / No, both ways, including a draw; an outcome naming a third
person is ungraded; a bet opened 30 s before startedAt matches that game.

Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md and
eval/chess/2912243465.games.json (I added the names).
```

## Fixes from the full chess replay (2026-10-31)

```
Full replay of Anna Cramling's VOD 2912243465 (2.81 h, 14 games, 2,531 model calls),
graded against chess.com (eval/results/chess-2912243465.json):

  bets opened 21 | graded 8 | matched the record 4 | did not match 4 | refunded 2 |
  ungraded 11 (9 "no game in progress")

Causes, from the decision log and the frames:
- All 4 wrong payouts read the banner right ("White Won") but gave it to the wrong player.
  chess.com draws the streamer's side at the bottom, so when Anna plays Black the board is
  flipped, and gpt-5.4-mini assumed the bottom player is White. One said "You Won!" and it
  still paid White. Prompt wording, more effort and asking it to state each side did not
  fix it. gpt-6.1-sol did.
- It opened bets on the post-game screen, sometimes about the game that had just ended or
  with the previous opponent's name.
- 9 bets opened 1 to 4 minutes before a game's clock started; several resolved correctly on
  that game but the grader only looks 60 s back.

1. Second look on a stronger model that picks the outcome.
   - New env OPENAI_RESOLVE_MODEL, default "gpt-6.1-sol", in config and .env.example. The
     confirmation call uses it; the per-tick loop stays on OPENAI_MODEL. Each decision log
     entry records the model that made that call.
   - confirm_resolution takes { outcome_index, reason }, reason written for viewers. The
     second look may settle on a different outcome than proposed. Settle on its index, and
     put "corrected from <proposed> to <confirmed>" in the guard result when they differ. An
     out-of-range index counts as an invalid confirmation.
   - Append this to the confirmation instructions:
     You may confirm the proposed outcome or a different one: call confirm_resolution with
     the index of the outcome the frames prove. When a banner names a side, colour or
     perspective ("White Won", "You Won", "Victory"), work out which named player that is
     from the frame itself (the colour of the pieces next to their name, the board
     coordinates); "You" is the streamer. Do not assume the streamer's side from where they
     sit on screen.
   - I tested this with gpt-6.1-sol: 18/18 right on six chess cases (four where the first
     look proposed the wrong winner), 5/5 confirm and 5/5 reject on the two game cases,
     about 2.5 s per call.
2. Main prompt: append this paragraph to SYSTEM_PROMPT. It targets opening on the post-game
   screen; the rerun will measure it.
   Sides and perspective: when a result banner names a side or colour ("White Won", "Blue
   team wins") or a perspective ("You Won", "Victory", "Defeat"), work out which named player
   or team that is from the frame itself. "You", "Victory" and "Defeat" are from the
   streamer's point of view. Do not assume the streamer's colour or side from where they sit
   on screen: in board games the streamer's own side is usually drawn at the bottom whatever
   its colour, so read the colour from their pieces or from the board's coordinates. Name
   outcomes after the players or teams as the game writes them, not after colours or sides.
   Between rounds: a result popup, a board with no clock running, or the previous opponent's
   name means that round is over. Never open a bet about a round whose result is already on
   screen. Wait until the next round has started (a new opponent name and a full clock)
   before opening.
3. eval:confirm: case.json may have "expectedOutcomeIndex". A confirm on a different index
   counts as "wrong outcome", printed and saved separately from confirm and reject. Six new
   cases are in eval/confirm-cases/chess-* (frames cropped to the board).
4. Grader:
   - A bet opened when no game is in progress belongs to the next game that starts within
     300 s (was 60).
   - A bet resolved more than 10 s before its game's endedAt is "incorrect", reason "paid
     out before the game ended". It cannot have seen the result.
   - Tests for both.

Run typecheck and tests, commit. Also commit eval/confirm-cases/chess-*,
eval/chess/2893451280.* and CODEX_PROMPTS.md.
```

## Spend guard (2026-10-31)

```
A forgotten `npm run live` with CALLIT_FORCE_LIVE=1 ran for 19 hours and made 10,093 model
calls (46.8M input tokens) on an empty screen. Add hard limits in code:

1. CALLIT_MAX_MINUTES (default 30): live mode stops itself after this many minutes when
   CALLIT_FORCE_LIVE=1 is set, logs why, and exits. Without force-live it keeps following
   stream.online / stream.offline as now.
2. CALLIT_MAX_MODEL_CALLS (default 600 in live, unlimited in replay unless set): once
   reached, the loop stops calling the model, logs "model call budget reached", and exits.
   Replay accepts --max-calls <n>.
3. Skip the model call when the newest frame's hash equals the previous tick's newest
   frame hash (a frozen or static screen), and log it as a skipped tick.
4. Print the model call count and input tokens every 50 calls in live mode, like replay.
5. README and .env.example: document both limits.

Tests for each. Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Slice 4a: clip and stream marker on every payout (2026-10-31)

```
The demo ends on a live payout with the clip link landing in chat (DEMO.md). Build it:

1. Helix client: createClip(broadcasterId) -> POST /helix/clips?broadcaster_id=...
   (scope clips:edit; 202 with data[0].id and edit_url; clip URL is
   https://clips.twitch.tv/<id>) and createStreamMarker(userId, description) -> POST
   /helix/streams/markers with { user_id, description } (scope channel:manage:broadcast;
   description at most 140 characters). Note the scope in a comment like the other calls,
   and verify both against the Twitch API reference before writing them.
2. When a bet settles (confirmed resolution) or is refunded by the model, in chat mode:
   - Create a stream marker described as "Call It: <question> -> <outcome or refunded>".
   - Create a clip. Post "Clip: https://clips.twitch.tv/<id>" in chat after the payout line.
   - Both happen after the payout message, never before, and never delay settlement.
   - Both only work while the channel is really live. If Twitch refuses (404, not live,
     rate limit, or force-live with no broadcast), log one line with the status and move
     on. No chat message on failure.
   - Record the clip id, clip URL and marker position on the bet in the ledger and in the
     decision log entry for that settlement.
3. Put this behind an interface (for example a MomentRecorder) so replay uses a fake that
   only logs, and never calls Twitch.
4. Overlay: when a clip URL exists for the settled bet, show "Clipped" on the winner card.
5. Tests: clip and marker are called after the payout message with the right text; a
   Twitch failure is logged and does not throw or send chat; replay uses the fake.

Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## README for judges (2026-10-31)

```
Rewrite README.md for a judge who opens the repo cold. Plain language, short sentences, no
em dashes, no hype words. Order:

1. One line: what Call It is ("Call It watches your game through OBS and runs prediction
   bets in your Twitch chat: it opens them, locks them, settles them and clips the moment").
2. Who it is for: small streamers. Twitch Predictions need Affiliate; a small channel never
   had them. Call It runs the same thing in chat with its own points.
3. How it works, as a short numbered list: OBS frame every 2 s; every 4 s gpt-5.4-mini sees
   the last 3 frames, the bet state and recent decisions and must call exactly one tool
   (wait, open_bet, lock_bet, resolve_bet, cancel_bet); code only enforces limits (list
   the guards); a proposed payout goes to a second look on gpt-6.1-sol, which sees the
   proposal frames and newer frames and settles on the outcome the frames prove, or rejects
   it; payout in chat, stream marker, clip link. Name the files where each step lives.
4. Setup from a clean clone, tested on Windows: Node 22+, npm install, Twitch app (public
   client, no redirect needed because login uses the device code flow), OBS WebSocket
   enabled, .env from .env.example (list each variable and what it does, including
   OPENAI_RESOLVE_MODEL, OBS_SOURCE_NAME, CALLIT_MAX_MINUTES, CALLIT_MAX_MODEL_CALLS).
5. Run: npm run live (and CALLIT_FORCE_LIVE=1 for testing off-stream), chat commands for
   viewers (!1, !2, ...) and for the broadcaster and mods (!callit pause / resume / cancel /
   status), the overlay URL to add as an OBS browser source.
6. Measure: npm run replay -- <folder>, npm run grade -- <runDir> <games.json>,
   npm run eval:confirm. Explain that the grader has no model in it and grades against
   chess.com's public game records. Leave a "Results" section with the heading and one line
   "Filled in from eval/results/ after the held-out run." I will write the numbers.
7. Limits, stated plainly: chat mode only (native Channel Points Predictions are future
   work for Affiliate channels); clips and markers only while really live; the agent reads
   only pixels, so it can be wrong, which is why every payout gets a second look and
   viewers can be refunded with !callit cancel; spend caps and what one hour costs in model
   calls (about 900 calls an hour at a 4 s tick).
8. How it was built: built in OpenAI Codex in one main thread (session ID: leave
   "<session id>" for me to fill). Planning, prompt review, live testing and the evaluation
   runs were done with Claude Code; the prompts sent to Codex are in CODEX_PROMPTS.md.

Keep it under about 200 lines. Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Demo polish and a mode bug (2026-10-31)

```
Review findings before the live demo. In order of importance:

1. Bug: Affiliate and Partner channels get no agent. cli.ts picks "native" mode for them,
   then logs "Native prediction mode is not part of this slice" and never starts the loop.
   Native mode is dropped (SPEC.md). Always run chat mode, whatever broadcaster_type is.
   Log the broadcaster type once. Remove the "slice" wording.
2. Viewers get no reply when they bet. In chat mode:
   - Accepted stake: one short reply, "@<login> <amount> on <outcome> (<balance> left)".
     Batch: if several stakes land within 3 s, send one line listing them.
   - Rejected stake: say why, once per viewer per bet: not enough points (with balance),
     already on another outcome, bet locked or closed.
   - Payout line: "1 winner" / "N winners" (grammar), and name the biggest winner:
     "Resolved: <outcome> | @<login> +<payout> pts | N winners | <reason>". Keep under
     Twitch's 500 characters.
3. Overlay winner card (the demo's last shot):
   - Under the winner title, show the viewer-facing reason (the confirm reason) instead of
     "Call It saw the moment.", and a payout line ("1 winner · +400 pts"), or "No one bet on
     this one." Add a small line "Checked by a second look" when it was confirmed.
   - Hide the card 25 s after a bet settles or is refunded, unless a new bet opens first.
     Keep "Clipped" visible on the card while it shows.
4. Debug page (the video shows it to explain how the agent decides):
   - Each entry shows a tool chip (wait, open_bet, lock_bet, resolve_bet,
     confirm_resolution, reject_resolution, cancel_bet, timeout, skipped), the model that
     made the call (gpt-5.4-mini or gpt-6.1-sol), the reason, and the guard result when a
     call was rejected or corrected ("corrected from X to Y" in its own colour).
   - Collapse runs of consecutive waits into one line: "waited x12 (48 s)".
   - Show the current bet state at the top (question, status, pools).
   The overlay state needs the tool, model and guard result per decision for this.
5. Update overlay:demo so it walks through open, bets, lock, checking, a corrected
   confirmation, payout with clip, and the card hiding, with the DEMO DATA badge on.

Tests for 1 and 2 (mode selection, batched stake replies, rejection reasons, payout line).
Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Two visual fixes (2026-10-31)

```
I screenshotted overlay:demo at each step. Both new screens work. Two visual fixes:

1. Overlay winner panel: the question and outcome rows underneath show through the result
   panel (its background is 94% opaque), so "WINNER They back away" sits on ghost text.
   Make the panel fully opaque, or hide the card body while the result is shown.
2. Debug page: the "Current bet" panel is a tall box with two lines in it. Make it a compact
   strip that fits its content, so the latest frame and the decision list sit higher.

No logic changes. Check with npm run overlay:demo, run typecheck and tests, commit.
```

## Held-out result: grader fixes and stale bets (2026-10-31)

```
Held-out replay of Anna Cramling's VOD 2893451280 (2.42 h, 13 games, never used for tuning),
eval/results/2893451280-heldout/: 22 bets, 7 graded, 7 matched the record, 0 wrong,
8 refunded, 7 ungraded. The second look stepped in 11 times out of 18 proposals: it
corrected 5 wrong winners and rejected 6 payouts that used another game's result. All 11
were right.

Checking every bet by hand found three grader problems. Fix them in eval/grade-lib.ts:

1. Check timing before names. Two bets opened after a game had ended and paid out before
   the next game started; they show as "ungraded" because their names do not match the
   next game. Run the "paid out before the game ended" check (resolved more than 10 s
   before the matched game's endedAt, or before its startedAt) before outcome mapping, so
   they count as incorrect. This makes the number stricter.
2. One exact match is enough. "Geniyan Genkeswaran" (record: Genivan Genkeswaran) is
   ungraded because "geniyan" is an unknown word, though "genkeswaran" matches exactly. If
   an outcome matches exactly one player through any alias, extra unknown words (titles,
   misspellings) do not make it unmappable. It is unmappable only when it matches both
   players, or matches neither and names someone.
3. Small spelling tolerance. "Kamila Rubinshein" (record: Kamilla Rubinshtein) matches
   nothing. A word of 5 or more letters within edit distance 2 of a player's username or a
   display-name word counts as a match, only when it matches exactly one player.
4. Write "graderVersion": "2026-10-31b" into each result JSON.
Tests for each, using these real names.

And one product fix, the main cause of the 10 refunds: Call It opens a bet on the previous
game's final screen, named after the last opponent, then has to refund it. Append to the
"Between rounds" paragraph of SYSTEM_PROMPT:
   Before opening, compare the names on screen with the last bet in the recent decisions.
   If they are the same players as a bet that has already ended, that round is over: wait
   until different names or a fresh clock with no moves played appear.

Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Fixes from the live demo stream (2026-10-31)

```
Live stream on jonathansolvesproblems, 25 min, Orvandel dungeon The Ninth Forge, 190 model
calls. 6 bets: 3 settled correctly with clips and markers (The Bellows, Slag Golem, Ysolde
Coalheart), 0 wrong payouts. Four problems from data/decisions.jsonl and data/frames:

1. False open on a conversation. It opened "Will Forgemaster Dunn be defeated this pull?"
   while I was talking to him: friendly quest-giver, dialogue window open with a quest
   list, green nameplate, full health. Append to the opening rules in SYSTEM_PROMPT:
   "A dialogue window, a quest list, or a friendly (green) nameplate means a conversation,
   not a fight. Only open on an enemy that is in combat or about to be pulled."
2. Bets about what comes next. It opened "Will the next scene be combat in The Ninth
   Forge?" from a chapter title card. Append: "Only open a bet about a fight or attempt
   whose outcome will be decided on screen: who wins, whether a named enemy dies, whether
   the player survives. Never bet on what the next scene will be."
3. A real kill with no banner in view. Quenchmaster Hroda died while I had the dungeon map
   open. The map went from "0 of 3 defeated" to "1 of 3 defeated" with her node marked
   defeated, and the log showed her death line and loot. The second look rejected it
   twice and the bet was refunded. In RESOLUTION_CONFIRMATION_INSTRUCTIONS rule 1, add to
   the list of proofs: "a dungeon map or objective tracker that newly marks the exact
   subject as defeated (for example its count goes up after the bet opened)". I added the
   case eval/confirm-cases/orvandel-map-kill/ from these frames; commit it. I will run
   eval:confirm to check it confirms and the other 8 cases still pass.
4. Proposal loops. After a reject, the first look proposed the same result again on the
   next tick, three times in a row, each costing a gpt-6.1-sol call. Code limit: after a
   reject_resolution, resolve_bet is refused for 15 s with the error "The last proposal was
   rejected; wait for new evidence." It goes through the normal correction path. Log it.

Also: HelixClient.sendChatMessage ignores is_sent and drop_reason in the Send Chat Message
response. If is_sent is false, log the drop reason and treat it as not sent.

Tests for 4 and the chat drop. Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Setup check (2026-10-31, optional)

```
For the "easy to use" judging criterion: add `npm run check`, a first-run check a new
streamer runs before going live. No model generations (it must cost nothing). It prints one
line per check with OK or a plain fix:

1. .env: TWITCH_CLIENT_ID and OPENAI_API_KEY present; numeric settings valid.
2. Twitch: the saved login works (or say "run npm run live once to log in"), print the
   channel name and that chat mode will be used.
3. OpenAI: the key works and both OPENAI_MODEL and OPENAI_RESOLVE_MODEL are available
   (models.retrieve, not a generation).
4. OBS: WebSocket reachable with the password, OBS_SOURCE_NAME exists in the current scene
   (if set), and a screenshot of it succeeds. Warn if the overlay browser source is missing
   or points somewhere other than http://127.0.0.1:<OVERLAY_PORT>/overlay.
5. Exit code 0 when everything is OK, 1 otherwise.

Add it to the README setup section as the step before npm run live. Tests with fakes for
each check. Run typecheck and tests, commit. Also commit CODEX_PROMPTS.md.
```

## Not built

- Native Channel Points Predictions for Affiliate channels (dropped 2026-10-31; see SPEC.md).
- Per-channel memory of which moments chat bets on most.
