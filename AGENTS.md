# Rules

- Never print the contents of `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`): its tokens are replaced by `[secret:codex/auth.json:…]` in every tool result and refused in memory by `extensions/secrets.ts` (`codexSecrets`), loaded in jobs and in main; held by `extensions/secrets.test.ts` and `src/engine/captainSkills.test.ts`.
