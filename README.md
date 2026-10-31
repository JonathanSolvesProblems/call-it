# Call It

Call It watches game frames, opens chat bets around uncertain moments, and settles them from visible evidence. Replay mode runs the same agent loop against extracted VOD frames. The chess grader compares game-result bets with supplied chess records and makes no model or network calls.

## Setup

Use Node.js 22 or newer. Install dependencies with `npm install`, copy `.env.example` to `.env`, and fill in your Twitch Client ID, OpenAI API key, and local OBS WebSocket settings. Keep `.env` private.

Run the live bot with `npm run live`. For a VOD folder containing `<vodOffsetSeconds>.jpg` frames and `vod.json`, run `npm run replay -- <folder>`. Replay accepts `--memory off`, `--from <seconds>`, `--to <seconds>`, and `--max-calls <n>`. Grade a replay with `npm run grade -- <runDir> <games.json>`.

## Model spend limits

- Live sessions stop after 600 model calls by default. Set `CALLIT_MAX_MODEL_CALLS` to change the cap.
- Replay has no model-call cap by default. Set `CALLIT_MAX_MODEL_CALLS` or pass `--max-calls <n>` to cap it.
- When `CALLIT_FORCE_LIVE=1` is enabled, live mode exits after 30 minutes by default. Set `CALLIT_MAX_MINUTES` to change that limit. Normal live mode continues to follow Twitch stream online and offline events.
- A tick with no new frame content is skipped when its newest frame hash matches the previous tick.
- Live mode reports model-call and token totals every 50 calls.

The limits and defaults are also listed in `.env.example`.
