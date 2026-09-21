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
- **worker** (`test/worker/**/*.test.ts`) — the Cloudflare Worker on the real Workers runtime under `@cloudflare/vitest-pool-workers`: the `ChannelObject` Durable Object (argument parsing, SQLite channel bookkeeping, alarm-driven progression), the Slack request handler (signature verification, `/quizzo` acknowledgement, and the `response_url` reply), and the pre-rendered countdown GIFs served through the `ASSETS` binding.

## Alarm-driven tests

`test/worker/alarm-progression.test.ts` runs quizzes with one-second answer windows and a one-second results window (`RESULTS_SECS` is a worker test binding; production uses five seconds), so a whole quiz plays out in a few seconds of real time.

Alarms are really scheduled, so the runtime delivers most of them itself and the tests just wait for the Slack calls to arrive. Deliveries the platform would never make are driven by hand through `runInDurableObject`: a duplicate alarm calls `alarm()` again, and a late wake deletes the scheduled alarm, lets the deadline pass unattended, then calls `alarm()`. The restart test aborts the instance with `state.abort()` and re-fetches the stub, so the quiz continues on an object rebuilt from storage alone.

## Conventions

- Worker tests reach the Durable Object through its namespace binding and assert on what Slack would receive, not on storage rows.
- External dependencies are faked at the network boundary: outbound `fetch` to Slack and The Trivia API is intercepted with `fetchMock` with net connect disabled, so an unmocked request fails the test rather than reaching the network.
- The countdown GIFs the worker tests fetch are build output, not fixtures: `pretest:run` and `pretest:worker` render them into `public/countdown/` first, so the tests read the same bytes a deploy would upload.
- Worker tests are isolated from local env files. Wrangler otherwise loads a `.env` from the repo root as dev vars, so the Node app's real credentials would reach the worker under test: any key the test config does not happen to override arrives untouched, and `SLACK_APP_TOKEN` alone turns on Socket Mode, which skips signature verification and makes live Slack calls with a real token. So `vitest.config.ts` sets `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` and the worker project takes its Slack credentials from `miniflare.bindings` alone; a test asserts those fake values so a regression fails instead of leaking.
