# Slack Trivia

A Slack bot that runs timed multiple-choice trivia quizzes in a channel and scores the participants.

## Language

**Channel quiz**:
A quiz started with `/quizzo`, hosted in a single Slack message that is edited as the quiz progresses. The only supported surface.
_Avoid_: game, session

**Home quiz**:
A quiz hosted on the app's Home tab. Deprecated; not extended with new features.

**Participant**:
A user who has submitted at least one answer in a quiz.
_Avoid_: player, member

**Question**:
One multiple-choice prompt with four options, exactly one of which is correct, with an answer window of a fixed number of seconds.

**Answer window**:
The seconds during which an answer to a question earns a speed bonus. Answers arriving after it still count for the base point until the quiz ends: Slack delivery lag must never cost a participant their answer.
_Avoid_: deadline, cutoff, timeout

**Results**:
The screen shown after a question closes: the correct answer plus the current leaderboard.
_Avoid_: reveal, answer screen

**Final summary**:
The screen that replaces the quiz message when the last question's results expire: the final leaderboard.
_Avoid_: end screen, results

**Recap**:
A participant's private, per-question account of a finished quiz: every option of every question, marked by whether they picked it and whether it was correct, with the points earned. Opened on demand from the final summary.
_Avoid_: review, results, scorecard, answer sheet

**Speed bonus**:
Extra fractional points awarded for a correct answer in proportion to how quickly it was given.

**Leaderboard**:
Participants ranked by total points.
_Avoid_: scoreboard, standings
