---
name: add-reporter
description: Change where Tade's own trouble goes — its crashes, the warnings it writes down, what it spent — or report something that is going wrong silently today. Use when adding a reporter, changing what may be sent or measured, timing a model's turn, or wiring a new call site.
---

# Reporting Tade's own trouble

Tade can report *itself*: the window crashing, a driver it could not use, a config that would not
load, what its agents spent. It goes to a Sentry project of the person's own, so the Sentry
extension can watch Tade and hand an agent its own bug. It is off until someone sets
`telemetry.dsn`.

| Path | What |
|---|---|
| `packages/telemetry/src/port.ts` | the `Reporter` port: `trouble`, `note`, `measure`, `doing`, `flush`, `close`, and `REPORTERS` |
| `packages/telemetry/src/shape.ts` | the policy, pure: the DSN (`readDsn`), what may be sent (`KEPT`), what may be a dimension (`DIMENSIONS`), `scrub`, `shapeOf`, `about`, and what a journal event is worth (`fromEvent`) |
| `packages/telemetry/src/open.ts` | `openReporter`, the `REPORTERS` registrations, `saw` (a journal event reported), `watchProcess` |
| `packages/telemetry/src/sentry.ts` | the one that sends: Sentry's SDK, what it is told not to do, what is scrubbed on the way out |
| `packages/telemetry/src/agents.ts` | a turn as the work of a model: `agentTurns`, `gen_ai` spans, their tools, their tokens |
| `packages/telemetry/src/none.ts` | the one that sends nothing, which is Tade unless asked |
| `packages/telemetry/src/conformance.ts` | the suite every reporter passes |
| `packages/telemetry/test/leak.test.ts` | the proof that a leak cannot happen, rather than a sample of ones that do not |
| `packages/cli/src/telemetry.ts` | the one place that opens one, feeds it the journal, and reports a crash |
| `packages/cli/src/commands/app.ts` | where `watchProcess` is wired to the window |
| `packages/workbench/src/workers.ts` | where a turn is seen, and so where it is timed |
| `packages/core/src/config.ts`, `settings.ts` | `telemetry.*`, and the Telemetry group in Settings — which also carries the Sentry extension's own keys, because where Tade sends its trouble and where it reads it back is one decision |

## Rules

- **Never your work.** What may be sent is an allow-list, not a deny-list: `KEPT` in `shape.ts`
  names the detail keys that are Tade's own words, counts and names. A new journal event sends no
  attributes at all until someone adds its keys on purpose. Nothing anybody typed — an intent, a
  prompt, a note, a title, a summary, an agent's words — is ever on it, and there is a test that
  says so by name.
  `leak.test.ts` is that test, and it is a sweep rather than a sample: every event type there is,
  crossed with every key anybody writes somebody's words under, through `fromEvent` and then through
  the real reporter with the wire replaced by a list. A key added to the journal tomorrow is answered
  tomorrow, because `KEPT` is a denial with exceptions and this is the test of it. Paths are scrubbed
  to `~`, anything credential-shaped is taken out, and the lines around a stack frame are kept only
  for Tade's own files.
- **Paths and credentials go before anything leaves.** `scrub` replaces the person's home with `~`
  and takes out anything credential-shaped. Call it on every string you add, not at the call site.
- **A dimension is an enum, and `DIMENSIONS` is narrower than `KEPT` on purpose.** A metric is split
  by project; a task id is a slug made from a title somebody wrote — unbounded as a series, and not
  Tade's to send. Anything that can be a sentence — `because`, `reason`, `message` — is never a
  dimension either, and this half is **cardinality rather than privacy**: it would make a new series
  every time somebody worded something differently. What was actually said still goes on the log line
  beside it, where one more wording costs nothing. So a key being in `KEPT` is not a reason to put it
  in `DIMENSIONS`, and the two lists being different lengths is the design.
- **Nothing may fail because reporting did.** Every reporter swallows its own trouble: a send that
  throws, a Sentry that is down, a DSN that is nonsense. The SDK does the queueing, batching and
  back-off; a reporter that cannot even be opened answers `none` rather than stopping Tade.
- **Watching for trouble never decides what it costs.** `watchProcess` (`open.ts`) answers Node's two
  handovers differently, and only one of them is fatal. An uncaught exception still ends Tade, with
  the terminal handed back before the exit, because a crash that left it in raw mode is a crash you
  cannot read. **A promise nobody awaited is reported and nothing else.**
  Registering that listener is itself what turns Node's default off, so a `throw` in it is not Node's
  answer being passed along — it is the reporter *inventing* one. It did: a dynamic `import()` in
  code compiled while Tade ran — in neither Tade's own code nor the terminal library it draws with,
  neither of which contains one — rejected on a Node with no callback for it, and took the window
  down. Under the `pty` driver the lanes are the window's own children, so that was every agent in
  the checkout, killed by somebody else's import. Nothing the drawing could have caught, either:
  `import()` rejects, it never throws, so the frame was already drawn. Anything added to
  `watchProcess` inherits this: a handler that makes an outcome worse than Node's own default is a
  bug in the reporter, not a report.
- **Somebody else's process going is Tade's own trouble, and its output is not.** A brokered MCP
  server that died, would not start or stopped answering reaches the journal as a `warning` through
  the broker's `onWarning` and so reaches Sentry — Tade's own words, the server's name and why. What
  the server itself printed is never in it: that is `McpError.said`, and it stays on the Extensions
  page. The same split applies to anything else Tade starts that is not Tade.
- **Spans are named where the work is.** `doing(work)` answers a span that must be ended;
  `inside(work)` is what happened within it. Nothing is instrumented automatically, so a span that
  is not worth a name is not worth having. Time work that is already over with `startedAt`, which is
  how a poll is timed only when it was slow.
- **An agent's turn is the work of a model, and is timed as one.** The supervisor sees a turn start,
  the tools it calls and what it cost, so that is where it is timed (`agentTurns`, used by
  `workbench/src/workers.ts`): a `gen_ai.invoke_agent` span per turn with `gen_ai.execute_tool` spans
  inside it, the model and the tokens on it. **Never from the journal**, which knows when a turn ended
  but not when the agent was waiting to be asked. Sampling is the reporter's one decision: turns are
  always kept, Tade's own work is kept at `telemetry.traces`.
- **Never block.** `flush(ms)` gives up after `ms`; `close()` gets two seconds on the way out and
  no more. Nothing waits on a network to draw a frame or to quit.
- **Off is the default, and it is a working reporter.** `openReporter` answers `none` when there is
  no DSN, so call sites report without asking first whether anyone is listening.
- **One place decides.** `reporterFor` in the CLI reads the config and the environment; everything
  else is handed a `Reporter`. Nothing reads `telemetry.*` twice.
- **Sentry's SDK, and nothing automatic.** The extension reads Sentry with plain requests; reporting
  uses `@sentry/node`, because what is wanted is a tracer and the parts nobody should write twice. It
  is imported **only when there is a DSN**, with `defaultIntegrations: false` and
  `registerEsmLoaderHooks: false`: Tade names its own work where it happens, and a window must never
  have its terminal written over by somebody else's deprecation warning. Turning an integration on to
  get something for free is how automatic instrumentation gets in, and an unnamed span is not worth
  having anyway.
- **A DSN is an endpoint, not a credential.** `telemetry.dsn` is an ordinary string in `config.yaml`,
  drawn as itself — Sentry publishes a DSN in the JavaScript of every page it watches, and all one
  grants is the right to send events to one project. Marked `secret` it got bullets in the field, so
  seventy characters somebody pasted could not be read back and checked for a typo.
  `$TADE_TELEMETRY_DSN` is the fallback *under* the setting and never over it. What is genuinely a
  credential — Sentry's auth token, the forge token, an extension's key — is `kind: 'secret'`; see
  the `add-config-key` skill.
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
somebody's text. If it should also split a metric, that is a second decision: add it to `DIMENSIONS`
only if its values are a closed set, and never because it was already in `KEPT`.

**Another reporter.** Put it in `packages/telemetry/src/<name>.ts`, register it in `REPORTERS` (in
`open.ts`), pass `reporterConformance('<name>', …)` in the package's test, and add its name to the
`telemetry.driver` enum in the config schema.

**Timing something new.** Take a `Reporter` where the work happens and name the span for what a
person would call it. For anything a model does, use `agents.ts` rather than writing `gen_ai`
attributes at the call site: the conventions are Sentry's, and they belong in one place.

**Changing what happens when Node hands something over.** Change `watchProcess` and nowhere else, and
decide the two handovers separately — an uncaught exception ends Tade after the terminal is restored,
an unhandled rejection is reported and nothing more. A new handler must never be able to end the
process where Node's own default would not have.

Then: `pnpm check` on its own, and never a test that reaches a network — give the reporter a `sink`
and read the envelopes it would have sent.
