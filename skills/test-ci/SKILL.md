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
- One behaviour per test. Name says it as a sentence:
  `returns null when the cache is empty`, `test_rejects_expired_token`.
- Arrange → act → assert, in that order, blank line between. Asserts check
  the exact value (`toEqual(...)`), not just `toBeTruthy()`.
- Same shape, many inputs → a table (`it.each`, `@pytest.mark.parametrize`,
  Go table tests, a `for` over cases in Rust) instead of copied tests.
- Small inline fixtures; a builder (`makeUser({ name })`) when objects are
  big. No shared mutable state between tests: every test can run alone, in
  any order, in parallel.

**Deterministic, always**
- No real network, real clock, real randomness, or real home folder:
  fake timers / injected clock, seeded random, temp dirs (`tmp_path`,
  `fs.mkdtemp`, `tempfile`), local fake servers or recorded responses.
- No `sleep` to wait: wait for the condition (`await vi.waitFor`, Playwright
  auto-waiting, polling with a deadline).
- Mock only the boundary you don't own (network, filesystem, OS, time).
  Don't mock the code under test or its own modules.
- Snapshots only for large stable output (generated code, serialized ASTs),
  kept small and reviewed; never for UI markup that changes often.

**Then prove they test something**
- Run the suite. Break the code on purpose (flip a condition, return early):
  the relevant test must fail with a readable message. Put it back.
- Run the new tests 3 times (or `--repeat`/`--count`): same result each time.
- Coverage is a guide for missed branches, not a goal; don't write tests that
  only execute lines.

## 2. Local scripts first

CI calls scripts; it never holds logic of its own. Make sure these exist and
pass locally before writing any workflow (names after the repo's own style):

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
- Runtime version from the repo's version file, not typed into the workflow.
- `timeout-minutes` on every job. `fail-fast: false` on matrices.
- Matrix only what users really run: extra OSes/versions when the project
  promises them (a library: supported runtime versions; a macOS app:
  `macos-latest` and nothing else).
- Lint/format/typecheck in one fast job, tests in another, so a typo fails in
  a minute. A single gate job (`ci-ok`) is what branch protection points to,
  so matrix names can change freely.
- Skip docs-only changes with `paths-ignore: ['**.md', 'docs/**']` only on
  workflows that don't produce a required check (a required check that never
  runs blocks the merge); otherwise let it run.
- No secrets in pull_request jobs; never `pull_request_target` with a
  checkout of the PR's code.
- Every `run:` is a command that also works locally. No inline scripts
  longer than a few lines: put them in `scripts/`.

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
  item per command you ran (`kind: "test"`, `ok`), the count of tests added,
  and the deliberate-break check (which change, which test caught it).
- `unverified`: the first real CI run, and any matrix OS you couldn't run
  locally.
