---
name: add-workspace-driver
description: Add a new WorkspaceDriver (tmux, ghostty, kitty, wezterm, zellij, container) or change the driver port. Use when lanes should live somewhere other than the daemon's own PTYs.
---

# Adding a WorkspaceDriver

A driver decides **where a process physically lives**. It does not decide where you look at it.
The port is `packages/drivers/core/src/port.ts`; the reference implementation is
`packages/drivers/pty`.

## The job is: import the suite, run it, fix what's red

1. Create `packages/drivers/<name>` depending on `@wilco/core` and `@wilco/drivers-core` (plus
   whatever the backend needs), with `vitest` as a dev dependency.
2. `packages/drivers/<name>/test/conformance.test.ts`:
   ```ts
   import { testWorkspaceDriver } from '@wilco/drivers-core/conformance'
   import { TmuxDriver } from '../src/index.ts'
   testWorkspaceDriver('tmux', () => new TmuxDriver())
   ```
3. Implement until the suite passes. It covers the round-trip, output ordering, concurrent writes,
   resize, titles, replay, exit reporting, idempotent close, and typed errors.
4. Register it in `drivers` in `packages/daemon/src/registry.ts`. That map is the only place a
   driver name turns into an implementation.
5. Add the driver to the `workspace.driver` enum in `packages/core/src/config.ts`.
6. Update the driver table in `README.md`.

## Rules

- **Declare capabilities honestly.** `capabilities` says what the driver can do; call sites branch
  on those flags and never on `driver.id` (a lint plugin enforces it). A capability you declare
  must work; one you don't must throw `UnsupportedCapabilityError`, never fail silently.
- **No implementation vocabulary in the port.** If you want to add `sendKeys`, `newWindow` or
  `selectPane` to the interface, the answer is no: find the neutral name, or it belongs in the
  driver's own module.
- **`attachCommand` must always return something that works.** It is the escape hatch that lets a
  human see a lane whatever the backend is.
- **Typed errors:** `LaneNotFoundError` for unknown lanes, `LaneClosedError` after close.
- **`open()` must not leave a phantom lane.** If the command can't launch, reject and register
  nothing (the PTY driver resolves the executable before spawning, because node-pty reports a
  failed exec asynchronously).
- Prefer capabilities the backend genuinely has: a mux server (tmux, wezterm, zellij) can offer
  `detach: true`; an emulator-driven driver (ghostty, kitty) usually cannot.

## What the second driver turned out to need

`packages/drivers/tmux` passed the suite once these were right. They are likely to matter for any
backend that is a separate program rather than a library:

- **Order writes yourself.** `pty.write` is synchronous, so call order survives for free. Every tmux
  write is a separate process, so concurrent writes land in whatever order they finish. A per-lane
  promise queue, appended to synchronously inside `write()`, is what makes the ordering test pass.
- **Send bytes, not text.** `send-keys -H` takes hex, so control characters and UTF-8 survive
  exactly instead of being interpreted as key names.
- **Ask the backend to keep dead processes.** `remain-on-exit on` leaves the pane holding its exit
  status, which is the only way to report an exit code. Set it before opening anything, or a
  fast-exiting command is gone before the option applies.
- **Address lanes by the backend's own id** (`@3`, from `new-window -P -F '#{window_id}'`), never by
  a name you chose: names get sanitised, truncated and renamed.
- **Keep the lane id where the backend keeps state** (tmux user options, `@wilco-lane`), so `adopt`
  recovers lanes exactly rather than reverse-engineering window names.
- **Replay only what has already been delivered live.** If replay reads to the end of the buffer,
  the poller delivers the tail again and the subscriber sees it twice.
- **Anything the backend runs through a shell must be shell-quoted**, even though the backend itself
  is invoked with an argument array and no shell.

## Native dependencies

If the backend needs a native module, check it works under pnpm's layout before building on it.
node-pty's `spawn-helper` loses its executable bit during extraction, which is why
`scripts/fix-pty-permissions.mjs` runs on postinstall.
