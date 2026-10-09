---
name: add-intake-source
description: Add or change a source of work that arrives from outside this machine — a tracker, a chat channel, the local door — or change what a grant allows, how revisions are compared, what is re-checked at the moment of starting, or what may be said back. Use when Tade should be able to take in a request from somewhere it cannot yet, and read it before changing anything about grants, approval, dedupe or replies.
---

# Adding an intake source

An intake source is **an `ExtensionWatch` with three extra things**: it says which source it is,
it can be asked whether a finding still stands, and its findings carry an envelope. Everything
else about it is the watch and queue path every other watch already uses — the look on a clock,
the keys Tade remembers, the task made as queued work, the queue starting it by rule.

**There is no `IntakeSource` port and adding one is going backwards.** A port earns its place when
two implementations must pass one suite, and a GitHub poll, a Slack socket and a Linear webhook
share nothing but the word *intake*. `ExtensionWatch` is already the port with the conformance
suite, so `intake`, `recheck` and `reply` are declared capabilities on it, honoured by absence.

| Path | What |
|---|---|
| `packages/core/src/intake.ts` | `INTAKE_SOURCES`, `Intake`, `IntakeCandidate`, `IntakeSurface`/`IntakeGrant`, `intakeDecision`, `intakeMapped`, `newerRevision`, `intakeSummary`, `intakePrompt`, `intakeContext`, `intakeInputs`, the sentences said where somebody decides |
| `packages/core/src/intake-journal.ts` | `intakeFrom`, `intakeOf`, `intakeNext`, `intakeAgain`, `intakeRepliesLeft`, `INTAKE_ATTEMPTS` |
| `packages/core/src/events.ts` | `intake_received`, `intake_refused`, `intake_accepted`, `intake_held`, `intake_replied` |
| `packages/core/src/settings-intake.ts` | the controls, with the sentence a control is tempted to leave out |
| `packages/core/src/reach.ts` | `surfaces.intake` in `NEVER`, matched as a prefix |
| `packages/core/src/limits.ts` | `planTooTight`: the subscription hold, scoped to intake-originated starts |
| `packages/extensions/core/src/watch.ts` | the watch half of the port: `Finding.intake`, `Recheck`, `ReplyRequest`, `ExtensionWatch.intake`/`recheck`/`reply` |
| `packages/extensions/core/src/shape.ts` | `intakeProblem`: what a source must have to be turned on at all |
| `packages/extensions/core/src/watching.ts` | `askLook`, `askRecheck`, `askReply`, and the deadline all three are held to |
| `packages/extensions/intake/` | the local door: the spool, and the `cli` watch that reads it |
| `packages/workbench/src/intake.ts` | the doors: `takeIntake`, `intakeStands`, `sayBackAbout`, `intakeGrant` |
| `packages/workbench/src/workbench.ts` | `watchFound` branches on `finding.intake` and writes down only what settled |
| `packages/app/src/wire/queue.ts` | `intakeHold`: the grant, the plan and the source, asked again at the moment of starting |
| `packages/cli/src/commands/intake.ts` | `tade intake add`, `list`, `grant` |

## The steps

1. **Add the name to `INTAKE_SOURCES`, in the commit that implements it.** A name nothing
   implements is a grant nobody can honour, so the list is the list of sources that exist — not a
   list of sources somebody might write. The zod enum, the config's `sources` strict object and
   the comparator table in `REVISIONS` all grow together, and tsc names every one you missed.
2. **Give it a `sources.<name>` grant** in `IntakeSurface`, reusing `IntakeGrant`. Default `false`
   for both switches, `[]` for both lists, `propose` for the mode. `accept` and `reply` are two
   acts: accepting work reads somebody's words, replying posts into somebody else's system.
3. **Write its revision comparator** in `REVISIONS`, with a test. ISO timestamps are parsed to a
   time; a Slack `ts` is compared numerically; an opaque id is **not comparable** and says so.
   Never a lexical comparison of an arbitrary id: `"10" > "9"` is `false`.
4. **Write the watch.** `check` returns `Finding`s carrying `IntakeCandidate`s — no grant field and
   no template field, because a caller-chosen grant is no grant. `agent` returns Tade's own words
   (`intakeTitle`, `intakePrompt`), never the body. `recheck` is **required** and answers by
   looking at the source. `reply` is optional and is only the transport.
5. **Run the conformance suite** (`extensionConformance`) and make sure it passes offline. It
   asserts the capability is declared both ways and that a `recheck` about something the source has
   never heard of does not answer `still: true`.
6. **Add its coverage floor** to `scripts/coverage-floors.ts` if it is a new package, and
   `git add` every new file before running the checks — staging copies only tracked files.

## What the rules are, and why each is the way it is

- **Authorisation is the owner's grant and nothing else.** Not the requester's role at the source,
  not that they could add a label, not that the source authenticated them. Authentication says the
  envelope is really from the source; identification says who asked; `intakeDecision` reads the
  grant. Merging those three is how an intake becomes a text box that runs commands as you.
- **`from: []` means nobody.** The other default — anybody — reads as a promise and is a hole. Same
  argument `watches.ts` makes about ticked-by-default.
- **`intent_spoken` is Tade's own sentence, enforced by absence.** `intakeSummary` and
  `intakePrompt` take `IntakeSaid`, which has no `verbatim`: they cannot reach the body. That is
  the guarantee; the substring assertion beside it is a sample, and samples pass the day somebody
  paraphrases. The body goes in the context file under `OUTSIDE_IS_MATERIAL` — the one wording,
  because an agent that read two different sentences about whether to obey a ticket has two
  answers.
- **Ignored is not refused.** No mapping, or the surface off, writes **nothing**: a line per
  unaddressed issue per poll fills the journal with the world, and the look's counts already say
  how much it saw. A selector that matched and a rule that said no is written down every time,
  because a refusal nobody made is what makes an attack visible — and is **never replied to**, since
  a reply tells an unauthorised person the machine is there and listening.
- **Which key is burned decides what the next look does, and it is the whole of the dedupe.** A
  refusal, an acceptance, an edit and a giving-up write `watch_found`, so the next look leaves that
  revision alone. A transient failure writes `intake_held` and **no** `watch_found`, so the next
  look finds the request again by its external id. That is the difference between an intake and a
  watch over a source that will send another one anyway: another Sentry error will happen, and
  nobody files the same ticket twice.
- **One active intake per external id.** A new revision updates or holds the one that exists. It
  never spawns a parallel workflow — which is what a key carrying only the revision would do, once
  per edit, once per comment, once per `updated_at` bump.
- **An edit invalidates the approval and never stops an agent.** What has not started is parked
  again, which puts back exactly the hold a person lifted; what is working is written down and
  said. A rule that killed agents on an outside signal is a remote kill switch.
- **Write it down before you make anything.** `intake_received` first, then the work, then
  `intake_accepted`. A window that died in between leaves a delivery that is visibly unfinished,
  and the next attempt **recognises its own work** rather than making a second copy — which is why
  every name is derived from the source's own id and `fillFor` hands the names over before
  `stampTemplate` makes anything.
- **Retries are bounded and the giving-up is loud.** Three tries, a minute apart at least, and then
  a record saying Tade stopped and why. Neither silent failure mode is allowed: not a retry every
  ten minutes for ever, and not a request that vanished with nothing written down.
- **The grant and the source are asked again at the moment of starting.** A grant is permission now,
  not permission once. A source that cannot be reached **holds** — an inaccessible source is never
  permission, and that is the one direction this must get right. The precedent is `lookAtTrees`:
  what was true when the work was planned is read again, because that is the moment it is true.
- **A subscription window that is nearly full holds an intake-originated start**, and so does one
  nobody can read: unknown is not zero. It never moves the work to another sign-in — whose money
  and whose permissions agents run with is a person's decision, and an automatic switch is that
  decision taken by a rule.
- **A reply is bounded status Tade generated**, from a fixed set of sentences, capped per request,
  never a word an agent wrote, never a diff, a log line, a file name or anything out of a private
  repository. Three gates, all in `sayBackAbout`: the grant, the cap, the sentence.
- **Acknowledgement is not acceptance, and acceptance is not execution.** `noticed`, `accepted`,
  `started` — three facts, three words, and no copy may blur them. A sleeping laptop runs nothing
  and promises nothing, so "we'll run it when you're back" is not in `INTAKE_SAYINGS` and must not
  become one.
- **Every key under `surfaces.intake` is `never`-tier**, by one dotted prefix in `reach.ts`, so a
  key added next month is refused on the day it is added. The text the orchestrator reads all day
  does not get to put itself on an allowlist.
- **Nothing takes a path.** No `path`, `file`, `dir`, `root`, `command` or `prompt` key on any
  intake route, held by a test. Enforcement by absence rather than a sanitiser.
- **Attachments are references.** A name, a claimed media type, a claimed size, a url. Tade writing
  a stranger's file into a task folder is a path-containment and a media-parsing problem nobody
  needs; fetching one is a tool a person allowed, which is a decision that already exists.

## What not to build

A second scheduler · an `IntakeSource` port before a second source needs one · a listener, a
webhook endpoint or a public hostname · a caller-chosen template or grant · a confidence threshold
that starts work · attachment downloading · a reply that carries an agent's prose · token export,
credential sync or automatic account switching · a remote kill switch for running agents · a
`docs/` folder for any of it.

## Prompt injection is not solved, and nothing here may claim it is

The attack already exists in shipped Tade: `review.comments` hands attacker-controlled text to an
agent with a heading on it. The heading helps the way a seatbelt helps, and it is not a cage. What
bounds the damage is the four things around it — the agent works in one task's workspace,
`approvals` decides what it may do and is `never`-tier, `settingReach` means no text can change a
setting, and `jev_review` reads the diff afterwards. Intake makes `SERVER_RUNS_AS_YOU` and
`KEYS_AND_AGENTS` load-bearing in a new way, because the person whose words reach the agent is no
longer the person whose keys are in the file. That is why `propose` is the default forever, and why
`queue` is a per-source, per-project act with its own sentence.
