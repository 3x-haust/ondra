# Local macOS guest preparation

The computer extension requires a trusted guest lifecycle registration. Preparing
an account or running a VM does not register it with an engine. Until a native
owner supplies that registration, `computer start` fails closed.

## Preparation viewer

`scripts/patches/lume-v0.7.0-isolated-preparation.patch` targets the Lume source
at tag `lume-v0.7.0`, under `libs/lume`:

https://github.com/trycua/cua/tree/lume-v0.7.0/libs/lume

Apply the patch in that directory, build the release executable, and sign the
local copy with the source's `resources/lume.local.entitlements`. Preserve the
`lume_lume.bundle` resource directory beside the executable. The executable must
be named `lume-local`: upstream only isolates all of its state through `LUME_HOME`
when invoked with that name. Do not install a global daemon or LaunchAgent.

This is a preparation-only patch, not a general-purpose change to Lume's VNC
semantics. With `--vnc disabled`, it disables the automatic clipboard watcher
(including late native attachment) and removes copy, paste, folder-sharing and
file-transfer callbacks from the viewer. The policy also reaches the macOS
virtualization configuration, excluding every VirtioFS device, including the
implicit live-update placeholder. Both startup and guest windows are
ordered behind existing windows without an explicit application activation.
A refused file drop is rejected before reading the drag pasteboard.

Use an explicit private `LUME_HOME`, explicit VM `--storage`, telemetry disabled,
`--network nat`, `--vnc disabled`, no shared directories, no extra disks and no
clipboard option. The preparation viewer uses `--display native` only while a
person approves guest permissions. It does not grant an automation lease.

These constraints do not make VNC-enabled runs safe, block every upstream CLI
command, or prove that AppKit cannot change focus under every macOS condition.
The patch also does not disable live native attachment for later automation.
The automation owner must separately enforce headless execution and prohibit
viewer attachment before issuing a lease.

Focused upstream regression tests added by the patch:

```sh
swift test --configuration release --jobs 4 --filter 'isolatedPreparationContext|isolatedClipboardSelection|nativeClipboardFallbackSelection|presenterSelectionAndGuestShutdownCleanup|fatalGuestStopCleanup|presenterFailureCleanup|cancellationCleanup|isolatedDirectoryConfiguration'
```

The lifecycle test uses the existing mock service and presenter. The directory
configuration test checks real Virtualization.framework configuration objects
without validating a full VM or booting one. Neither test sends host input.
Actual focus behavior requires read-only observation during the preparation run.

`restart-preparation.py` is a one-time local preparation utility. It expects the
private runtime layout created by provisioning under `$APP_ARTIFACTS_DIR/runtime`,
including a verified preparer digest and pinned connection files. It does not
adopt an arbitrary VM, provision accounts, or register a computer runtime. A
restart marker prevents accidental repetition; a partial failure requires
inspection, not deleting the marker and trying again. Required checks use
explicit exceptions even when Python optimization is enabled.

```sh
python3 -B scripts/computer-guest/test_restart_preparation.py
```

The actual-configuration log check is conservative: redirected runner stdout may
remain buffered and leave this check unconfirmed after the guest has already
restarted. Do not interpret that error as permission to restart again.

## Guest account and endpoint

Use a dedicated guest account with independent credentials and SSH keys. Pin the
server key from trusted provisioning, not a first network connection. Do not use
upstream SSH helpers that disable server-key verification. Keep passwords, keys
and per-boot nonces out of logs, model context and source control.

Install the endpoint and pinned desktop binaries at the paths documented in
`main.swift`, with root-owned, non-writable ancestors. Every new guest boot needs
a freshly generated nonce bound to the observed guest boot UUID. The endpoint
rejects stale boot state; do not bypass that check to regain a connection.

Accessibility and Screen Recording approval happens normally inside the guest.
Do not modify TCC databases or disable SIP. The permission identity must be
verified using the same SSH/endpoint path that will perform automation, not only
a command manually launched in the guest's Terminal.
