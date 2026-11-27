# Rules

- In a git worktree, `gh pr merge --delete-branch` is blocked: merge without it, then `git push origin --delete <branch>` (held by `worktreeMergeDelete` in `extensions/permissions.ts`, tested in `extensions/permissions.test.ts`).
