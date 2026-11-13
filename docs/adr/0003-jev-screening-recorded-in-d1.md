# Screen questions with Jev, fail open, and record every verdict in D1

The Trivia API serves some misleading and garbled questions, and its own filters (difficulty, category, region) do not sort them out. We screen each fetched question with Jev's classifier through OpenCode Zen before it can be asked, on the paid `jev-1.13` model rather than the free one, so screening does not stop when the free offer ends. Screening runs during the ready screen, and blocking a good question is acceptable; a quiz that never starts is not. So when Jev cannot be reached or errors, the quiz falls back to unscreened questions as before. Every verdict, for questions both asked and rejected, goes to one D1 database shared by all channels. That record is how a question someone complains about is traced to what Jev said about it, and how the rejection rules get tuned.

## Considered options

- **Workers Logs only.** No new resource, but entries expire after a few days: a question flagged the next week would already be gone.
- **A table in each channel object's SQLite.** Durable and free, but split across one database per channel, with no way to query it short of adding an admin endpoint.
- **Fail closed when Jev is unreachable.** Never shows an unscreened question, but makes an outside service a hard dependency of starting a quiz.

## Consequences

- The Worker needs an OpenCode Console API key as a secret and a D1 binding. D1's free allowance covers this app many times over.
- An unscreened question can still reach a quiz during a Jev outage; its record says it was not screened.
