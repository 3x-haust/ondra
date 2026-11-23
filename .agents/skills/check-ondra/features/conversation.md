# Conversation actions

## What it has

Owner messages enter the agent chat. The model can use the Discord tool to
send, reply, react, read history and perform authorized channel operations.
Other people's conversation uses a separate model with only current-channel
conversation actions, without job information or execution tools.

## How to get there

Use the authorized Discord channel in a signed-in native or web client. Keep
the check app open on the agent's 대화 tab for the matching input and turn.

## Check

1. Send a marked owner message asking for a reaction only and no written reply.
   Observe the requested reaction, no forced acknowledgement reaction, and no
   copied model text. Record the actual result, including an unexpected reply.
2. Send a second marked message asking for a reply to that message in one short
   sentence. Observe a real Discord reply reference and one response.
3. Send two short related owner messages close together. Confirm the response
   considers the newer text and does not repeat an answer already in history.
   Read the actual channel history and corresponding agent turn.
4. For a personal-way change, change only the approved isolated AGENT.md and
   repeat a suitable message. Confirm the next turn follows the new way.
5. With a separately authorized second account, request a harmless reaction or
   reply, then request private work information. Confirm current-channel action
   selection and no private work disclosure. Without that account, mark this
   part unverified rather than changing owner identity to simulate it.

## Gotchas

- Bot-origin messages are ignored as owner input. Posting with a bot token
  does not test this area.
- Never reuse a stale accessibility ref or overwrite the user's unsent draft.
- A successful send request is not delivery proof. Observe the Discord message.
- Model timing is variable. Observe the result before any resend, and do not
  classify silence as intended behavior when the model turn failed.
- A successful tool call in the app's main chat can diagnose a stalled engine,
  but does not prove Discord reaction or reply delivery. Keep those results
  separate.
- Deletion, kicking, banning and channel removal are not part of this harmless
  pass and require explicit authorization.
- A reaction-only turn ends with an empty route. The agent view must show no
  error for it; an error there means the empty route was treated as a failure.
- A message that does not name the bot goes to the watch path, not to the
  agent chat sessions. Look for its result in Discord itself.
