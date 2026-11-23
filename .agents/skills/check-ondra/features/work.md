# Work, questions and events

## What it has

- Agent view → 작업: Discord work, separate from the user's main/project jobs.
- Task question events enter the agent chat. The model chooses a response and
  uses the normal decision handler for question rounds and landing decisions.
- Completion and alarms are app events, not automatic copies to Discord.
- Agent view → 루틴 shows enabled agent routines; draft acceptance can enable
  the existing routine instead of creating another one.

## How to get there

Ask through the authorized Discord channel. Use a scratch project and harmless
content. Open the agent's 작업 or 루틴 tab for the corresponding state.

## Check

1. Request a small scratch-file task with a brief progress report and a question
   before writing. Do not use the product checkout as a disposable test folder.
2. Observe the real question in Discord. Answer without mentioning the bot and
   confirm the same work resumes. For a two-question round, confirm answering
   the first question leads to the second, not premature work completion.
3. Observe the file's contents and the job's terminal state. Confirm progress and
   the final result are stated by the agent in the channel, without an extra
   automatic transcript, photo copy or fixed completion line.
4. Request a short one-time alarm containing the run marker. Observe its due
   event and actual Discord delivery. Record whether the model chose a mention;
   do not count the presence of an owner ID as delivered notification.
5. When checking drafts, explicitly request a proposed routine without enabling
   it. Agree in a later message; confirm the original routine becomes enabled
   and no duplicate is created. Pause the test routine through the normal UI.

## Gotchas

- A scratch task can still invoke real tools. Prohibit pushing, merging,
  releasing and modifying unrelated files in the request.
- A model may answer a tiny request directly rather than create a job. That
  does not prove the task-question or completion-event path.
- Do not inject a task, decision, alarm or completion into application state as
  a substitute for the user flow.
- Merge, keep and discard have distinct effects. This harmless pass does not
  prove an actual merge or deletion, and does not authorize either.
- Routine drafts and agent-created main questions may not be visible in all
  views. Report the observed limitation rather than dismissing a stuck flow.
- The job may ask and report in Discord itself with the discord tool. The agent
  then reads history and stays quiet instead of repeating it. Count the
  question and the report once, from whoever posted them.
- The job's first entry carries the channel's recent talk. A PR link in that
  talk can be shown as the job's PR. Check the job's PR before trusting it.
