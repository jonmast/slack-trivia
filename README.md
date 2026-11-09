# Slack Trivia

A Slack bot that runs timed multiple-choice trivia quizzes in a channel and scores the participants. A quiz is started with `/quizzo`, lives in a single Slack message that is edited as the quiz progresses, and answers earn a speed bonus within the question's answer window.

The bot runs entirely on Cloudflare Workers. There is no Node server and no Docker image.

## Layout

- `worker/index.ts` — the Worker entry point. It verifies Slack requests and handles them on `/slack/events` via `slack-cloudflare-workers` (HTTP request URL only; no Bolt, no Socket Mode).
- `worker/channel-object.ts` — the SQLite-backed `ChannelObject` Durable Object, one per Slack channel, bound as `CHANNEL_OBJECT`. It builds the channel's Effect services from its bindings and runs one program per RPC method and alarm. A quiz in progress survives deploys, crashes and idle eviction.
- `worker/channel-quiz.ts` — those programs: starting a quiz, recording answers, serving recaps and the alarm-driven ready/question/results/complete transitions.
- `worker/quiz-store.ts` (the object's SQLite tables, stored quiz rows and alarm), `slack-client.ts` (`chat.postMessage`/`chat.update`), `trivia-api.ts` (question fetching), `config.ts` (settings read from bindings) and `logger.ts` (JSON log lines for Workers Logs) — the services those programs run against.
- `src/` — modules shared by the Worker and the build script: `trivia-core.ts` (the `Quiz` class, scoring, `/quizzo` argument parsing, the snapshot schema), `slack-ui.ts` (the channel renderers and recap modal), `countdown.ts` (the countdown GIF renderer) and `timing.ts` (answer-window, ready screen and results durations).
- `public/` — static assets served through the `ASSETS` binding. `public/countdown/` is build output and is gitignored.
- `wrangler.jsonc` — Worker, Durable Object and asset configuration.

Why Durable Objects: see `docs/adr/0001-cloudflare-durable-objects.md`. Why Effect, and which failures end a quiz: see `docs/adr/0002-effect.md`.

## Countdown GIFs

Each ready, question and results frame carries an animated countdown pie. The GIFs are pre-rendered by `pnpm build:assets` into `public/countdown/<secs>.gif` — one per answer window from 1s to the maximum, plus the ready screen and results durations — and served from the Worker's own origin, so nothing is generated at request time and no separate image host is needed. `pnpm dev`, `pnpm run deploy` and the test scripts render them first.

## Local development

The bot is reached over HTTPS by Slack, so local development means exposing `wrangler dev` through a tunnel and pointing the Slack app at it. There is only one Slack app, so the request URL is switched back to production when you are done.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in the bot token and signing secret
pnpm dev                          # wrangler dev, listening on http://localhost:8787
```

In a second terminal, open a tunnel to the dev server:

```bash
cloudflared tunnel --url http://localhost:8787
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL. In the Slack app configuration, set both:

- **Slash Commands → `/quizzo` → Request URL**: `https://<random>.trycloudflare.com/slack/events`
- **Interactivity & Shortcuts → Request URL**: `https://<random>.trycloudflare.com/slack/events`

`/quizzo` and the answer and Recap buttons now hit your laptop. **When you finish, point both request URLs back at the deployed Worker** (`https://slack-trivia.<subdomain>.workers.dev/slack/events`) — the tunnel URL dies with the `cloudflared` process, and until you switch back the bot is dead in the workspace.

## Deploy

Secrets live in the platform, never in the repo. Set them once per environment:

```bash
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

Then release:

```bash
pnpm run deploy
```

`run` is required: `pnpm deploy` is a built-in pnpm command (it publishes a package directory), so it would not run this script. The `predeploy` hook renders the countdown GIFs first, so a deploy always uploads assets matching the code.

The Worker publishes to the free `workers.dev` subdomain as `slack-trivia`. Its request URL is `https://slack-trivia.<subdomain>.workers.dev/slack/events`.

## Test

`pnpm test:run` runs both Vitest projects: `node` for the pure shared modules and `worker` for the Worker and its Durable Object on the real Workers runtime. `pnpm test:node` and `pnpm test:worker` run one project each. See `TESTING.md`.

`pnpm typecheck` type-checks the shared/script sources and the Worker sources.
