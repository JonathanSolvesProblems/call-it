# Call It: demo script

Target 2:30, hard limit under 3:00 (judges stop at 3:00). The rules require footage of the
project working on Twitch AND footage of how it was built with Codex. No third-party game
music or other streamers' footage; game audio low or muted, my own voice only.

## 0:00 to 0:12, the person
On screen: my Twitch channel page, no Affiliate badge.
Voice: "I used to stream WoW with no mods. Mid-pull, both hands on the keyboard, chat
could only watch. And Predictions, Twitch's betting game for chat, are locked behind
Affiliate anyway. I never had it."

## 0:12 to 0:20, the promise
On screen: title card "Call It: it watches your game and runs the bets."
Voice: "Call It watches my game and runs the bets for me."

## 0:20 to 1:15, live on Twitch (the product)
On screen: my live stream with chat docked, overlay visible.
- The agent opens a bet on its own as a moment starts. Chat shows the call and `!1` / `!2`.
- Real chat accounts bet (labelled on screen if any are my test accounts).
- Overlay: one line of why it opened it ("boss pull started: health bars visible").
- It locks the bet as the moment comes to a head.
- A second moment where it cannot see the outcome: it refunds and says why. (Shows the refusal.)
Voice: short, over the action. Never explain the architecture here.

## 1:15 to 1:40, the number
On screen: one table, one sentence.
Voice: "I ran it over [X] hours of real chess streams and graded every call against
chess.com's official game record: [Y of N] matched, and it refunded [Z] rather than guess."

## 1:40 to 2:15, built with Codex
On screen: the Codex thread: the spec going in as the first message, Codex building the
EventSub client, a Codex review catching something, the session ID via /status.
Voice: "I built it in one Codex thread: [the two or three things Codex did that I could not
have done in a week alone]." Say what Codex actually did, never "Codex handled the boring parts."
Claude Code's role (planning, review, live testing, evaluation runs) is stated in the README.

## 2:15 to 2:30, final shot (a success landing, never a number)
On screen: live, a bet the agent opened resolves the moment it ends: the payout message in
chat, the clip link posted under it, my hands still on the keyboard.
Voice: "Call it."

## Narration to record (final, 2026-10-31, revised for the judging criteria)

About 370 words, roughly 2:30 read at a normal pace, which leaves room under the 3:00 limit. Read it straight through; pauses
between parts are fine, I cut them. Facts trace to eval/results/2893451280-heldout/, the
live log data/decisions.jsonl, git log and CODEX_PROMPTS.md.
Criteria: [I] innovation, [P] potential impact, [T] technology and Codex, [D] design.

[0:00, small-streamer framing] [I][P]
I used to stream WoW on a small channel. Mid-pull, both hands on the keyboard, my chat could
only watch. Twitch has a betting game for that, Predictions, but it's locked behind
Affiliate, and someone still has to start every bet and call the result by hand.

[0:15, title card] [I]
So I built Call It. It watches my game through OBS and runs the bets for me: it opens them,
locks them, pays them out and clips the moment.

[0:25, live stream: The Bellows bet opening, chat, overlay card filling] [D][P]
This is it live on Twitch, in a game I made. A boss shows up and Call It opens a bet on its
own: will The Bellows be defeated. Chat bets with !1 or !2, here my main account playing a
viewer, and the card on stream fills as points come in. It locks near the end of the fight.

[0:43, debug page: resolve_bet then confirm_resolution] [T]
When the boss dies, a fast model proposes the result, and a second, stronger model checks
the frames before anyone gets paid.

[0:52, payout line and clip link in chat, winner card] [D]
Then the payout lands in chat, with a clip and a marker in the VOD.

[0:58, Forgemaster Dunn refund] [T]
When it can't see the result, it refunds. Here it opened a bet while I was talking to a
quest-giver, saw no fight, and gave everyone their points back.

[1:08, chess frames, then the results table] [P][T]
It only reads the screen, so it works with any game. To grade it against something I don't
control, I ran it on real chess streams and checked every payout against chess.com's
official game records. On a 2.4-hour stream it had never seen, 10 of 12 payouts matched the
record, and it refunded 8 bets instead of guessing. The second look stepped in 11 times and
was right every time.

[1:38, Codex app: the thread, AGENTS.md, prompts, commits] [T]
I built it in one Codex thread, from a spec and an AGENTS.md file: 18 prompts, 26 commits,
72 tests. Codex wrote the code: the Twitch EventSub client, the agent loop where the model
picks one tool each tick, the guards and spend caps, the points ledger, the second look, and
the replay mode and grader. Every prompt I sent Codex is in the repo.

[2:10, terminal: npm run live, then OBS browser source] [D]
Setup is one command, npm run live, plus a browser source in OBS. No server to host.

[2:17, final shot: Ysolde payout and clip landing in chat] [P]
Small streamers don't need Affiliate to run predictions anymore. Call it.

## Final edit note (2026-10-31)

The recorded opener ("Hey, what is going on guys?") was cut: it clipped on the mic. The two takes are joined after "so it works with any game." with a 0.32 s gap. Faces come only from the stream recording; the narration camera is not used. Final cut 2:44.
