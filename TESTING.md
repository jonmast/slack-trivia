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

- **node** (`test/*.test.ts`) — the pure modules behind the current Node app: trivia rules and scoring, quiz snapshot round-trips, Slack UI rendering, countdown GIFs, and the quiz flow. Runs in a plain Node environment.
- **worker** (`test/worker/**/*.test.ts`) — the Cloudflare Worker on the real Workers runtime under `@cloudflare/vitest-pool-workers`: the `ChannelObject` Durable Object (argument parsing, SQLite channel bookkeeping) and the Slack request handler (signature verification, `/quizzo` acknowledgement, and the `response_url` reply).

## Conventions

- External dependencies are faked at the network boundary: outbound `fetch` to Slack and The Trivia API, rather than the modules that call them.
- Worker tests reach the Durable Object through its namespace binding and assert on what Slack would receive, not on storage rows.
