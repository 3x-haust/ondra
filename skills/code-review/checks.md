# Broad checks (코드 검토)

What to look at for each kind of changed file, and the tools to run on it.
Run a tool only when it is already installed (`command -v <tool>`) or the
project has a script for it; never install one, never let one write files or
fix code, and give each run a timeout. A tool that isn't there goes in
`확인한 것` as not run, with no guess about what it would have said.

## The project's own checks first

The scripts the repo already has (`package.json` scripts, a Makefile, CI
workflow steps, `cargo clippy`, a pre-commit config): lint, type check and
the tests beside the changed files. Run them on the changed files where they
take paths. These outrank any tool below.

## By what changed

| Changed | Look for | Run when present |
|---|---|---|
| any file | credentials added: API keys, tokens, private keys, passwords, connection strings with a password, a committed `.env` | `gitleaks git --log-opts="<base>..HEAD" .` and `gitleaks dir <file>` for files not yet committed; otherwise `rg -n -i '(api[_-]?key\|secret\|token\|passw(or)?d\|BEGIN [A-Z ]*PRIVATE KEY)' <changed files>` and read each hit |
| code that takes outside input (network, files, args, IPC, env, the user) | that input reaching a shell, SQL, `eval`, HTML, a file path (`../`), a URL the server fetches, or a deserializer, unchecked | `semgrep scan --config <the repo's semgrep.yml> <files>`, only with a config the repo keeps; `ast-grep` for a pattern you need to find in all callers |
| a route, command, IPC or API handler | the permission or login check its neighbours have; data of one user readable by another | — (read the neighbours) |
| logging, telemetry, error messages | tokens, passwords, personal data (emails, phone numbers, addresses, IDs) written out | — |
| a manifest or lockfile (`package.json`, `pnpm-lock.yaml`, `Cargo.toml`/`.lock`, `go.mod`, `requirements*.txt`, …) | known vulnerabilities in packages the change added or bumped; a manifest changed without its lockfile; a downgrade; a range that lets in the next major; a package name that doesn't exist or is one letter off a popular one; a license the project can't ship | `osv-scanner scan -L <lockfile>` (`--licenses` for licenses); or the package manager's own (`pnpm audit`, `npm audit`, `cargo audit`, `pip-audit -r <file>`); `npm view <pkg> name license` for a new name |
| CI workflows (`.github/workflows/*`) | `${{ github.event.* }}` or other untrusted text inside `run:`; `pull_request_target` that checks out the PR's code; `permissions` widened; third-party actions not pinned to a commit; secrets passed to steps that don't need them | `actionlint <files>`, `zizmor <files>` |
| shell scripts | unquoted variables, `cd` without a check, `set -e` gaps | `shellcheck <files>` |
| Dockerfile, compose, Kubernetes, Terraform | running as root, `latest` tags, secrets in layers or env, open ports or buckets | `hadolint`, `trivy config <dir>`, `checkov -d <dir>`, `tflint` |
| a public API, CLI flag, config key, file format, DB schema, saved data | callers or older saved data that the new shape breaks (this is also 설계 검토's) | `oasdiff breaking <base spec> <new spec>` for an OpenAPI file |
| code on a path that runs per item, per frame or per request | a query, file read or network call inside a loop; work repeated on every render; lists, caches or listeners that only grow; a blocking call on the UI thread | — (find the realistic size in the project: rows, files, users) |
| code that opens or starts something | files, sockets, timers, subscriptions, child processes never closed or stopped; a promise rejection nobody catches | — |
| language code | the language's linter, on changed files | ESLint/Biome/oxlint (JS/TS), Ruff (Python), `cargo clippy` (Rust), golangci-lint (Go), SwiftLint, RuboCop, markdownlint |

## Reading a tool's result

- Keep only results on lines this change added or changed. A result that is
  also there on the base is old: leave it out (one line in `확인한 것` at most).
- A tool result is evidence (part 3 of the four), not a finding. Read the
  code it points at, then find the trigger and the consequence yourself.
  Without them it is a P3 with the tool's rule ID, or nothing.
- A known vulnerability counts as P1/P2 only when the vulnerable part is
  reachable here: the package ships at runtime and this project calls the
  affected function or accepts the affected input. A dev-only tool, or a
  path you can't show is used: P3 with the advisory ID and the fixed version.
- Severity: keep high and critical results as candidates; low and medium only
  when you can trace them to real harm here.
- Write the counts in `확인한 것`: each tool run, how many results on changed
  lines, how many became findings.
