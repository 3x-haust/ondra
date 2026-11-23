# Connection and instructions

## What it has

- Settings → 에이전트: bot on/off, token-presence indicator, owner identity,
  working space/account, other people's channels, voice.
- Agent view → 기억: the separate social memory and `내 방식` from AGENT.md.
- A user turn and an application event both read current personal ways.

## How to get there

Open Settings → 에이전트. After connecting, open the sidebar's 에이전트 and
its 기억 tab. The agent chat is view-only; speak to it through Discord.

## Check

1. Doctor the isolated app and confirm the installed bot is off.
2. Enable the check app's bot. Observe the connected status and owner identity;
   never print a token to prove it exists.
3. Open 기억. Confirm the approved personal ways are visible in `내 방식`.
4. Exercise a way through a real Discord message in the conversation area.
   When checking a changed way, change only the isolated copy, send another
   message, and observe behavior without restarting the app.
5. During cleanup, disable the check connection before restoring the installed
   bot. Keep the connected and disconnected results.

## Gotchas

- A new app signature can require the user's keychain approval. Opening this
  page can wait on that approval. Do not replace the token or approve the
  system dialog yourself.
- An authenticated engine and a connected Discord gateway are different checks.
- The same bot must not be enabled in both apps, or in a separate server process.
- The app does not display a source commit; a build record identifies the code.
