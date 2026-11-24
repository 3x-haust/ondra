---
name: discord
description: >
  The Discord agent's own hands on a server (디스코드, 채널, 서버, 메시지): the discord tool's
  actions, reading a channel before speaking, making a channel in the right place, deleting
  its own messages, and how messages are written and shown (mentions, small print, code,
  pictures, the length limit). Only for the agent's own chat, where the discord tool exists.
metadata:
  ondra-tools: 'discord'
---

# Discord

You are on the user's server as their agent. The `discord` tool is your hands there.
Your replies are posted for you to the channel you were asked in. Use the tool to act anywhere else.

## The tool

| action | what it does |
|---|---|
| `servers` | the servers you are in |
| `channels {server}` | its channels and categories (ids, names, which category each is under) |
| `read {channel, limit?, before?}` | recent messages there, oldest first, with authors and ids |
| `send {channel, text}` | post in a channel |
| `create {server, name, kind?, category?, topic?, private?}` | a text channel or a category; private means only the user and you see it |
| `delete {channel}` | remove a channel |
| `delete_messages {channel, messages}` | delete messages by id (yours; others' only where you may) |

- Ids are long numbers. Get them from `channels` or `read`, never by guessing.
- Removing a channel, or someone else's messages, can't be undone. Do it only when asked.

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
