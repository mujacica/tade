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
| `packages/core/src/intake-journal.ts` | `intakeFrom`, `IntakeReply`, `intakeOf`, `intakeNext`, `intakeAgain`, `INTAKE_ATTEMPTS` |
| `packages/core/src/intake-outbox.ts` | what may be said back and which status is due: `INTAKE_SAYINGS`, `intakeSays`/`IntakeSayFacts`, `intakeMark`, `IntakeReceipt`, `sayingFor`, `outboxFor`/`outboxOf`, the two bounds and the cap |
| `packages/core/src/events.ts` | `intake_received`, `intake_refused`, `intake_accepted`, `intake_held`, `intake_replied` |
| `packages/core/src/settings-intake.ts` | the controls, with the sentence a control is tempted to leave out |
| `packages/core/src/reach.ts` | `surfaces.intake` in `NEVER`, matched as a prefix; `template` and `document` carved out in `ALLOWED_UNDER` |
| `packages/core/src/limits.ts` | `planTooTight`: the subscription hold, scoped to intake-originated starts — one let through at a time while a plan is unknown |
| `packages/extensions/core/src/watch.ts` | the watch half of the port: `Finding.intake`, `Recheck`, `ReplyRequest`, `ReplyReceipt`, `ExtensionWatch.intake`/`recheck`/`reply` |
| `packages/extensions/core/src/shape.ts` | `intakeProblem`: what a source must have to be turned on at all |
| `packages/extensions/core/src/watching.ts` | `askLook`, `askRecheck`, `askReply`, and the deadline all three are held to |
| `packages/extensions/intake/` | the local door (the spool, the `cli` watch) and the `github` watch beside it |
| `packages/core/src/hooks.ts` | the doorbell: `HOOK_SOURCES`, `HOOK_SECRETS`, `HookAddress`, `WatchDoorbell`/`doorbellRings`, the `hook_rung` line (`HookRung`, `rungFrom`), and the hourly poll (`Bell`, `bellStands`, `bellWhen`, `bellDue`, `bellSaid`) |
| `packages/web/src/hooks.ts` · `hooked.ts` | each source's signature over the raw body and its window, the address (`checkDelivery`); the door's order — rate, cap, signature, ring, `200`, wake (`HookDoor`) |
| `packages/app/src/wire/doorbell.ts` | the window's half: the secret, which schedules a delivery is for (`doorbellFor`), waking them (`Schedules.wake`) |
| `packages/core/src/connect.ts` · `forge-apps.ts` | connecting a source step by step: `CONNECT_SOURCES`, `CONNECT_FLOWS` (each source's presses and callbacks, and whether it installs with a proof key), `githubPage`, `slackPage` and `linearPage` (folds over `GithubLook`, `SlackLook`, `LinearLook`), `CONNECT_IS_HERE`; where a GitHub App's keys are kept (`GITHUB_APP`, `appsKept`) |
| `packages/web/src/connected.ts` · `connect-page.ts` · `packages/app/src/wire/web-connect.ts` | the pages, the presses (`keep` and `KEEP_SCHEMAS` for what a source's own page shows the person) and the one-time words with their PKCE verifiers (`mintInstall`); their HTML; the window's half, which asks the forge or the source's door and keeps what comes back through `writeKey` |
| `packages/extensions/intake/src/linear-app.ts` · `packages/app/src/wire/linear-tokens.ts` | the app Connect Linear makes (`LINEAR_APP`, the manifest, `linearAuthorizeUrl`, `linearInstalled`, `linearRefreshed`, `linearWho`); the window holding its tokens (`LinearTokens`), lent to every extension as `ctx.connected` (`useConnected`) |
| `packages/extensions/intake/src/slack*.ts` | the Slack door: the methods it needs (`slack-api.ts`, `oauth.v2.access` among them), the pure half that reads a message as an envelope (`slack-message.ts`), the watch, and the app Connect Slack makes (`slack-app.ts`: `SLACK_APP`, the manifest, `slackInstallUrl`, `slackInstalled`) |
| `test/fixtures/slack/` | a Slack that answers from a file: `auth.test`, cursors, `has_more`, a 429 with a `Retry-After`, an edit, a deletion, metadata, a reaction already there |
| `packages/forges/core/src/tickets.ts` | the things people *file*: `Ticket`, `Labelling`, `TicketQuery`, `capabilities.tickets` |
| `packages/status/src/forges.ts` | `forgeAt`/`remoteAt`: which forge serves a checkout and as whom, for anybody |
| `packages/workbench/src/intake.ts` | the doors: `takeIntake`, `intakeStands`, `sayBackAbout`, `intakeGrant` |
| `packages/workbench/src/workbench.ts` | `watchFound` branches on `finding.intake` and writes down only what settled |
| `packages/app/src/wire/queue-holds.ts` | `intakeSays`: the grant, the plan and the source, asked again at the moment of starting — which the queue can only do because `QUEUE_READS` carries `INTAKE_EVENTS` |
| `packages/app/src/wire/intake-reply.ts` | `sayDue`: the one thing that posts, drained from the inbox's own fold |
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
   for all three switches, `[]` for both lists, `propose` for the mode. `accept`, `reply` and
   `names` are three acts: accepting work reads somebody's words, replying posts into somebody
   else's system, and naming puts this machine's and this work's names in a stranger's tracker.
   Reuse the grant whole rather than adding keys: `template` and `document` are what a source's work
   is stamped from and which of that template's document inputs the body goes in, and both are the
   owner's to say because a caller-chosen template is the hole that makes one dangerous.
3. **Write its revision comparator** in `REVISIONS`, with a test. ISO timestamps are parsed to a
   time; a Slack `ts` is compared numerically; an opaque id is **not comparable** and says so.
   Never a lexical comparison of an arbitrary id: `"10" > "9"` is `false`.
4. **Write the watch.** `check` returns `Finding`s carrying `IntakeCandidate`s — no grant field and
   no template field, because a caller-chosen grant is no grant. `agent` returns Tade's own words
   (`intakeTitle`, `intakePrompt`), never the body. `recheck` is **required** and answers by
   looking at the source. `reply` is optional and is only the transport.
5. **Run the conformance suite** (`extensionConformance`) and make sure it passes offline. It
   asserts the capability is declared both ways, that a `recheck` about something the source has
   never heard of does not answer `still: true`, and — where it replies — that one `mark` posts one
   status and the second answer says `already`, and that a write it cannot do leaves the look
   working.
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
  so there is no second place to paste a token and nothing here to leak — and where the person
  connected a GitHub App, the forge reads a repository it is installed on as that App
  (`ctx.apps`, `forgeAt`'s `apps`, `change-the-reviews`): the App's keys sit in this extension's
  block because connecting GitHub is one act, and every forge reads them through the host, not
  through intake. Readiness stays the extension's: the local door always works, so a missing
  GitHub token must never report the whole extension as not ready.
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
- **A subscription window that is nearly full holds an intake-originated start**, and one nobody
  can read lets **one** through at a time, to make it known, and says that is why it went — unknown
  is not zero, and holding every one was a restarted always-on box that never started anything
  (`planTooTight`). It is the window of the sign-in that start would run as (`spends`), never
  another's: read across every sign-in, a Codex nobody ran kept a Claude Code box one at a time. A harness that can be asked first is asked first. It never moves the work to
  another sign-in — whose money and whose permissions agents run with is a person's decision, and
  an automatic switch is that decision taken by a rule.
- **A reply is bounded status Tade generated**, from a fixed set of sentences, never a word an agent
  wrote, never a diff, a log line, a file name, a link or anything out of a private repository. Four
  gates, all in `sayBackAbout`: the grant, what the grant lets a sentence *name*, the bounds, and the
  sentence itself. The whole of it is below.
- **Acknowledgement is not acceptance, and acceptance is not execution.** `noticed`, `accepted`,
  `started` — three facts, three words, and no copy may blur them. A sleeping laptop runs nothing
  and promises nothing, so "we'll run it when you're back" is not in `INTAKE_SAYINGS` and must not
  become one.
- **Every key under `surfaces.intake` is `never`-tier but two**, by one dotted prefix in
  `reach.ts`, so a key added next month is refused on the day it is added. The text the
  orchestrator reads all day does not get to put itself on an allowlist. The two are a source's
  `template` and `document`, named in `ALLOWED_UNDER` and `asked`: the owner choosing among what
  the owner published, which says nothing about whose words count, where, whether anybody
  approves, or what goes back. A key you add to `IntakeGrant` is `never` until somebody argues
  otherwise there.
- **Settings shows one source at a time** (`SettingGroup.scoped`, the selector the Projects page
  has): a row carries its source as `scope` and a title that names the setting, never the source,
  and a source you add gets its tab from `INTAKE_SOURCE_TITLES`, which tsc holds complete.
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

## Saying a status back, which is the other direction and a separate act

`reply` is optional, and the local door is the only transport Tade ships one for: GitHub
deliberately has none, so nothing Tade reads there can be something it wrote.

- **The outbox is a fold, not a queue.** `intake_replied` lines say which statuses have gone and
  which try failed (`IntakeItem.said`); the task files say where the work stands; `outboxFor` is the
  arithmetic between them. There is no table of pending posts to get out of step, and dedupe
  survives a restart, a deleted index and a journal copied to another machine — which is the whole
  reason it is derived rather than remembered.
- **Three acts, not one.** `accept` reads somebody's words; `reply` posts into somebody else's
  system; `names` lets a sentence carry the task and the machine. Each is off by default and none
  implies another. The third one exists because **public issue metadata is itself disclosure**: a
  task name is a repository plus a piece of somebody's work, a hostname is their laptop, neither is
  a secret and a public issue is read by whoever finds it (`METADATA_IS_DISCLOSURE`). With `names`
  off the task and the machine are **not in the argument** `intakeSays` takes — the same
  enforcement-by-absence as `IntakeSaid`.
- **One status per saying, ever, and never one said late.** `alreadySaid` reads *later-or-equal*, so
  a request that was queued, started and finished while the window was shut gets `finished` and
  nothing else. A window that caught up out loud would be a machine talking about itself.
- **Three bounds, each for a different failure**: one per saying (the dedupe), `INTAKE_REPLY_ATTEMPTS`
  per saying with a minute between tries (a source that is down is not hammered), and
  `INTAKE_REPLY_CAP` posts per request per day — which is **as high as the number of sayings**, so it
  can never be what stops an honest status. It was lower than that once, and the status it silently
  dropped was `finished`: a status the cap refuses never gets an attempt, so it does not even show in
  the inbox. A bound that binds before the rule does is a second rule nobody wrote down. Past the
  attempts it stops, and the giving-up is **visible in the inbox** rather than silent.
- **A status is never a hold.** A reply that fails is written down (`state: 'unsent'`), said once in
  the window, and shows in the inbox as `could not say`; the work carries on being built. A request
  that was granted gets made whether or not anybody could be told, and nothing a source does to a
  reply may stop an agent.
- **A line comes after the thing, so reconciling is the transport's.** There is no "about to post"
  record — the journal's own rule — so a window that died between the post and the append leaves no
  line, the status reads as due again, and `ReplyRequest.mark` is what keeps the next try from
  posting twice: derived from the item and the saying, the same marker every time, and a transport
  that recognises its own answers `already`. The conformance suite asserts exactly that, and
  asserts that a write it cannot do is an ordinary error that leaves the look working.
- **Tade's own words are never news to Tade.** Posting a comment moves `updated_at`, and a moved
  revision is how an edit is noticed — so a status going out would otherwise read on the next look as
  somebody having rewritten the request and would put back an approval a person had just given.
  `ReplyReceipt.revision` is written down with the reply and `intakeAgain` knows its own, with the
  **hash as the independent check**: the same revision with different text behind it is somebody's
  edit and is still read as one. A source whose revisions move when something is posted to it owes
  that answer (`REPLIES_MOVE_REVISIONS`).
- **One place posts, and it is the window's.** `sayDue` runs in the inbox's own fold — the moment a
  status becomes true is the moment the rows were refolded — so there is no second clock and no
  second path. The local surfaces show the policy and what was said; **none of them activates it**,
  and there is no act on a row for a reply.
- **A reply can carry a status and nothing else.** `ReplyRequest` has `key`, `say` and `mark`, and
  `reply` is the only method — no label, assignee, state, channel, recipient or reaction — so there
  is no route by which Tade closes, assigns, labels, merges or deletes anything at a source, and
  none by which it messages anywhere a finding did not come from. Held by a test over what a watch
  is actually handed.

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
  `ToolHost` that approves, refuses, retries or changes a grant; `surfaces.intake` at `never` in
  `reach.ts` but for which template and which document, which take the person's own words. Held by `packages/orchestrator/test/intake.test.ts`, which names the absent tools
  so that adding one is a test to delete rather than a line nobody notices.

## A chat source, and a source you can say something back to

`slack` is the second one off this machine and the first with a way back. Seven things
about it are the pattern rather than its own (and an eighth, what a delivery names that a poll
cannot see, is under the doorbell below):

- **The generous tier is not the tier your app gets, and the number to write the bounds against
  is the small one.** Slack's `conversations.history` and `conversations.replies` are Tier 3 —
  50+ a minute, `limit` up to 1,000 — for an **internal customer-built** app and a
  Marketplace-approved one, and **1 request a minute with `limit` clamped to 15** for anything
  distributed outside the Marketplace since 29 May 2025, existing installations from
  3 March 2026. A connector written against the headline number works on the author's laptop
  and 429s on everybody else's, so the ceilings are written for the clamped case and
  `INTAKE_SETUP` says *which kind of app to make* rather than leaving somebody to find out
  from a 429.
- **A poll sees what the list endpoint returns and nothing else, and that is a limit to say
  rather than work around.** `conversations.history` does not return thread replies, so a
  plain `@tade` inside a thread is invisible to any amount of care in the selector, and
  reading every thread to find one is a request per thread per look. What *is* visible —
  a reply somebody also sent to the channel — is taken in with its whole thread, and the rest
  is what a delivery to a public name names (below), said in the setup. **Never describe a polled source as chat**:
  it notices a message, it does not answer one, and there is no three-second clock anywhere in
  it.
- **A revision is the request's own version, never the conversation's.** GitHub's `updated_at`
  moves for a comment, which is why a proposal there is re-parked by a "thanks" and why
  `REVISIONS` records that as the direction it is allowed to be wrong in. A source that
  numbers every message separately can do better and must: `edited.ts ?? ts` is the ask's own
  version, so an edit holds the work at the start door and a comment does not — and **that
  same choice is what makes writing into the thread safe**, because a reply moves the thread
  and not the ask.
- **A reply needs one piece of state the source itself remembers, and `mark` alone is not
  it.** The marker is Tade's and a transport has to be able to *recognise* it, so a source
  with no dedupe key of its own needs somewhere to put one. On Slack that is two acts in one
  order: `reactions.add` answers `already_reacted` per app, per emoji, per message, so the
  reaction is the **claim** and is taken first; `chat.postMessage` carries the marker in
  `metadata`, which Slack shows nobody and returns only to a read that asked for it. A window
  that died between the two comes back, finds the claim made, reads the thread once, and
  finishes the half that did not happen — which is why the extra read is on the retry path
  only. **One emoji per saying**, or two statuses share an idempotency slot and the second is
  silently "already said".
- **Where what Tade posts can be read back as material, leaving its own words out is by
  identity and never by text.** `auth.test` costs no scope and allows hundreds a minute, so
  the app's own user id and `bot_id` are free to know — and they are also the mention the
  watch triggers on. Matching Tade's own sentences instead would be defeated the first time
  somebody quoted a status back.
- **A cursor may never move past something the look deferred.** A bounded look leaves requests
  behind — past its ceiling, or with a thread it could not finish — and a `since` past one of
  those is a request that vanished with nothing written down. The cursor stops below the oldest
  deferred one (`advanceTo`), and a sweep that did not reach the bottom of its own window does
  not move at all: re-reading what it already has costs one request and no agent, because Tade
  knows which keys it has seen. **A half-read request is not handed over at all** — the thread
  is the material somebody approves.
- **A rate limit ends a sweep and is never slept through.** A look has the window's deadline,
  a throttled app's `Retry-After` is about as long, so a look that waited would be a look that
  was given up on. A 429 on the **first** request is a look that could not look and throws,
  with the tier in the sentence; one partway through keeps what it read, leaves the cursor
  alone and says so.

**An allowlist is of ids, not of names.** A display name is its owner's to change and a
workspace may hold two people with the same one, while `from` decides whose words run as you
with your keys. So `from` is `U…` ids, nothing asks the source who they are — one scope fewer
and one request fewer — and the look **names the ids it saw** so they can be copied into the
grant, because an allowlist of opaque ids nobody can find is an allowlist nobody fills in.

## A webhook is a doorbell, and the watch is still the door

Where a machine has a public name, a delivery from GitHub, Slack or Linear makes the matching watch
**look now** (REMOTE-TADE §6.1, §6.2). Nothing else about intake changes, and that is the design
rather than a caution:

- **A delivery never becomes work.** It wakes a schedule (`Schedules.wake`), and the look is the
  one the clock would have taken: `check` reads the source with Tade's credentials, under the grant,
  deduplicated by the keys Tade keeps, `propose` parking it. The payload is a stranger's claim and
  not the record — GitHub works `mergeable` out lazily, Linear's comments are editable — so what the
  door reads out of one is an **address** (`HookAddress`: which repository, channel or team, and the
  kind) and nothing else, and it is never written down or handed on. A forged delivery can therefore
  only make Tade look sooner, with its own credentials, at its own pace.
- **What rings a watch is declared on it** (`ExtensionWatch.doorbell`): its source, the kinds of
  delivery that can change what it finds, and the input — or, unsaid, the project's own repository —
  an address is matched on. `doorbellShape` refuses one that could never ring: no such door, no kind,
  a look that never leaves the machine, or an input a schedule need not have. A delivery that named
  nowhere rings every schedule of its kind, because one look too many finds nothing and one too few
  is the delivery lost.
- **The secret is the switch.** Each source's is a key of the intake extension
  (`extensions.intake.<HOOK_SECRETS key>`, its variable winning), read at every delivery; a source
  with none is the `404` of a path nobody built. There is no setting beside it, because a delivery
  nobody can verify is one nobody may act on however much a setting said yes.
- **Checked before anything is read, in order** (`hooked.ts`): a rate per source, a body cap
  (`200` past it, left unread), the signature over the raw bytes with `timingSafeEqual` and the
  source's window (Slack's five minutes, Linear's minute; GitHub sends none and never retries), the
  delivery id against a ring of verified ones only — or guesses could make the real one a repeat —
  then `200` at once, because Slack gives three seconds; and only then which schedules, and the wake.
- **The poll stays, and slows** (§14 decision 13): a missed delivery is lost on GitHub and, after six
  hours, on Linear. While the newest of three moments for a schedule is a verified wake — not a
  delivery from its source that did not verify, not a look nothing rang for that found something new
  — it polls hourly (`bellDue`), and the moments that skipped are never counted as missed runs. The
  row in SCHEDULES says which way it went and why (`bellSaid`).
- **One address goes further: what a poll cannot see.** `conversations.history` never returns a
  reply inside its thread alone, so the doorbell reads the message's `ts` and its thread's out of a
  Slack `app_mention` (`HookAddress.item`, spelt by `slackItem`) and hands them to the look
  (`ctx.rang`), which reads that one thread with `conversations.replies` and says which it read to
  the end (`read`). Ids only, matched to the channel the schedule reads: a forged one could make Tade
  read a thread of a channel it already reads, sooner. It rides the wake (`Schedules.wake(id,
  item)`), because the line is appended and not yet folded when the look starts, **and** the line
  (`HookRung.item`), so the first look after a window opens is handed what one before it could not
  finish (`ScheduleFold`, `Watched.rang`, `OWED` at most); a look lets go of one only where it left
  nothing for the next (`left === 0`), as `since` moves. Such a request's id carries its thread after
  its `ts` (`slack:C…/<ts>/<thread>`, `externalIdOf`), so the re-check reads it out of its thread and
  the reply threads under the parent — and a reply also sent to the channel keeps the id history
  gives it, so both ways of finding it find one request.

## Connecting a source, step by step

Where a source needs an app of the person's own, the guided page makes it (REMOTE-TADE §6.4) —
`/connect` on this machine, or Settings › Remotes for another one — and **connecting grants nobody
anything**: it lets the forge read as the app and makes the doorbell ring, and `accept`, `from`,
`reply` and `names` stay the person's to write, as before.

- **A page is a fold over a look** (`githubPage`): what is kept in the config, what the source says
  when asked, what the journal heard. A step is done when what it is for is true now, so an App
  deleted on GitHub reads as not installed, and a hook that stopped arriving reads as quiet. One
  line a step and at most one press, and the making step says **what it will ask for and why**
  before the press — the forge's own words (`AppForm.asks`).
- **Something on the machine says where the pages are**, and it is one answer: `connectWhere`
  (`@tade/web`'s `connect-where.ts`), printed by `tade web connect` and drawn on Settings › Intake
  under the switch, on the page of each source in `CONNECT_SOURCES`, with Open and Copy (the Away
  subject owns them, because only it knows whether its door is up). Only ever the loopback door:
  the pages are `here` routes, so an off surface, a `lan` bind or a port another program held is a
  reason and never a link, and a public name is never the address.
- **Everything about the source is asked of the forge** (`capabilities.apps`): the manifest, the
  code's exchange, where the App is installed. No second HTTP client.
- **What comes back is written through the one write path** (`writeKey`, `by: connect github`),
  the private key `0600` because the file is: the old id taken away first and the new one written
  last, so a window that dies halfway keeps no old id beside a new key. What the source hands over
  and Tade does not use (an OAuth client's id and secret) is not kept.
- **GitHub's App is read-only for good**, made with the webhook and its events only where a public
  name gives it an address; without one it is made with none and its watches poll.
- **A source says what its page may be asked** (`CONNECT_FLOWS`): its presses, each a route; its
  callbacks, each answered only for a word a press minted — and a press nothing comes back from
  mints none; whether the source sends a browser back only to a public name (`publicBack`); and the
  hosts a press may open, which another machine's answer is held to before this one opens it.
- **Slack's app is the person's internal one**, made from a manifest (`slack-app.ts`), because an
  internal app keeps Slack's generous tier. **Its signing secret goes in first**: the doorbell
  answers `url_verification` only once it verifies, so the page asks for it before Slack checks the
  address and then says to press Retry. What Slack's Basic Information shows the person and hands over
  no other way — signing secret, client id and secret — is pasted into the page's `keep` press, held
  to its shape there (`KeepSchema`, naming the box a wrong paste went in), written through `writeKey`
  as `connect slack`, and never answered back or drawn again; the install is OAuth v2 back to
  `/connect/slack/installed` on the public name, its code exchanged once over the one Slack client.
  **With no public name** Slack has nowhere to send the browser (its redirect must be HTTPS), so the
  app is made with no address and installed from its own page, its token kept by `keep`, and the
  watch polls. **Socket Mode is not built** — it would be a socket the window holds open — so a
  laptop sees an in-thread mention only where it was also sent to the channel.
- **Linear's app is a private OAuth app of the person's workspace**, made from a manifest
  (`linear-app.ts`, schema `1.0.0`) that may only `read` and, where a public name gives it one,
  subscribes its webhook to what rings the watch (`linearEvents`, read off `doorbell`). **Linear
  hands nothing back when it is made**, so its client id — and with a public name its webhook's
  signing secret — is pasted into `keep`. **Never its client secret**: connecting is OAuth with a
  proof key (`CONNECT_FLOWS.pkce`), and with PKCE Linear takes neither the code's exchange nor a
  refresh with one, so it is never asked for or kept. Its redirect may be `http://localhost`, so a
  machine with no public name connects it too (`publicBack: false`) and its watch polls.
- **A token that replaces itself is the window's to hold** (`LinearTokens`): Linear's access
  token lasts a day and each refresh spends the refresh token for the next, so whatever refreshes
  must write, and only the window writes. The watch asks `ctx.connected('linear')`, the host asks
  the window (`useConnected`, `lending`), and the window refreshes near the end — **one refresh at
  a time** (two would spend one token twice), the new refresh token written through `writeKey` as
  `linear refresh`, the access token never written anywhere. A connection made again drops a
  refresh in flight (`generation`); a write that failed is said once and retried at the next ask,
  and Linear's thirty-minute grace saves a window that died in between. With a connected app the
  watch reads with it and not the personal key; a connected app Linear refused is said, never
  papered over with the key. A command with no window lends nothing, so it reads with the key.
- **What `writeKey` keeps for an extension, the extensions have at once**: a key under
  `extensions.` is handed to the host (`reconfigure`, which also moves what `ctx.apps` reads), so a
  token or an App kept by a connect page is read with on the next look, not after a restart.
- **Another machine's window never carries what is pasted.** `/api/connect` takes `make` and
  `install`, never `keep`: Settings › Remotes draws Slack's and Linear's steps and opens their own
  pages, and says the secrets go in at that machine's own page, through `ssh -L`.

## What not to build

A second scheduler · an `IntakeSource` port before a second source needs one · a second HTTP client
for a forge Tade already talks to · a listener, a webhook endpoint, a public hostname or a socket
held open inside a watch — the doorbell is the away view's public listener's (`HOOKS`) and only ever
wakes a watch, handing it at most an address · a secret carried from another machine's window into a
connect page · work, a grant, a `from` or a word of an agent's prompt out of a delivery's payload ·
a caller-chosen template, grant, repository or channel · an allowlist of
display names · a confidence threshold that starts work · attachment downloading · a reply that
carries an agent's prose · a table of pending replies beside the journal · a status that closes,
assigns, labels or merges anything · a message to a channel a finding did not come from ·
`reply_broadcast`, or anything else that says a status to more people than asked · a reply to a
refusal · a backfill of statuses a shut window missed · a sleep on a `Retry-After` · a cursor that
moves past a request the look deferred · token export, credential sync or automatic account
switching · a remote kill switch for running agents · a `docs/` folder for any of it.

## Prompt injection is not solved, and nothing here may claim it is

The attack already exists in shipped Tade: `review.comments` hands attacker-controlled text to an
agent with a heading on it. The heading helps the way a seatbelt helps, and it is not a cage. What
bounds the damage is the four things around it — the agent works in one task's workspace,
`approvals` decides what it may do and is `never`-tier, `settingReach` means no text can change a
setting, and `jev_review` reads the diff afterwards. Intake makes `SERVER_RUNS_AS_YOU` and
`KEYS_AND_AGENTS` load-bearing in a new way, because the person whose words reach the agent is no
longer the person whose keys are in the file. That is why `propose` is the default forever, and why
`queue` is a per-source, per-project act with its own sentence.
