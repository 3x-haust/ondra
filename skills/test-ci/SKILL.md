---
name: test-ci
description: >
  Writing tests or setting up CI (GitHub Actions) for a project (테스트 코드
  작성, "테스트 짜줘", CI 설정): unit and
  integration tests, a regression test for a bug, test structure, a ci.yml,
  lint/typecheck/test/build jobs, caching, matrices. Follows what large
  open-source projects (Vite, Vue, Astro, Next.js, TypeScript, uv, Flask,
  Tauri, Biome) do in common.
metadata:
  ondra-writes: '(^|/)\.github/workflows/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|/)test_[^/]+\.py$|(^|/)(vitest|jest|playwright)\.config\.'
---

# Tests and CI

The bar: a test fails only when the behaviour is broken, says what broke in
its name and message, and passes the same way every run. CI runs the same
commands a person runs locally, finishes fast, and can't be used to touch the
repo.

## 0. Read the project first

Order of authority: the project's own instructions (AGENTS.md, CONTRIBUTING,
README), then what the project already does, then the user's other projects,
then the open-source projects above. A pattern the project already has wins.

- Package manager and lockfile, scripts in `package.json` / `Makefile` /
  `pyproject.toml` / `Cargo.toml`, the runtime version file (`.node-version`,
  `.nvmrc`, `rust-toolchain.toml`, `requires-python`).
- Existing test runner, folder layout, naming, helpers and fixtures. Follow
  them. Add a runner only when there is none, and then the ecosystem default:

| stack | runner | where tests go |
|---|---|---|
| TS / JS (Vite, Solid, React, Vue, Node) | Vitest (Jest if it's already there) | `src/**/__tests__/*.test.ts` or `*.test.ts` next to the file — whichever the repo already uses |
| browser flows | Playwright | `e2e/*.spec.ts` |
| Python | pytest | `tests/test_<module>.py`, shared fixtures in `tests/conftest.py` |
| Rust | `cargo test` (`cargo nextest` if present) | unit: `#[cfg(test)] mod tests` in the file; integration: `tests/*.rs` |
| Go | `go test` | `<file>_test.go` next to the file, table-driven |
| Swift | Swift Testing / XCTest | `Tests/<Target>Tests/` |

## 1. Write the tests

**What to test**
- Behaviour through the public surface (exported function, CLI, HTTP route,
  rendered component), not private helpers or internal state.
- For each unit: the normal case, the edges (empty, one, many, boundary
  values, unicode, very large), and the error paths (bad input, failure of a
  dependency → the error the caller sees).
- A bug fix starts with a test that fails for that bug; it stays as the
  regression test, named after the behaviour, not the ticket.

**How each test looks**
- One behaviour per test, named as a sentence, so a failure says what broke:
  `returns null when the cache is empty`, `test_rejects_expired_token`.
- Assert the exact value (`toEqual(...)`), not just `toBeTruthy()`.
- Same shape, many inputs → a table (`it.each`, `@pytest.mark.parametrize`,
  Go table tests, a `for` over cases in Rust) instead of copied tests.
- Small inline fixtures; a builder (`makeUser({ name })`) when objects are
  big. No shared mutable state between tests: every test can run alone, in
  any order, in parallel.

**Deterministic** (a test that fails at random gets ignored)
- No real network, real clock, real randomness, or real home folder:
  fake timers / injected clock, seeded random, temp dirs (`tmp_path`,
  `fs.mkdtemp`, `tempfile`), local fake servers or recorded responses.
- Wait for the condition (`await vi.waitFor`, Playwright auto-waiting, polling
  with a deadline), not a fixed `sleep`.
- Mock only the boundary you don't own (network, filesystem, OS, time).
  Don't mock the code under test or its own modules.
- Snapshots suit large stable output (generated code, serialized ASTs); on UI
  markup that changes often they get updated blindly.

**Then prove they test something**
- Run the suite. Breaking the code on purpose (flip a condition, return
  early) and seeing the test fail readably is a quick proof; put it back.
- Running new tests a few times (`--repeat`/`--count`) catches flakiness.
- Coverage is a guide for missed branches, not a goal; don't write tests that
  only execute lines.

## 2. Local scripts first

CI calls the same scripts a person runs locally, so every CI failure
reproduces on a laptop. Make sure these exist and pass (repo's own names):

```
lint        # eslint / biome / ruff / clippy -D warnings
format      # check mode: prettier --check / biome check / ruff format --check / cargo fmt --check
typecheck   # tsc --noEmit / mypy / pyright
test        # the unit + integration suite, non-watch mode
build       # if the project builds
```

## 3. The workflow

`.github/workflows/ci.yml`. The settings below are what almost all of the
projects above share:

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

## 4. Check it before saying done

- Run every command from the workflow locally, in order, from a clean
  install (`rm -rf node_modules && pnpm install --frozen-lockfile`, a fresh
  venv, `cargo clean` only if cheap).
- Lint the workflow: `actionlint` if available, then `zizmor` for security
  findings; otherwise at least parse the YAML and check every `uses:` has a
  40-char SHA you looked up.
- Pushing to see it run leaves this machine: don't. Say the workflow is
  checked locally and runs on the next push.

## Report

- `files` block with the test files and the workflow, then a `test` evidence
  item per command you really ran (`kind: "test"`, `ok`), and the
  deliberate-break check if you did one (which change, which test caught it).
- `unverified`: the first real CI run, and any matrix OS you couldn't run
  locally.
