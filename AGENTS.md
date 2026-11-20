# Rules

- Never print the contents of `~/.codex/auth.json`: its tokens are replaced by `[secret:codex/auth.json:…]` in every tool result and refused in memory by `extensions/secrets.ts` (`codexSecrets`), held by `extensions/secrets.test.ts`.
