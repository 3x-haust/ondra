# CI with GitHub Actions

Read with SKILL.md when a job writes or changes a workflow. A pattern the
repo already has wins over this file.

## 1. Local scripts first

CI calls the same scripts a person runs locally, so every CI failure
reproduces on a laptop. Make sure these exist and pass (repo's own names):

```
lint        # eslint / biome / ruff / clippy -D warnings
format      # check mode: prettier --check / biome check / ruff format --check / cargo fmt --check
typecheck   # tsc --noEmit / mypy / pyright
test        # the unit + integration suite, non-watch mode
build       # if the project builds
```

## 2. The workflow

`.github/workflows/ci.yml`. The settings below are what most large
open-source projects share:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions: {}            # nothing by default; each job asks for what it needs

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  check:
    name: Lint, format, typecheck
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<sha> # vX.Y.Z
      - uses: actions/setup-node@<sha> # vX.Y.Z
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format
      - run: pnpm typecheck

  test:
    name: Test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest]
    steps:
      - … same setup …
      - run: pnpm test
      - run: pnpm build

  ci-ok:                     # the one check branch protection requires
    name: CI passed
    if: always()
    needs: [check, test]
    runs-on: ubuntu-latest
    steps:
      - run: '[ "${{ contains(needs.*.result, ''failure'') || contains(needs.*.result, ''cancelled'') }}" = "false" ]'
```

Rules:
- **Pin every action to a full commit SHA** with the version as a comment.
  Look the SHA up (`gh api repos/<owner>/<action>/commits/<tag> -q .sha`);
  never write one from memory. Keep the repo's style if it already pins by tag.
- `permissions: {}` at the top, `contents: read` per job, more only where a
  job really writes (releases, comments). `persist-credentials: false` on
  checkout.
- Install from the lockfile only: `--frozen-lockfile`, `npm ci`,
  `uv sync --locked`, `cargo … --locked`. Use the setup action's built-in
  cache (`cache: pnpm`, `enable-cache: true`, `Swatinem/rust-cache`) before
  hand-written `actions/cache`.
- Runtime version from the repo's version file, so local and CI agree.
- `timeout-minutes` on jobs so a hang doesn't burn hours. `fail-fast: false`
  on matrices.
- Matrix what users really run: extra OSes/versions when the project
  promises them (a library: supported runtime versions; a macOS app:
  usually just `macos-latest`).
- Lint/format/typecheck in one fast job, tests in another, so a typo fails in
  a minute. A single gate job (`ci-ok`) is what branch protection points to,
  so matrix names can change freely.
- Skip docs-only changes with `paths-ignore: ['**.md', 'docs/**']` only on
  workflows that don't produce a required check (a required check that never
  runs blocks the merge); otherwise let it run.
- No secrets in pull_request jobs; never `pull_request_target` with a
  checkout of the PR's code.
- Every `run:` is a command that also works locally; longer inline scripts
  are easier to test and reuse from `scripts/`.

## 3. Check it before saying done

- Run every command from the workflow locally, in order, from a clean
  install (`rm -rf node_modules && pnpm install --frozen-lockfile`, a fresh
  venv, `cargo clean` only if cheap).
- Lint the workflow: `actionlint` if available, then `zizmor` for security
  findings; otherwise at least parse the YAML and check every `uses:` has a
  40-char SHA you looked up.
- Pushing to see it run leaves this machine: don't. Say the workflow is
  checked locally and runs on the next push.

In the report, `unverified`: the first real CI run, and any matrix OS you
couldn't run locally.
