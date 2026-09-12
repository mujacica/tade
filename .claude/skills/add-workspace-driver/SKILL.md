---
name: add-workspace-driver
description: Add a new WorkspaceDriver (tmux, ghostty, kitty, wezterm, zellij, container) or change the driver port. Use when lanes should live somewhere other than the daemon's own PTYs.
---

# Adding a WorkspaceDriver

A driver decides **where a process physically lives**. It does not decide where you look at it.
The port is `packages/core/src/ports/workspace.ts`; the reference implementation is
`packages/driver-pty`.

## The job is: import the suite, run it, fix what's red

1. `pnpm --filter @wilco/driver-<name> add @wilco/core` (plus whatever the backend needs) and
   `-D @wilco/driver-conformance vitest`.
2. `packages/driver-<name>/test/conformance.test.ts`:
   ```ts
   import { testWorkspaceDriver } from '@wilco/driver-conformance'
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

## Native dependencies

If the backend needs a native module, check it works under pnpm's layout before building on it.
node-pty's `spawn-helper` loses its executable bit during extraction, which is why
`scripts/fix-pty-permissions.mjs` runs on postinstall.
