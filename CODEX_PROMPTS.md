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

## Later slices

4. Clips and stream markers on resolve, ad-break pause, stream.online autostart, memory.
5. Native mode against the Twitch CLI mock API.
6. Replay mode and the chess grader on real VODs.
7. Overlay polish, README from a clean clone.
