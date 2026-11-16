---
name: test-ci
description: >
  Writing tests and CI workflows (테스트 짜줘, 단위·회귀 테스트, CI 설정해줘,
  워크플로): unit and regression tests, a ci.yml with lint, typecheck and
  tests in Actions. Skip unless tests get written.
metadata:
  ondra-writes: '(^|/)\.github/workflows/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|/)test_[^/]+\.py$|(^|/)(vitest|jest|playwright)\.config\.'
---

# Tests and CI

The bar: a test fails only when the behaviour is broken, says what broke in
its name and message, and passes the same way every run. CI runs the same
commands a person runs locally, finishes fast, and can't be used to touch the
repo. Writing or changing a workflow: read `ci.md` in this folder too.

## 0. Read the project first

Order of authority: the project's own instructions (AGENTS.md, CONTRIBUTING,
README), then what the project already does, then the user's other projects,
then common practice in large open-source projects. A pattern the project
already has wins.

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
  When other jobs share the folder, break a copy in the scratch folder, so
  their runs never see the broken code.
- Running new tests a few times (`--repeat`/`--count`) catches flakiness.
- Coverage is a guide for missed branches, not a goal; don't write tests that
  only execute lines.

## Report

- A job: a `files` block with the tests (and workflow), a `test` evidence
  item per command you really ran (`kind: "test"`, `ok`), and the failure
  you saw (old code or a deliberate break, and which test caught it).
- A sub-task's `done` has only `summary` and `result`, so `result` carries
  the same: each command with its outcome, the failure you saw, and what
  you couldn't run.
