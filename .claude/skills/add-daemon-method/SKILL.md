---
name: add-daemon-method
description: Add or change a daemon JSON-RPC method or notification (lane control, event queries, subscriptions) and its typed client method. Use when the CLI or orchestrator needs the daemon to do something new.
---

# Adding a daemon RPC method

The daemon speaks JSON-RPC 2.0 over a Unix socket. Three files move together:

| File | Role |
|---|---|
| `packages/daemon/src/protocol.ts` | `Method` / `Notification` name constants and wire types |
| `packages/daemon/src/server.ts` | handler registration in `accept()` |
| `packages/daemon/src/client.ts` | the typed client method callers actually use |

## Steps

1. Add the name to `Method` (requests) or `Notification` (server→client pushes). Names are
   `namespace/verb`, e.g. `lane/capture`.
2. Register the handler in `Daemon.accept()`. Handlers are thin: they validate, call
   `this.registry` or `this.log`, and return plain JSON. Business logic belongs in the registry,
   the event log, or core.
3. Add the client method with real types. Binary payloads travel as base64 strings.
4. If the method starts a stream, return `{ subscription }` and record the stop function in the
   connection's `subscriptions` map. Everything in that map is cleaned up when the socket closes —
   a stream that isn't registered there leaks after a disconnect.
5. Test it in `packages/daemon/test/daemon.test.ts` against a real daemon on a tmp socket
   (`Daemon.start({ home, socket })`), not a mock. Use `until()` from `@wilco/driver-conformance`
   instead of sleeping.
6. Expose it in the CLI if users need it (see the `add-cli-command` skill) and update `README.md`.

## Rules

- The socket is user-private: directory `0700`, socket `0600`. Don't add a TCP listener.
- Every mutation that changes lane state must be persisted by the registry and appended to the
  event log, in that order.
- The daemon must stay honest about lane liveness: lanes are children of the daemon, so after a
  restart they are dead. Report them dead and keep the spec for `relaunch`, never guess.
- Don't log raw lane output as events. Output stays in the driver's scrollback and is sampled as
  byte counts, so a chatty agent can't bloat the journal.
