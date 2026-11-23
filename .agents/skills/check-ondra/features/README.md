# Ondra feature map

Secure-input areas only, not the whole product. Each was driven once on the
host in a scratch development build (see each area's "Last run").

## Starting state

SKILL.md's build, launch and Doctor pass. No imported accounts other than the
one onboarding finds, no projects. A run-unique `CHECK_` dummy name with a
public value. Native secure checks need Accessibility and Screen Recording
for the development app (SKILL.md, Build step 6).

## Driving rules

Native `computer` refs, one action, then observe. The bridge only reads the
DOM, except the public dummy value in Settings. Answer cards through their
own buttons; never call `decide`, `extensionUi` or fake RPC. Read what a job
did from its session file. Automated computer evals stay VM-only.

## Areas (sweep order)

1. [Secret settings](secrets.md): open, save, name-only persistence, delete.
2. [Job confirmations](job-confirmations.md): deny, allow, retry once,
   per-card pause and timeout with two cards waiting.
3. [Secure computer](agent-computer.md): `targets`/`target` on an open sheet,
   `fill-secret` deny then allow, cancel, `resume`, `stop`.

Journey: save dummy → job asks to fill it → deny → allow → cancel the target
sheet → delete dummy. Run on the host with Keychain Access's `새로운 암호 항목`
sheet as the target; the sheet was cancelled, nothing was added.
