# Testing Setup

Tests run with Vitest, configured as two projects in `vitest.config.ts`.

## Running Tests

```bash
# Run every project once
pnpm test:run

# Run just one project
pnpm test:node
pnpm test:worker

# Watch mode (all projects, default)
pnpm test
```

## Projects

- **node** (`test/*.test.ts`) — the pure modules behind the current Node app: trivia rules and scoring, Slack UI rendering, countdown GIFs, and the quiz flow. Runs in a plain Node environment.
- **worker** (`test/worker/**/*.test.ts`) — the Cloudflare Worker on the real Workers runtime under `@cloudflare/vitest-pool-workers`: the `ChannelObject` Durable Object (argument parsing, SQLite channel bookkeeping) and the Slack request handler (signature verification, `/quizzo` acknowledgement, and the `response_url` reply).

## Conventions

Worker tests are isolated from local env files. Wrangler otherwise loads a
`.env` from the repo root as dev vars, so the Node app's real credentials would
reach the worker under test: any key the test config does not happen to override
arrives untouched, and `SLACK_APP_TOKEN` alone turns on Socket Mode, which skips
signature verification and makes live Slack calls with a real token. So
`vitest.config.ts` sets `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` and the
worker project takes its Slack credentials from `miniflare.bindings` alone; a
test asserts those fake values so a regression fails instead of leaking.
Outbound calls are intercepted with `fetchMock` with net connect disabled, so an
unmocked request fails the test rather than reaching the network.
