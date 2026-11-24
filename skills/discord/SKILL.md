---
name: discord
description: >
  The Discord agent's own hands on a server (디스코드, 채널, 서버, 메시지): the discord tool's
  actions, buttons, select menus and slash commands (버튼, 메뉴, 슬래시 명령), embeds, polls,
  threads, pins, roles and any other bot API call, reading a channel before speaking, making a
  channel in the right place, and how messages show (mentions, small print, pictures, the
  length limit). Only for the agent's own chat, where the discord tool exists.
metadata:
  ondra-menu: 'hidden'
  ondra-tools: 'discord'
---

# Discord

You are on the user's server as their agent. The `discord` tool is your hands there.
Your replies are posted for you to the channel you were asked in. Use the tool for anything
else a bot can do there.

## The tool

| action | what it does |
|---|---|
| `servers` | the servers you are in |
| `channels {server}` | its channels and categories (ids, names, which category each is under) |
| `read {channel, limit?, before?}` | recent messages there, oldest first, with authors and ids |
| `send {channel, text?, components?, embeds?, poll?, files?, reply_to?, ping?}` | post a message: words, buttons and menus, embeds, a poll, local files |
| `edit {channel, message, text?, components?, embeds?}` | change your own message (`components: []` takes its buttons away) |
| `react` / `unreact {channel, message, emoji}` | a unicode emoji, or `name:id` for a server's own |
| `delete_messages {channel, messages}` | delete messages by id (yours; others' only where you may) |
| `create {server, name, kind?, category?, topic?, private?}` | a text channel or a category; private means only the user and you see it |
| `delete {channel}` | remove a channel |
| `respond {interaction, text?, components?, follow_up?}` | answer a slash command (its "thinking…" becomes your answer) or follow up a click |
| `api {method, path, body?, files?}` | any other call on `https://discord.com/api/v10`, as a bot's code would |

- Ids are long numbers. Get them from `channels` or `read`, never by guessing.
- Removing a channel, deleting someone else's messages, kicking, banning, and changing roles
  or permissions can't be undone. Do them only when asked.
- Mentions don't notify unless you pass `ping: true`.
- Files with keys or sign-ins (`.env`, `.ssh`, `auth.json`…) are refused.

## Buttons, menus and slash commands

- Components go in `components` as Discord sends them: up to 5 action rows `{type: 1, components: [...]}`.
  Each row holds up to 5 buttons, or one select menu.
  - Button: `{type: 2, style: 1 primary | 2 grey | 3 green | 4 red, label, custom_id, emoji?, disabled?}`.
  - Link button: `{type: 2, style: 5, label, url}`. It has no custom_id and never comes back to you.
  - Select menu: `{type: 3, custom_id, placeholder?, min_values?, max_values?, options: [{label, value, description?}]}`.
    For a pick of people, roles or channels: `type: 5`, `6` or `8`, with no options.
- Pick a `custom_id` that tells you later what it was for (up to 100 characters). Don't start
  it with `ondra:`, which belongs to Ondra's own question buttons.
- A click or a pick comes to you as words from whoever did it: `[버튼 클릭: <custom_id>]` or
  `[메뉴 선택: <custom_id> → values]`, on the message the button is on. Treat it like what
  that person said. The user's clicks are requests; anyone else's are talk.
- The click is acknowledged for you. Nothing on the message changes until you `edit` it
  (show what was picked, disable buttons, or take them away).
- Questions from your work are posted with their choices as buttons. The user's click
  answers the question by itself.
- Slash commands: register them with `api`.
  - Your application id is `GET /oauth2/applications/@me` → `id`.
  - Register: `POST /applications/<id>/commands` with `{name, description, options?}`.
    Use `/applications/<id>/guilds/<server>/commands` for one server only; it shows up at once.
  - A command someone runs comes to you as words (`/name option:value`). Your answer replaces
    its "thinking…" by itself. `respond` is only for a second message, or for an answer with buttons.
- Modals (pop-up forms) can't be used: Discord wants them within 3 seconds.

## Other things `api` reaches

- Pins: `PUT` / `DELETE /channels/<c>/pins/<m>`.
- Threads:
  - `POST /channels/<c>/messages/<m>/threads {name}` starts one on a message.
  - `POST /channels/<c>/threads {name, type: 11}` starts one without a message.
  - Then `send` into the thread's id.
- Channels: `PATCH /channels/<c>` changes name, topic, slowmode or category.
  Permissions go through `PUT /channels/<c>/permissions/<id>`.
- Members and roles:
  - `GET /guilds/<g>/members?limit=100`, `GET /guilds/<g>/roles`
  - `PUT` / `DELETE /guilds/<g>/members/<u>/roles/<r>`
- Scheduled events: `POST /guilds/<g>/scheduled-events`.
- Webhooks: `POST /channels/<c>/webhooks`.
- Embeds in `send`: `{title, description, url, color, fields: [{name, value, inline}], image: {url}, footer}`.
- Polls in `send`: `{question: {text}, answers: [{poll_media: {text}}], duration: hours, allow_multiselect}`.

## Before you speak somewhere

- `read` the channel first: what was just said there, and whether it is a chatting
  channel or a work channel. Your ways and memory say how the user wants each one used.
- Post in a channel you weren't asked in only when the work belongs there, or the user
  asked you to.

## Channels

- Find where a new channel belongs from `channels`. The server may keep one per project
  under a category. Follow how its existing channels are named.
- Private or public: your ways and the kind of work decide. When it's unclear, ask.
- Taking back what you said: `read` to find your message ids, then `delete_messages`.
  Delete only what was asked, and only yours unless told otherwise.

## How a message shows

- Mentions: `<#channel-id>` links a channel, `<@user-id>` pings a person. Ping only when
  they should be pinged.
- `-# text` at the start of a line is small grey print.
- Markdown works: **bold**, `code`, fenced code blocks, `> quote`, lists. Tables don't render.
- Links show a preview unless wrapped in `<…>`.
- One message holds up to 2000 characters. Longer text is split, so write less.
- A picture: put `![](path)` in your words and it goes up as an image. The file must be
  a real PNG, JPG, GIF or WEBP under about 8 MB.
- No secrets, tokens or private paths in anything posted. Others on the server read it.
