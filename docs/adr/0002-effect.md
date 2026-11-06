# Run the channel object on Effect, with transient and permanent Slack failures kept apart

The channel object read its stored rows and the Trivia API's payloads with a bare `JSON.parse` and trusted the shape, threw untyped `Error`s for expected outcomes such as a finished quiz or bad `/quizzo` arguments, and decided case by case in `try`/`catch` whether a failure should end a quiz or let the platform retry the alarm. None of those decisions showed in the types, and the anti-slop lint rules adopted on the same branch reject unchecked casts and runtime `typeof` narrowing in favour of parsing at the boundary.

We adopted Effect v4 (`effect@4.1.2`). The Trivia API question, the quiz snapshot and the stored quiz row are `Schema`s, so everything read from the network or SQLite is decoded rather than trusted. Expected failures are tagged errors in the Effect error channel. The object's dependencies — its storage, Slack, The Trivia API and its config — are services provided by one `ManagedRuntime` per object, and each RPC method and the alarm run a single program from `worker/channel-quiz.ts`. Scoring, ranking and the Slack renderers stay plain functions.

Slack failures fall into two kinds, and the alarm handler treats them differently:

- **Transient** — `SlackRequestError`: Slack could not be reached or answered with an HTTP error (a rate limit, a 5xx, a dropped connection). The alarm rejects, the failure is logged as a warning, and the platform retries the alarm; the quiz carries on.
- **Permanent** — Slack answered `ok: false` (`SlackApiError`), the object does not know its channel, the question source ran dry, or the stored row cannot be decoded or rebuilt. The quiz ends: a final summary is attempted where there is a leaderboard to show, and the channel is released either way.

## Considered options

- **Stay on plain TypeScript, adding hand-written validation.** Smaller dependency footprint, but every decoder, error type and transient-versus-permanent decision would stay ad hoc and outside the types.

## Consequences

- `effect` is a runtime dependency of the Worker, and the build script must not import modules that load it; the timing constants it needs live in the dependency-free `src/timing.ts`.
- Stored rows are decoded on every read, so a schema change must keep earlier rows decoding (see `test/worker/quiz-record.test.ts`); a row that no longer decodes is abandoned rather than holding the channel.
- `submitAnswer` still runs synchronously (`runSync`), so its write commits before the Slack ack is released.
- Some `ok: false` codes are really transient (for example `internal_error`, `fatal_error`, `service_unavailable`), yet they end the quiz today. Classifying them as transient is a known follow-up.
