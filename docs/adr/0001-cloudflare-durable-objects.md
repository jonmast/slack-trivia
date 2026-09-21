# Run on Cloudflare Durable Objects, one per channel

The app ran as a single Node process with every quiz in memory: a restart killed running quizzes and dead Recap buttons, and the per-process `Map` of quizzes meant it could never run more than one instance. We needed a deployment target and durable persistence at the same time, and the persistence work forced a restructuring of `SlackQuiz` either way.

We chose Cloudflare Workers with one SQLite-backed Durable Object per Slack channel. The three hard parts of the persistence design map directly onto Durable Object primitives: "one running quiz per channel" is a single-threaded object keyed by `idFromName(channelId)`; quiz state lives in the object's own SQLite and survives eviction, deploys and crashes; and the question/results transitions are alarms set to absolute deadlines rather than an in-process `setInterval`. Alarms never fire early, and because the answer window is soft (see `CONTEXT.md`), alarm latency can only delay the results frame, never change a score.

## Considered options

- **Fly.io + SQLite on a volume, keeping Bolt.** Deployable the same day with the existing Dockerfile. Rejected because the single-writer guarantee, the resume-on-boot scan, and the timer that survives restarts would all be hand-written and maintained by us; Durable Objects provide each as a platform primitive.

## Consequences

- `@slack/bolt` does not run on Workers. The Slack layer is rewritten on `slack-cloudflare-workers`, whose API mirrors Bolt's.
- Socket Mode is gone, including locally. Development points the Slack app's request URL at `wrangler dev` through a tunnel.
- The Home tab quiz is deleted: it needed a 100ms view push that alarms cannot honestly provide, and it was already deprecated.
- `TriviaStore`'s per-process cache is replaced by fetching exactly the quiz's questions at `/quizzo` time.
- Countdown GIFs are pre-rendered at build time and served as static assets.
- Tests for the Durable Object run under `@cloudflare/vitest-pool-workers`; pure modules (`trivia-core`, `slack-ui`) keep plain vitest.
- The app is now Cloudflare-specific. Leaving would mean rewriting the scheduling and storage layer again.
