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

- **node** (`test/*.test.ts`) — the pure modules shared by the Worker and the build script, in a plain Node environment:
  - `trivia-core.test.ts` — answers, shuffling, question construction, question timing helpers and the Trivia API question schema.
  - `quiz-rules.test.ts` — `/quizzo` argument parsing, the `Quiz` answer/scoring rules and who wins each award.
  - `multiplayer.test.ts` — several participants scoring in one quiz.
  - `quiz-snapshot.test.ts` — `Quiz` snapshot round-trips, the format the Durable Object stores.
  - `recap.test.ts` — `Quiz.getRecap` plus the recap modal and final summary renderers, awards included.
  - `slack-ui.test.ts`, `channel-ui.test.ts` — the channel ready screen, question, results and summary blocks.
  - `countdown.test.ts` — the countdown GIF renderer and its URL helper, still used by `pnpm build:assets`.
  - `test-utils.ts` is shared helper code, not a test file.

- **worker** (`test/worker/**/*.test.ts`) — the Cloudflare Worker on the real Workers runtime under `@cloudflare/vitest-pool-workers`:
  - `channel-object.test.ts` — the `ChannelObject` Durable Object's channel bookkeeping and storage behaviour.
  - `quiz-record.test.ts` — stored quiz rows in the shape earlier releases wrote still decode and rebuild.
  - `start-quiz.test.ts` — `/quizzo` starting a quiz, question fetching, and refusal while one is running.
  - `answers.test.ts` — answer recording, changing an answer, and late answers.
  - `alarm-progression.test.ts` — alarm-driven ready/question/results/complete progression, restart and duplicate-alarm behaviour.
  - `screening.test.ts` — screening with Jev, with The Trivia API faked to serve fresh, repeated, failing or slow questions: which verdicts let a question be asked, the request Jev receives, the `screenings` rows, screening on the ready alarm after an eviction, the extended ready screen starting the quiz in full, with fewer questions, or not at all, and searches that fail, hang or meet questions already screened.
  - `screening-fallback.test.ts` — questions asked unscreened when Jev errors, times out, answers with something else or with nothing usable, or there is no OpenCode key, and a quiz carrying on when D1 cannot record verdicts or its binding is missing.
  - `screening-log.test.ts` — recording verdicts against a D1 that never answers and a missing binding.
  - `recap.test.ts` — the Recap button's modal, including recaps from older summaries.
  - `slack-request.test.ts` — signature verification, the `/quizzo` acknowledgement and the `response_url` reply.
  - `countdown-assets.test.ts` — the pre-rendered countdown GIFs served through the `ASSETS` binding.
  - `fixtures.ts`, `env.d.ts` and `apply-migrations.ts` are shared helper code, types and setup, not test files.

## Alarm-driven tests

`test/worker/alarm-progression.test.ts` runs quizzes with one-second answer windows, a one-second ready screen and a one-second results window (`READY_SECS` and `RESULTS_SECS` are worker test bindings; production uses ten and five seconds), so a whole quiz plays out in a few seconds of real time.

Alarms are really scheduled, so the runtime delivers most of them itself and the tests just wait for the Slack calls to arrive. Deliveries the platform would never make are driven by hand through `runInDurableObject`: a duplicate alarm calls `alarm()` again, and a late wake deletes the scheduled alarm, lets the deadline pass unattended, then calls `alarm()`. The restart test aborts the instance with `state.abort()` and re-fetches the stub, so the quiz continues on an object rebuilt from storage alone.

## Conventions

- Worker tests reach the Durable Object through its namespace binding and assert on what Slack would receive, not on storage rows.
- The `chat.*` interceptors match only requests carrying the test bot token, so a token that never reaches the Slack client fails the tests.
- External dependencies are faked at the network boundary: outbound `fetch` to Slack, The Trivia API and Jev is intercepted with `fetchMock` with net connect disabled, so an unmocked request fails the test rather than reaching the network. A file that does not fake Jev runs its quizzes unscreened, which is what a Jev outage looks like.
- `JevFake` in `fixtures.ts` answers every screening request in a file, judging each item by a function the test sets; it can also fail or slow down a request. It matches classes by their descriptions, not their wire IDs. Jev's timeout is 300 ms and an extended ready screen three seconds in the worker test bindings (`JEV_TIMEOUT_MS`, `EXTENDED_READY_SECS`).
- The `DB` D1 database is the one `wrangler.jsonc` binds, run locally by Miniflare. `vitest.config.ts` reads `migrations/` into the `TEST_MIGRATIONS` binding and `apply-migrations.ts` applies it before each test file, so tests run against the schema a deploy would.
- The countdown GIFs the worker tests fetch are build output, not fixtures: `pretest:run` and `pretest:worker` render them into `public/countdown/` first, so the tests read the same bytes a deploy would upload.
- Worker tests are isolated from local env files. Wrangler otherwise loads a `.env` from the repo root as dev vars, so the developer's real Slack credentials in that file would reach the worker under test: any key the test config does not happen to override arrives untouched, and `SLACK_APP_TOKEN` alone turns on Socket Mode, which skips signature verification and makes live Slack calls with a real token. So `vitest.config.ts` sets `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` and the worker project takes its Slack credentials from `miniflare.bindings` alone; a test asserts those fake values so a regression fails instead of leaking.
