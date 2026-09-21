# Slack Trivia

A Slack bot that runs timed multiple-choice trivia quizzes in a channel and scores the participants. A quiz is started with `/quizzo`, lives in a single Slack message, and answers earn a speed bonus within the question's answer window.

The Worker currently only echoes the parsed `/quizzo` arguments back as an ephemeral reply; the quiz logic still lives in the Node app.

## Layout

- `app.ts` + `src/` — the current Node/Bolt app. The quiz logic lives here; it is being replaced by the Worker and will be removed.
- `worker/` + `wrangler.jsonc` + `public/` — the Cloudflare Worker that replaces it. `worker/index.ts` is the entry point and handles Slack requests on `/slack/events` via `slack-cloudflare-workers` (no Bolt, no Socket Mode). `worker/channel-object.ts` is the SQLite-backed `ChannelObject` Durable Object, one per channel, bound as `CHANNEL_OBJECT`. Static assets from `public/` are served through the `ASSETS` binding.

## Develop

```bash
pnpm install
cp .dev.vars.example .dev.vars  # fill in the Slack token and signing secret
pnpm dev                        # wrangler dev
```

With `pnpm dev` running on port 8787, run a `cloudflared` tunnel to `http://localhost:8787` and point the Slack app's request URL at `<tunnel-url>/slack/events`.

## Deploy

Set the secrets once (never commit them):

```bash
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
pnpm run deploy   # `pnpm deploy` is a built-in pnpm command, so `run` is required
```

The Worker publishes to the free `workers.dev` subdomain (`slack-trivia`). Set the Slack app's request URL to `https://slack-trivia.<subdomain>.workers.dev/slack/events`.

## Test

`pnpm test:run` runs both Vitest projects: `node` for the pure modules and `worker` for the Worker on the real Workers runtime. `pnpm test:node` and `pnpm test:worker` run one project each. See `TESTING.md`.
