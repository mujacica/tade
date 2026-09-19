---
name: add-reporter
description: Change where Tade's own trouble goes — its crashes, the warnings it writes down, what it spent — or report something that is going wrong silently today. Use when adding a reporter, changing what may be sent, or wiring a new call site.
---

# Reporting Tade's own trouble

Tade can report *itself*: the window crashing, a driver it could not use, a config that would not
load, what its agents spent. It goes to a Sentry project of the person's own, so the Sentry
extension can watch Tade and hand an agent its own bug. It is off until someone sets
`telemetry.dsn`.

| Path | What |
|---|---|
| `packages/telemetry/src/port.ts` | the `Reporter` port: `trouble`, `note`, `measure`, `doing`, `flush`, `close`, and `REPORTERS` |
| `packages/telemetry/src/shape.ts` | the policy, pure: the DSN, what may be sent (`KEPT`), scrubbing, what a journal event is worth |
| `packages/telemetry/src/sentry.ts` | the one that sends: Sentry's SDK, what it is told not to do, what is scrubbed on the way out |
| `packages/telemetry/src/agents.ts` | a turn as the work of a model: `gen_ai` spans, their tools, their tokens |
| `packages/telemetry/src/none.ts` | the one that sends nothing, which is Tade unless asked |
| `packages/telemetry/src/conformance.ts` | the suite every reporter passes |
| `packages/cli/src/telemetry.ts` | the one place that opens one, feeds it the journal, and reports a crash |
| `packages/core/src/config.ts`, `settings.ts` | `telemetry.*`, and the Telemetry group in Settings — which also carries the Sentry extension's own keys, because where Tade sends its trouble and where it reads it back is one decision |

## Rules

- **Never your work.** What may be sent is an allow-list, not a deny-list: `KEPT` in `shape.ts`
  names the detail keys that are Tade's own words, counts and names. A new journal event sends no
  attributes at all until someone adds its keys on purpose. Nothing anybody typed — an intent, a
  prompt, a note, a title, a summary, an agent's words — is ever on it, and there is a test that
  says so by name.
- **Paths and credentials go before anything leaves.** `scrub` replaces the person's home with `~`
  and takes out anything credential-shaped. Call it on every string you add, not at the call site.
- **Nothing may fail because reporting did.** Every reporter swallows its own trouble: a send that
  throws, a Sentry that is down, a DSN that is nonsense. The SDK does the queueing, batching and
  back-off; a reporter that cannot even be opened answers `none` rather than stopping Tade.
- **Spans are named where the work is.** `doing(work)` answers a span that must be ended;
  `inside(work)` is what happened within it. Nothing is instrumented automatically, so a span that
  is not worth a name is not worth having. Time work that is already over with `startedAt`, which is
  how a poll is timed only when it was slow.
- **Never block.** `flush(ms)` gives up after `ms`; `close()` gets two seconds on the way out and
  no more. Nothing waits on a network to draw a frame or to quit.
- **Off is the default, and it is a working reporter.** `openReporter` answers `none` when there is
  no DSN, so call sites report without asking first whether anyone is listening.
- **One place decides.** `reporterFor` in the CLI reads the config and the environment; everything
  else is handed a `Reporter`. Nothing reads `telemetry.*` twice.
- **A switch says what it sends.** Every `telemetry.*` setting is in the Telemetry group with a
  `means` that names what goes and what never does, so somebody can decide from the panel without
  reading `shape.ts`. Add a key to the reporter and you add it there, `live: false`, because the
  reporter is imported once when Tade starts and only when there is a DSN.

## Steps

**Reporting something that is silent today.** Find where it is swallowed. If it already reaches the
journal, it is already reported — check `fromEvent` sends it as the right thing (an issue for
Tade's own trouble, a line for what happened, a number for what was spent). If it does not, either
write it to the journal (`add-event-type`) or take a `Reporter` where it happens and call
`trouble({error, where, fingerprint})`. Give trouble without a stack a `fingerprint` whose parts are
stable — no numbers, paths or names, which `shapeOf` is for.

**A new kind of attribute.** Add the key to `KEPT` and say in the test what it is and why it is not
somebody's text.

**Another reporter.** Put it in `packages/telemetry/src/<name>.ts`, register it in `REPORTERS` (in
`open.ts`), pass `reporterConformance('<name>', …)` in the package's test, and add its name to the
`telemetry.driver` enum in the config schema.

**Timing something new.** Take a `Reporter` where the work happens and name the span for what a
person would call it. For anything a model does, use `agents.ts` rather than writing `gen_ai`
attributes at the call site: the conventions are Sentry's, and they belong in one place.

Then: `pnpm check` on its own, and never a test that reaches a network — give the reporter a `sink`
and read the envelopes it would have sent.
