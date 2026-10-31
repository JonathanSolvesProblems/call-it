# AGENTS.md

Instructions for Codex working in this repo. Read SPEC.md first; it is the source of truth
for what Call It does. PHASE0.md and DEMO.md explain why; do not edit them.

Note (2026-10-31): native Predictions mode was dropped (see SPEC.md), so the native-mode
lines below are kept as the original instructions but no longer apply.

## Stack

- Node.js 22+, TypeScript, ESM. Package manager: npm.
- No framework for the server: Node's http module plus `ws` for the overlay socket.
- OpenAI official `openai` npm package (Responses API, function tools, image input).
- `obs-websocket-js` for frames. Tests with `vitest`.
- Keep dependencies few. Ask before adding one that is not listed here.

## Layout

```
src/
  config.ts          env parsing and validation (fail fast with a clear message)
  twitch/            auth (device code flow), helix client, eventsub websocket client
  frames/            obs source, replay source (same interface)
  agent/             prompt, tool schemas, loop, guards, decision log
  bets/              chat-mode ledger and payouts, native-mode adapter (same interface)
  overlay/           http server, websocket push, static page
  memory/            per-channel memory and summary
  cli.ts             `npm run live`, `npm run replay -- <folder>`
eval/                vod download and frame extraction, grader, results
data/                runtime state (gitignored)
```

## Rules

- Never commit secrets. All keys come from `.env` (gitignored); keep `.env.example` current.
- Never fake data in anything a judge sees. If something is a mock or a test account, label it
  where it appears (log line, overlay, README). Native mode is tested against the Twitch CLI
  mock and the README says so.
- Code enforces limits; the model chooses actions. Do not add code paths that open, lock or
  resolve a bet without a model decision, except the timeout cancel described in SPEC.md,
  which is logged as a timeout.
- Every Twitch call goes through the helix client, with the endpoint's required scope noted
  in a comment. Handle 401 by refreshing the token once.
- Write a vitest test for each guard and for the payout math before wiring them live.
- Small commits with plain messages. Do not change git user config; commit with the repo's
  configured identity. No AI attribution lines in commit messages.
- Docs and comments: plain language, no em dashes, short sentences.
- On Windows: paths via `node:path`, no shell-specific scripts in npm scripts.

## Check before saying a step is done

`npm run typecheck`, `npm test`, and the step's own "done when" check from the prompt.
