---
name: add-reporter
description: Change where Wilco's own trouble goes — its crashes, the warnings it writes down, what it spent — or report something that is going wrong silently today. Use when adding a reporter, changing what may be sent, or wiring a new call site.
---

# Reporting Wilco's own trouble

Wilco can report *itself*: the window crashing, a driver it could not use, a config that would not
load, what its agents spent. It goes to a Sentry project of the person's own, so the Sentry
extension can watch Wilco and hand an agent its own bug. It is off until someone sets
`telemetry.dsn`.

| Path | What |
|---|---|
| `packages/telemetry/src/port.ts` | the `Reporter` port: `trouble`, `note`, `measure`, `flush`, `close`, and `REPORTERS` |
| `packages/telemetry/src/shape.ts` | everything pure: the DSN, what may be sent (`KEPT`), scrubbing, stacks, envelopes, what a journal event is worth |
| `packages/telemetry/src/sentry.ts` | the one that sends: queues, batches, backs off, gives up |
| `packages/telemetry/src/none.ts` | the one that sends nothing, which is Wilco unless asked |
| `packages/telemetry/src/conformance.ts` | the suite every reporter passes |
| `packages/cli/src/telemetry.ts` | the one place that opens one, feeds it the journal, and reports a crash |
| `packages/core/src/config.ts`, `settings.ts` | `telemetry.*`, and the Reporting group in Settings |

## Rules

- **Never your work.** What may be sent is an allow-list, not a deny-list: `KEPT` in `shape.ts`
  names the detail keys that are Wilco's own words, counts and names. A new journal event sends no
  attributes at all until someone adds its keys on purpose. Nothing anybody typed — an intent, a
  prompt, a note, a title, a summary, an agent's words — is ever on it, and there is a test that
  says so by name.
- **Paths and credentials go before anything leaves.** `scrub` replaces the person's home with `~`
  and takes out anything credential-shaped. Call it on every string you add, not at the call site.
- **Nothing may fail because reporting did.** Every reporter swallows its own trouble: a send that
  throws, a Sentry that is down, a DSN that is nonsense. Queues are bounded and drop the oldest;
  a 429 is waited out; the same trouble twice in a minute is sent once, so a crash loop is one issue.
- **Never block.** `flush(ms)` gives up after `ms`; `close()` gets two seconds on the way out and
  no more. Nothing waits on a network to draw a frame or to quit.
- **Off is the default, and it is a working reporter.** `openReporter` answers `none` when there is
  no DSN, so call sites report without asking first whether anyone is listening.
- **One place decides.** `reporterFor` in the CLI reads the config and the environment; everything
  else is handed a `Reporter`. Nothing reads `telemetry.*` twice.

## Steps

**Reporting something that is silent today.** Find where it is swallowed. If it already reaches the
journal, it is already reported — check `fromEvent` sends it as the right thing (an issue for
Wilco's own trouble, a line for what happened, a number for what was spent). If it does not, either
write it to the journal (`add-event-type`) or take a `Reporter` where it happens and call
`trouble({error, where, fingerprint})`. Give trouble without a stack a `fingerprint` whose parts are
stable — no numbers, paths or names, which `shapeOf` is for.

**A new kind of attribute.** Add the key to `KEPT` and say in the test what it is and why it is not
somebody's text.

**Another reporter.** Put it in `packages/telemetry/src/<name>.ts`, register it in `REPORTERS` (in
`open.ts`), pass `reporterConformance('<name>', …)` in the package's test, and add its name to the
`telemetry.driver` enum in the config schema.

Then: `pnpm check` on its own, and never a test that reaches a network — pass `fetch` in and read
what would have gone on the wire.
