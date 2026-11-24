---
name: github
description: >
  GitHub work through the gh CLI (깃허브, 이슈, PR, 리뷰, 머지, CI, 릴리즈): which account
  and repo you are on, reading an issue or PR with its comments and checks, opening a PR
  the repo's way, reviewing, merging the way the repo merges, reading a failed CI run,
  releases and the API. Skip for plain git on a local branch.
metadata:
  ondra-commands: '\bgh\s+(pr|issue|run|release|api|repo|workflow|auth)\b'
  ondra-urls: 'github\.com/[^/\s]+/[^/\s]+/(pull|issues|actions|releases)'
---

# GitHub

Work through `gh`. The web pages are for a person to look at; give them links.

## Where you are

- `gh auth status` says which account is signed in. When the repo or memory names an
  account to use, check it before you push, comment or merge. If it's the wrong one, say so.
- Inside a clone, `gh repo view --json nameWithOwner,defaultBranchRef,visibility` tells
  you the repo and its default branch. Outside one, pass `-R owner/repo`.
- Never print tokens (`gh auth token`, `~/.config/gh/hosts.yml`).

## Reading

- An issue or PR with its talk: `gh issue view N --comments`,
  `gh pr view N --comments --json title,body,state,mergeable,reviewDecision,statusCheckRollup,files`.
- A PR's change: `gh pr diff N` (`--name-only` first on a big one).
- Checks: `gh pr checks N`. A failed run: `gh run view RUN --log-failed`. Read the first
  real error, not the last line.
- Lists: `gh issue list` and `gh pr list` with `--state`, `--label`, `--author`, `--search`
  (GitHub search syntax), `--json` and `--jq` for exact fields.
- Anything else: `gh api repos/{owner}/{repo}/...` (`--paginate` for lists),
  `gh api graphql` for nested data.

## Writing

- Bodies go in a file (`--body-file`), never inline: quotes and newlines survive, and
  nothing is lost to the shell.
- The repo's own template comes first: `.github/pull_request_template.md`,
  `.github/ISSUE_TEMPLATE/`. Without one, write a few plain sentences: what changed and
  why, how it was checked, what is still open.
- Link what it closes the repo's way (`Fixes #N` closes on merge).
- Write in the language and tone the repo already uses in its issues and PRs.
- No secrets, private paths or the user's personal details in anything posted.

## A PR

- Push the branch, then `gh pr create --base <default> --head <branch> --title … --body-file …`
  (`--draft` when it isn't ready).
- After pushing again, look at the checks before you call it ready.
- Reviewing: read the diff and the files around it, then
  `gh pr review N --comment|--approve|--request-changes --body-file …`. A line comment
  goes through `gh api` (`pulls/N/comments` with `commit_id`, `path`, `line`).

## Merging

- Merging is not undone easily: do it when you were asked to or your memory says so.
- Merge the way the repo does:
  - `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge`
    shows what is allowed.
  - Recent merged PRs (`gh pr list --state merged -L 5 --json mergeCommit,title`) show
    what people actually use.
- `gh pr merge N --squash|--merge|--rebase [--delete-branch]`. When branch protection
  holds it, say what it waits on (reviews, checks). Bypass it only when told to.
- Never force-push or push directly to the default branch unless told to.

## Releases

- `gh release list`, `gh release view TAG`.
- `gh release create TAG --target SHA --title … --notes-file … files…`. Upload files with
  `gh release upload TAG files… --clobber`.
- A repo with its own release script or workflow: use that, not a hand-made release.

## Links for the user

- Repo: `https://github.com/OWNER/REPO`
- Issue: `…/issues/N`
- PR: `…/pull/N` (add `/files` for the diff)
- Run: `…/actions/runs/RUN`
- File at a commit (stays valid): `…/blob/SHA/path#L10-L20`
