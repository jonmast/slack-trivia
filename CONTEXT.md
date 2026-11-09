# Slack Trivia

A Slack bot that runs timed multiple-choice trivia quizzes in a channel and scores the participants.

## Language

**Channel quiz**:
A quiz started with `/quizzo`, hosted in a single Slack message that is edited as the quiz progresses. The only supported surface.
_Avoid_: game, session

**Participant**:
A user who has submitted at least one answer in a quiz.
_Avoid_: player, member

**Question**:
One multiple-choice prompt with four options, exactly one of which is correct, with an answer window of a fixed number of seconds.

**Answer window**:
The seconds from a question being posted during which an answer earns a speed bonus. It is soft: an answer arriving after it still counts for the base point, with no bonus, at any time until the quiz is finished, so Slack delivery lag never costs a participant their answer. Its end is also the absolute deadline the channel object sets an alarm for; when that alarm fires, results replace the question.
_Avoid_: deadline, cutoff, timeout

**Ready screen**:
The screen a channel quiz opens on: how many questions there will be and how long each one lasts, with a countdown to the first question so participants can gather before it appears. Nothing can be answered while it is up.
_Avoid_: lobby, wait screen, intro

**Results**:
The screen shown after a question closes: the correct answer plus the current leaderboard.
_Avoid_: reveal, answer screen

**Final summary**:
The screen that replaces the quiz message when the last question's results expire: the final leaderboard.
_Avoid_: end screen, results

**Recap**:
A participant's private, per-question account of a finished quiz: every option of every question, marked by whether they picked it and whether it was correct, with the points and speed bonus earned. Opened on demand from the final summary.
_Avoid_: review, results, scorecard, answer sheet

**Points**:
One for each correct answer, whenever it arrives before the quiz is finished. The only thing participants are ranked by.

**Speed bonus**:
A tie-breaker earned by a correct answer, larger the more of the answer window was left when it was given. It is not points and never adds to them: it only orders participants with equal points, and is always shown apart from them.
_Avoid_: bonus points

**Channel object**:
The Durable Object that owns one Slack channel's quiz: its stored state, its alarms and its calls to Slack. One per channel, addressed by channel ID. The only place quiz logic runs.
_Avoid_: instance, actor, worker

**Leaderboard**:
Participants ranked by points, with the speed bonus breaking ties.
_Avoid_: scoreboard, standings
