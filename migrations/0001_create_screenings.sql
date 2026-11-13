-- One row per screening verdict, for questions asked, rejected and unscreened.
CREATE TABLE screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- The timestamp of the message the quiz is played in.
  message_ts TEXT NOT NULL,
  question TEXT NOT NULL,
  -- JSON array of all four options, the correct one first.
  options TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('served', 'rejected', 'unscreened')),
  -- Jev's top class; NULL when unscreened or Jev gave none.
  class TEXT,
  -- JSON object of each class's probability; NULL when unscreened.
  probabilities TEXT,
  -- NULL when unscreened.
  model TEXT,
  screened_at TEXT NOT NULL
);

CREATE INDEX screenings_question_id ON screenings (question_id);
CREATE INDEX screenings_message_ts ON screenings (channel_id, message_ts);
