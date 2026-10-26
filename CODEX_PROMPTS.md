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

(Pasted after slice 1 passes. Covers the OBS frame source, the replay frame source, and the
overlay server and page.)

## Slice 3: the agent loop and chat-mode bets

(Pasted after slice 2 passes. Covers the OpenAI tool loop, guards, decision log, the
chat-mode ledger and payouts. This is the day 3 slice.)

## Later slices

4. Clips and stream markers on resolve, ad-break pause, stream.online autostart, memory.
5. Native mode against the Twitch CLI mock API.
6. Replay mode and the chess grader on real VODs.
7. Overlay polish, README from a clean clone.
