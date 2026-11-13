---
name: secrets
description: >
  API keys, tokens, passwords and .env files (시크릿, API 키, 토큰, 비밀번호,
  .env, 환경변수, 인증 실패, 401/403, 배포 키). How to use the secrets Ondra
  sets in your shell without seeing their values, find out which one a job
  needs from memory, save what each one is for, and what to do when one is
  missing or the user pastes one into the chat.
metadata:
  ondra-reads: '(^|/)\.env(\.[^/]*)?$'
  ondra-writes: '(^|/)\.env(\.[^/]*)?$'
---

# Secrets

Ondra keeps the user's keys in the macOS keychain (Settings › 시크릿) and sets
them as environment variables in your shell. Your prompt names them under
"## Secrets". You never see a value, and you don't need to.

## Using one

- In a command: `$NAME` or `"${NAME}"`. `curl -H "Authorization: Bearer $OPENAI_API_KEY"`,
  `gh` reads `$GH_TOKEN`, `docker run -e STRIPE_KEY` passes it through by name,
  `vercel --token "$VERCEL_TOKEN"`.
- In code you run: `process.env.NAME`, `os.environ["NAME"]`. Don't paste a value
  into source; read the variable.
- A tool that reads a `.env` itself (Next.js, Vite, dotenv, Prisma) gets the
  values from the project's `.env` files, which Ondra keeps in step with the
  keychain. Run it from the folder whose `.env` it should read.
- `[secret:NAME]` in a result means the value was there and was hidden from
  you. It is not an error and the command still got the real value. Don't
  try to reveal it (`echo`, `base64`, `xxd`, splitting it up): the log records
  each use, and the user trusts this.

## Which one

Several keys can look alike (`API_KEY` in `Deploy/.env`, `OPENAI_API_KEY` at
the top, a test and a live Stripe key). Before picking:

1. `memory_search` the name (or the service: "Stripe 키", "배포 토큰"). Every
   secret has a memory piece saying where it is from; a better one may say
   what it is for.
2. A name listed with a folder (`WEB_TOKEN (Deploy/Front/.env)`) belongs to
   that folder's app.
3. Still unclear and it matters (live payments, production deploys, sending
   mail to real people): ask the user which one, by name.

## Keeping what each one is for

When you learn what a secret is for, save it so the next job doesn't have to
find out again. One `memory_save` per secret, in the user's language:

- the name, the service, and what uses it (a script, a command, a deploy
  step): "`VERCEL_TOKEN`: DeployFront를 Vercel에 배포할 때 `pnpm deploy`가 써요."
- test or live, and what breaks without it, when you know.
- `about: ["시크릿", "<service>"]`, and `replaces` the piece about the same name
  that `memory_search` found, so one piece per secret stays.

Never put a value, or part of one, in memory: a save with a value is refused.

## Missing or wrong

- Not set at all: tell the user its name and what it is for, and ask them to
  add it in **Settings › 시크릿** (the project's, or "전체" for every job). A
  new value reaches jobs started after it is saved.
- Never ask the user to paste a key into the chat. If they paste one anyway,
  use it for what they asked, don't repeat it back, and suggest saving it in
  Settings › 시크릿 so it stays out of chats from then on.
- 401/403 with a key that is set: say which name was used and the error; it
  may be expired, a test key against live, or the wrong project's. Don't
  try other keys you find lying around.

## Files and commits

- Never write a value into a file you commit, a log, a report or a message.
  `.env` files stay out of git; check `git check-ignore .env` before adding one.
- A new variable a project needs goes into `.env.example` with an empty value
  and a one-line comment, and its value into Settings › 시크릿.
- Names starting with `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_` or `REACT_APP_`
  are built into the browser bundle: never give such a name to a secret key.
