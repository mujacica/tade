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
| `packages/extensions/intake/` | the local door (the spool, the `cli` watch) and the `github` watch beside it |
| `packages/forges/core/src/tickets.ts` | the things people *file*: `Ticket`, `Labelling`, `TicketQuery`, `capabilities.tickets` |
| `packages/status/src/forges.ts` | `forgeAt`/`remoteAt`: which forge serves a checkout and as whom, for anybody |
| `packages/workbench/src/intake.ts` | the doors: `takeIntake`, `intakeStands`, `sayBackAbout`, `intakeGrant` |
| `packages/workbench/src/workbench.ts` | `watchFound` branches on `finding.intake` and writes down only what settled |
| `packages/app/src/wire/queue.ts` | `intakeHold`: the grant, the plan and the source, asked again at the moment of starting |
| `packages/core/src/intake-inbox.ts` | the inbox: `INBOX_STATES`, `inboxOf`, `inboxStateOf`, `whyNotAct`, `inboxProvenance`, `MATERIAL_LABEL` |
| `packages/workbench/src/intake-acts.ts` | the local acts: `inboxFrom`, `openIntakeRow`, `approveIntake`, `refuseIntake`, `retryIntake`, `intakeWouldRun` |
| `packages/app/src/intake-view.ts` · `view/intake.ts` · `panels/intake/` · `wire/intake.ts` | what INTAKE shows, the section, the page one row opens, and the subject that carries an act out |
| `packages/orchestrator/src/tools-templates.ts` | `intakeTools`: two tools, both read-only |
| `packages/cli/src/commands/intake.ts` | `tade intake add`, `list`, `grant`, `status`, `inbox`, `show`, `approve`, `refuse`, `retry` |

## The steps

1. **Add the name to `INTAKE_SOURCES`, in the commit that implements it.** A name nothing
   implements is a grant nobody can honour, so the list is the list of sources that exist — not a
   list of sources somebody might write. The zod enum, the config's `sources` strict object and
   the comparator table in `REVISIONS` all grow together, and tsc names every one you missed.
2. **Give it a `sources.<name>` grant** in `IntakeSurface`, reusing `IntakeGrant`. Default `false`
   for both switches, `[]` for both lists, `propose` for the mode. `accept` and `reply` are two
   acts: accepting work reads somebody's words, replying posts into somebody else's system. Reuse
   the grant whole rather than adding keys: `template` and `document` are what a source's work is
   stamped from and which of that template's document inputs the body goes in, and both are the
   owner's to say because a caller-chosen template is the hole that makes one dangerous.
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
7. **Write its steps into `INTAKE_SETUP`**, one entry per source, keyed so tsc names the one
   somebody forgot. A connector whose grant a person cannot work out how to write is a connector
   nobody turns on, and `tade intake status` prints the steps for a source whose grant is not
   finished (`intakeUnfinished`).

## A source that reaches off this machine

`github` is the first, and five things about it are the pattern rather than its own:

- **Ask through the forge the project already has.** `forgeAt` (`@tade/status`) answers which forge
  serves a checkout and as whom, out of the remote and nothing else — no sign-in is tried in turn,
  no active login is read and none is changed. A source needing a *new* kind of answer from a forge
  adds a **declared optional capability** with a conformance section (`capabilities.tickets`), never
  a second HTTP client and never a port of its own.
- **There is no credential of intake's own.** The forge finds one (`gh auth token`, `$GITHUB_TOKEN`),
  so there is no second place to paste a token and nothing here to leak. Readiness stays the
  extension's: the local door always works, so a missing GitHub token must never report the whole
  extension as not ready.
- **What selects work is said, not defaulted.** The label is a **required input**, which is also what
  makes "no live connector activation" a shape rather than a promise: a watch that has to be told
  something cannot be turned on by a wizard or by a person pressing enter (`WatchOffered.needs`,
  `watchesToOffer`, and `inputProblem` at the one door that writes a schedule). And there is **no
  repository input** — the repository is the checkout's own, so there is nothing to point elsewhere.
- **The act that asked is what identifies the requester.** On GitHub that is *applying the label*,
  read from the issue's events, where `actor` is documented as "The person who generated the event" —
  so `from` is the logins whose **labelling** counts. A current label is not authority and the author
  is never a stand-in for the labeller: those are different people in the ordinary case, and reading
  one as the other authorises the wrong one. A label nobody can be named for selects nothing.
- **A poll costs one conditional request.** The validator (`etag`) rides in the one thing Tade keeps
  for a watch — its `since` — and an unchanged list is `unchanged` rather than an empty repository,
  which is the answer that would otherwise make every look after the first forget what it found.

- **A `recheck` that was not told what to check holds.** It may only ever hold, so the plainest
  case of that is the one to get right: asked without the label it selects on, it can verify less
  than the selector did and says so rather than checking the rest and answering yes. The same rule
  names an issue the list answered about and the detail could not — which is what a repository this
  sign-in has lost access to looks like, and must never read as "nothing is there".

**The loop is bounded by there being no way back.** The GitHub watch implements no `reply`, so Tade
cannot write a word into GitHub and nothing it reads there can be something it wrote. The bot filter
by actor is the second line, not the first, and what is left is why `propose` is the default forever:
an agent runs as you and could label an issue itself, and then somebody is looking at a proposal.

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
- **A template's inputs are filled by what each one *is*, never by a mapping a caller supplies.**
  The project input gets the project, the said input gets Tade's sentence, the suffix gets the
  external id, and the body gets the only document input — or the only *required* one, or the one
  the grant's `document` names. Several documents and no required one is a choice nobody made:
  refused with the candidates named, never guessed at by declaration order. An input intake cannot
  fill is left out when it is optional and **refuses** when it is required, which is `fillTemplate`'s
  own rule rather than a second one.
- **Attachments are references.** A name, a claimed media type, a claimed size, a url. Tade writing
  a stranger's file into a task folder is a path-containment and a media-parsing problem nobody
  needs; fetching one is a tool a person allowed, which is a decision that already exists. And a
  source whose attachments are only *links in the body* — a GitHub issue — lists **none**: lifting
  them out would put a stranger's filename into a line Tade writes in its own voice, and they are
  already in the body where they read as theirs.

## The inbox, and what a surface may do with one

- **Seven states, not the journal's three.** `IntakeItem.state` is what the *rule* decided; what
  somebody needs to know is who is being waited on, which is the task's answer. `inboxStateOf`
  folds the two: `noticed` is Tade, `proposed` is you, `accepted` is the queue, `started` is an
  agent, and `held`/`refused`/`failure` are the three ways it stops. Collapsing them is what made
  the first drawing unreadable — one word stood for a parked proposal, a queued task, a running
  agent and a delivery that had failed twice.
- **One rule says what may be done to a row, and three readers read it.** `whyNotAct` is the
  sentence the window greys a button with, the sentence the CLI prints, and the sentence the door
  throws. A button that offers what the door refuses is how a surface comes to lie.
- **The request is not in any inbox type.** `InboxRow` has the source's reference and the hash and
  no field a body could go in; reading one is `openIntakeRow`, a separate ask whose answer carries
  `OUTSIDE_IS_MATERIAL` with it. That is the same enforcement-by-absence as `IntakeSaid`, and it is
  why the orchestrator's two tools cannot leak a stranger's words: they are built from a row.
- **Provenance and material are two answers, never one.** A drawing that merged them would be one
  layout change from presenting a stranger's sentences as Tade's. The region gets `MATERIAL_LABEL`;
  the whole wording is *inside* what it draws, in the same bytes the agent reads.
- **A person's retry is not bounded by the machine's three tries**, and it goes through the one
  delivery door with `again` on it (`takeIntake`) — which skips the retry arithmetic and nothing
  else. Only an open window can ask a source again, so the CLI says so rather than pretending.
- **Approving reads the grant again at the press**, from the *caller's* config where it has a
  fresher one than the workbench does: a setting changed while a window has been open is changed
  now. It is not a second authorisation — `intakeStands` asks the source and the grant at the
  moment of starting — it is so a press says which key rather than holding a second later.
- **The orchestrator may read and may not act.** Two tools, both read-only; no method on the
  `ToolHost` that approves, refuses, retries or changes a grant; `surfaces.intake` whole at `never`
  in `reach.ts`. Held by `packages/orchestrator/test/intake.test.ts`, which names the absent tools
  so that adding one is a test to delete rather than a line nobody notices.

## What not to build

A second scheduler · an `IntakeSource` port before a second source needs one · a second HTTP client
for a forge Tade already talks to · a listener, a webhook endpoint or a public hostname · a
caller-chosen template, grant or repository · a confidence threshold that starts work · attachment
downloading · a reply that carries an agent's prose · token export, credential sync or automatic
account switching · a remote kill switch for running agents · a `docs/` folder for any of it.

## Prompt injection is not solved, and nothing here may claim it is

The attack already exists in shipped Tade: `review.comments` hands attacker-controlled text to an
agent with a heading on it. The heading helps the way a seatbelt helps, and it is not a cage. What
bounds the damage is the four things around it — the agent works in one task's workspace,
`approvals` decides what it may do and is `never`-tier, `settingReach` means no text can change a
setting, and `jev_review` reads the diff afterwards. Intake makes `SERVER_RUNS_AS_YOU` and
`KEYS_AND_AGENTS` load-bearing in a new way, because the person whose words reach the agent is no
longer the person whose keys are in the file. That is why `propose` is the default forever, and why
`queue` is a per-source, per-project act with its own sentence.
