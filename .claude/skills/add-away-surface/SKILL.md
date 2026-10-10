---
name: add-away-surface
description: Add or change what the away view serves — a route, a verb a device may ask for, the live stream, a read scope, a device grant, the pairing flow, the session credential, the window's pairing panel, `tade web`, or what the guard asks of a request. Use when a phone should be able to read or do something it cannot, when a security claim about the away view needs changing, or when something about pairing, sessions, devices, acting, idempotency, reconnection or the listener's lifetime does the wrong thing.
---

# Changing what the away view serves

The away view is `packages/web` plus the window's own end of it: a contract, a pure projection, a
`node:http` server behind pairing, a session and a guard, and a listener the window owns and dies
with. **It is off by default and listens on this machine alone**, and turning either of those round
is a person's act with its own setting in `reach.ts`'s `never` subtree.

| Changing | File |
|---|---|
| a route | `src/routes.ts`, then the `switch` in `src/server.ts` |
| a **verb** a device may ask for | `src/verbs.ts` (the closed table), a method on `WebActing` in `src/acting.ts`, the window's own half in `packages/app/src/wire/web-acting.ts`, and the page's control in `src/assets/acts.js` |
| what a device may **save** | `src/drafting.ts` (the interface and the draft's revision), `src/drafted.ts` (the closed table, the gate and the sequence), `DRAFTS` in `src/routes.ts`, the window's half in `packages/app/src/wire/web-drafting.ts`, and the form in `src/assets/designer.js` |
| what a device may ask about **being told** | `src/pushing.ts` (the interface and what the page is told), `src/pushed.ts` (the closed table, the gate and the sequence), `PUSHES` in `src/routes.ts`, the window's half in `packages/app/src/wire/web-push.ts`, and the control in `src/assets/push.js` |
| what is worth a notification, and what it may say | `src/noticed.ts` — pure: the five transitions, the payload, the budget, the quiet hours, the presence rule and the dedupe |
| where a notification may be sent | `src/endpoint.ts` (the URL and the addresses), `src/push-out.ts` (the sender), `src/push-scripted.ts` (the one every test uses) |
| which devices asked to be told | `src/pushes.ts` — `<home>/web-pushes.jsonl`, and `sendable` is the binding |
| the notification a phone draws, and the tap | `src/assets/sw.js`'s `push` and `notificationclick` |
| the two files a listener serves | `src/files.ts` — the asset map and the worker, each read once |
| which halves the window hands over | `packages/app/src/wire/web-halves.ts` |
| the pairing exchange's own five steps | `src/paired.ts` (the order), `src/tickets.ts` (the burn) |
| what a device may **say to Tade** | `src/asking.ts` (the interface and the revision), `src/asked.ts` (the gate and the sequence), `ASKS` in `src/routes.ts`, the window's half in `packages/app/src/wire/web-asking.ts`, and the screen in `src/assets/talk.js` |
| what a turn from away may **reach** | `packages/core/src/origin.ts` (the arm, the provenance, the sentences) and `packages/orchestrator/src/origin.ts` (the two tables) |
| the conversation, as a device reads it | `ChatIn`/`TalkIn` in `src/input.ts`, `chatRows` in `src/snapshot.ts`, `talkIn`/`chatLines` in `packages/app/src/away.ts` |
| what a task's revision is made of | `taskRev`/`TaskFacts` in `src/acting.ts`, `factsOf` in `src/input.ts` |
| the factory floor's four collections | `src/protocol-factory.ts` (the schemas), `src/factory.ts` (the input types and the projection), `packages/app/src/away-factory.ts` (the window's own mapping), `packages/app/src/wire/web-factory.ts` (the fold it keeps) |
| where one source of outside work stands | `intake-sources.ts` in `@tade/core` (the nine states), `doorsOf` in `wire/web-factory.ts` |
| what kind of trouble a look ran into | `watch-looks.ts` in `@tade/core`, `troubleOf` in `@tade/extensions-core`, written down by `wire/schedules.ts` |
| a request's own words, as a device reads them | `IntakeIn.material` in `src/factory.ts`, `Bodies` in `wire/web-factory.ts`, `MATERIAL_LABEL` in `@tade/core` |
| what may be asked of one task | `ableOn`/`steeringOf` in `packages/app/src/away.ts` |
| what the window hands the projection each beat | `packages/app/src/wire/web-beat.ts` |
| adding to a task's context | `packages/workbench/src/context.ts` |
| what has to be true of an **act** | `src/acts.ts` — pure, and `test/acts.test.ts` runs the cross-product |
| the act's own sequence, claim to receipt | `src/acted.ts` — no sockets, so a replay, a restart and an altered payload are each one line of setup |
| idempotency, and what a repeat is answered with | `src/receipts.ts` — `<home>/web-acts.jsonl` |
| what the window hands the listener | `src/serving.ts` — the contract; `src/server.ts` is only the listener |
| the live stream's protocol | `src/stream.ts` — pure: the cursor, the ring, the resume rule, the frames, the budgets |
| who is listening, and what they are sent | `src/peers.ts` — pure, over a `Sink`; the caps, the fan-out, the backpressure, the stall |
| what a request *is* | `src/request.ts` — reading an `IncomingMessage`, and every bound on one |
| what a request must satisfy | `src/guard.ts` — pure, and `test/guard.test.ts` runs the cross-product |
| what a device may read | `src/reach.ts` (the grants), `src/surface.ts`'s `reachOf` (the seam) |
| the credential | `src/sessions.ts` |
| the device list | `src/devices.ts` — `<home>/web-devices.jsonl` |
| the headers and the content policy | `src/headers.ts` |
| what a refusal says | `src/errors.ts` |
| the config | `surfaces.web` in `@tade/core`'s `away.ts`, read only by `surfaceOf`; `awayProblems` says any key that is on and cannot mean what it says |
| the sentences that may never get comfortable | `packages/core/src/away.ts`, re-exported by `src/surface.ts` |
| the browser's files | `src/assets/` — `.html`/`.css`/`.js`/`.png`/`.webmanifest` only, **never `.ts`** |
| what an installed shell is, and its version | `src/installable.ts` (the version, the prelude, the names), `src/assets/sw.js` (the worker) |
| the page's half of installing | `src/assets/install.js` (register, update, forget) |
| what a device may keep on its own disk | `src/assets/offline.js` (the allow-list, the store, the screen) |
| the icons and the manifest | `scripts/icons.ts` — **generated**; `test/icons.test.ts` decodes the committed PNGs |
| the palette, the type scale, the primitives | `src/assets/tokens.css` — every colour is a window tone, checked by arithmetic |
| the frame: header, bars, nav, the four region states | `src/assets/frame.css`, `src/assets/shell.js` |
| what a screen looks like | `src/assets/away.css`, `src/assets/rows.js` |
| which controls a screen offers, and what each sends | `src/assets/acts.js` — pure; `screens.js` builds the nodes |
| a screen | `src/assets/screens.js` (work), `pages.js` (lists), `factory.js` (what was handed over), `runs.js` (a run's graph) or `designer.js` (the workflows), plus a route in `src/routes.ts` **and** a view in `src/assets/routes.js` |
| what a figure says | `src/assets/figures.js` — money, tokens, ages, plan bars |
| what a state looks like | `src/assets/glyphs.js` — glyph, word and tone, never colour alone |
| the delta merge and the selectors | `src/assets/store.js` |
| the router, the stream, the keyboard | `src/assets/boot.js` |
| the browser, a11y and visual harness | `scripts/browser.ts` + `test/browser-plan.ts` |
| the listener's lifetime, the beat, the pairing panel | `packages/app/src/wire/web.ts` |
| what the window hands it | `packages/app/src/away.ts` — pure: `Workspace` in, the collections out |
| what the panel draws | `packages/app/src/panels/away/{state,view}.ts`, with four goldens in `test/screens/scenarios/away.ts` |
| the terminal's end of it | `packages/cli/src/commands/web.ts` |

## The rules that break things quietly

- **No route in `ROUTES` mutates a project or a task.** The two non-`GET` routes there are session
  lifecycle — this browser's own credential, created and destroyed — and `test/routes.test.ts`
  asserts that set is exactly those two **by name**. A third fails the test until somebody puts it
  in `LIFECYCLE` deliberately, which is the conversation the rule is for.
- **There are four second tables, each with its own setting, and absence is
  the enforcement for all four.** `ACTS` is `surfaces.web.acting`, `ASKS` is
  `surfaces.web.orchestrator`, `DRAFTS` is `surfaces.web.drafts`, `PUSHES` is
  `surfaces.web.push`. `halvesFor` hands over the matching interface and
  nothing else, so with a setting off a crafted call is the `404` of a path
  nobody built. Each one's `unlocked()` is re-read at every act, turn, save and
  subscribe: on waits for a restart, off is now.
- **`PUSHES` is the one second table whose subject is not the work**, which is
  why it has no receipt and no entity revision: a subscription is *this browser
  saying where to reach it*, so a repeat meets its own row (one per device, last
  one wins) and there is nothing a key would buy. It would have belonged in
  `LIFECYCLE` beside pairing and signing out, and it is a table of its own only
  because it has a setting — and in this package a setting is enforced by a
  table that is not built when it is off.
- **A notification is sent on the window's beat or not at all, and nothing is
  caught up.** The transitions are between this beat and the last one, held in
  memory, so a window that has just opened sends nothing: a laptop shut
  overnight must not wake up and send six notifications about last night
  (`PUSH_IS_WHILE_OPEN`). There is no route that asks for one — a device able
  to ask would be a device able to make this machine POST to an address of its
  choosing, at a rate of its choosing.
- **The endpoint is the one value in Tade that decides what this machine
  connects to, and it comes from a browser.** Two layers and both are needed:
  the URL (`https`, no credentials, port 443, a name rather than an address)
  and *every* address it resolves to. The connection is then made to the
  address that was checked, by handing `node:https` a `lookup` that answers
  with it — a checker that lets the HTTP client resolve again is the
  DNS-rebinding bug with a validator in front of it. The vetted library
  (`web-push`, MPL-2.0) is called for the cryptography only: its own sender
  reads `HTTPS_PROXY`, which would make *where Tade sends something* a variable
  rather than a setting.
- **A notification is per device, and so is what it may be about.** The
  collections are the window's own and are built once for every phone, so
  `changesFor` narrows the transitions to the projects that device reads before
  anything else — a count is still a fact about work it cannot see, and doing
  it before the budget means one device's silence does not spend another's.
- **A notification carries a count and no text**, and the detail is two halves:
  `surfaces.web.push_details` is the ceiling and the device's own `titles`
  grant is the floor. A `410` or `404` is the one answer that forgets a
  subscription; everything else that goes wrong is a retry paced by the next
  transition, because a window has no scheduler to pace one with.
- **A draft is a target with no project, which is why saving has its own
  gate.** A verb names a task and the device's read scope is the per-project
  boundary; a workflow names the repository it works in through an *input* and
  can name any of them. So `admitDraft` refuses a device whose reading is a
  **list** rather than every project — the narrowing is in the direction that
  takes authority away, and there is no later moment to ask it at, because a
  draft saved now is read by a run next week.
- **A draft's revision is its content hash, and that is the opposite of
  `TaskFacts` on purpose.** A task changes constantly in ways no act depends
  on, so its revision is a handful of named facts; a draft changes only when
  somebody writes one, so every change to it is one a save depends on and the
  whole file is the fact.
- **Acting is a second table a setting turns on, and absence is the enforcement.** `routesFor`
  adds `ACTS` only where `surfaces.web.acting` is true, and the window hands over a `WebActing`
  only there — so with it off a crafted call is the `404` of a path nobody built, not a `403`
  naming a setting. Turning it **on** needs a restart (the table is built with the listener);
  turning it **off** is read at every act (`WebActing.unlocked`). Asymmetric in the direction that
  takes authority away, and the setting's own `means` says so.
- **A verb is a method, never a name and a payload.** There is no `run(verb, args)` anywhere:
  `verbs.ts` parses a body into an `Asked` that already knows how to do itself, so nothing
  downstream switches on a name and there is no shape a path, a command, a credential or a new
  agent could arrive in. Each verb gets its **own route**, so the guard's per-route scope check
  stays exact.
- **Every verb is a target plus the state it expects**, and `test/verbs.test.ts` asserts it of
  every entry. The idempotency key is a *fast path*; the guarantee is that the window re-checks the
  state at the moment of the write and a replay meets a target that has moved on (DECISIONS §4.6).
  A verb that cannot be expressed that way does not ship.
- **The claim is synchronous and the file append is what the answer waits on.** `Receipts.claim`
  decides and marks before its first `await`: the tempting shape — look, append, then answer
  `fresh` — has an append's worth of event loop in the middle, and two requests in one tick are
  both told they are first.
- **An `asked` line with nothing after it is `unsure`, for ever.** That is a window that died
  mid-act, and the answer is that Tade does not know, will not do it again, and says so. **Nothing
  promises exactly-once side effects**: a key past `KEPT`, or a receipts file somebody deleted, is
  a *new* act — which is safe only because of the state re-check.
- **A read-modify-write of a task file is one act only because of `aloneOn`** (`tasks.ts`). Two
  parks asked for at once both read the old world and both write without it, and the one working
  from a world that no longer exists wins silently instead of being refused.
- **Provenance is an argument, not a prompt line.** `From` is carried into the verb and `byOf`
  turns it into the `by` on the journal line — `you` at the keyboard, `device <id>` from away. A
  remote act recorded as `you` would make `historyFrom` count it as the person's own doing, and
  DECISIONS §4.5 is why a sentence to a model is not a mitigation.
- **A device's scope widens at the machine and nowhere else.** `allowDevice` appends an `allowed`
  line; there is no route, no orchestrator tool and no config key for it, because the thing that
  grants authority is never reachable from inside the authority it granted. `read` survives every
  grant: widening what a device may do and signing it out are different acts.
- **The per-project boundary for acting is the read scope.** A narrower acting list would be a
  second list to keep in step, and the day they disagree is the day somebody acts on a project they
  cannot see.
- **A `web_did` line goes in whatever happened**, a refusal at the door included: a device that
  asked to change something and was not allowed to is the case the audit matters most in.
- **A path that is not in the table is a `404`, never a `405` and never a `403` with a hint.** An off
  capability is not a thing to probe: a `403` saying "turn `diffs` on" tells whoever holds a stolen
  session that there is a diff route and what the setting is called.
- **The guard is pure and has one call site.** A guard that read `req` could only be tested by making
  a request, and then the attacks it exists for get asked once each, for the one route somebody
  remembered. Add a layer in `allowed`, not in a handler.
- **No forwarded header is ever read** (`NEVER_TRUSTED`), *and a proxy may be in front of this* —
  `tailscale serve` is the recommended way to give a phone HTTPS. A deliberate proxy is trusted by
  being **named in `surfaces.web.trusted_hosts`** (`schemesFor`, `trusted`), which is a person's act
  in the `never` subtree; a header is anybody-on-the-network's. Read one and
  `X-Forwarded-Host` walks past the `Host` allow-list (the rebinding defence), `X-Forwarded-Proto`
  makes a plaintext session look trusted enough to act, and `X-Forwarded-For` makes the rate limit and
  the journalled address whatever the attacker typed. The address is the socket's and the host is
  `Host`.
- **`Sec-Fetch-Site` is not checked on a document navigation.** A scanned code is a typed URL
  (`none`) and a followed link is `cross-site`, so requiring `same-origin` on the shell refuses every
  real way in. Everything else — every `fetch` the page makes — is checked.
- **The pairing ticket is burned on the *claim*, before anybody at the machine is asked.** That one
  ordering is what makes a replay, a concurrent attempt, a refusal, a deadline and a throw all find
  nothing. The tempting shape — check, ask, then delete on success — is wrong in all five ways.
- **A body of `null` is a body.** `readBody` returns a discriminated answer, because `unknown | null`
  made a four-byte `null` indistinguishable from "already refused" and held the request open for ever.
- **`(epoch, rev)` is the cursor, and nothing reads `seq` or a byte offset.** The epoch is minted by
  `webServer` — *the thing that starts* — and the window reads `server.epoch` for `lifetime.epoch`,
  so a snapshot's freshness and a delta's `id` are the same string. Two sources for one value makes
  every reconnection resnapshot, which is **correct**, so no test goes red while a phone downloads
  the whole tree every two seconds.
- **The stream has no timer, and neither does the window's end of it.** Heartbeats, slow clients and
  expired sessions are all decided in `Streams.beat(now)`, called on `Live`'s existing refresh.
  `test/stream.test.ts` asserts neither pure file so much as names `setTimeout`.
- **A reopened dead session is `204`, not `401`.** A non-200 kills an `EventSource` permanently and
  `204` is the one status that tells a browser to *stop reconnecting*; a `401` every two seconds for
  as long as the phone is awake is what the alternative looks like. The guard still runs first, so a
  bad `Host` is still a `403` — it is not a session problem.
- **Over the budget, deltas stop and one `resync` is owed.** The layer underneath buffers whatever it
  is handed, so the only bound that holds is to stop handing it anything; a snapshot replaces
  anything, which is why dropping a run of deltas is correct rather than lossy.
- **Nothing is built for nobody.** `Away.beat` marks the collections stale and does two empty loops;
  the collections are built on demand (`collections()`) and memoised until the next beat, because a
  request is not idle. Building them means four folds over the whole journal, and an enabled away
  view nobody paired a phone to must not pay for one every two seconds
  (`packages/app/test/wire/away.test.ts`).
- **No handler does any work.** No `git`, no `ps`, no spawn, no file read but the device list: every
  read answers from what the window already holds, through `WebReading`. The window draws on this
  thread.
- **A read scope is per device, so the projection is built per device** (`readingFor(reach)`).
  Filtering one projection afterwards is how a field that should have been withheld rides along.
- **`bind: lan` is a read-only transport** (`scopesOn`). A credential that crossed a network in the
  clear never buys an act, whatever is turned on later — and it is **re-asked at the act**, because
  the network a device is on changes.
- **The assets folder is reached with `fileURLToPath`, never `new URL(...).pathname`.** A URL
  percent-encodes, so under any install path with a space in it — `~/Library/Application Support/…`,
  a `Program Files`, an account that is two words — `readdir` was handed `…Application%20Sup…`,
  found nothing, and every page and every file became a `404` with nothing anywhere saying why.
  `listen()` now says it when the map comes back empty, because a folder that could not be read is
  not a folder with no files in it.
- **`fresh.warnings` is the one metadata field whose words this package did not write**, so the
  *no path of its own* claim is kept at the boundary (`withoutPaths`) and not inherited:
  `collectStatus` writes `<project>: <its root>: <what git said>`. Its fixture carries the shapes
  status really produces, because a fixture whose warnings happen to be tidy is the leakage test
  passing while the claim is false. Bounded by `budget.warnings` too — the freshness rides on
  every frame, so it is the one collection whose budget is about what a connected phone pays for
  ever rather than about what fits on a screen.
- **A money figure is drawn with the period it covers** (`fresh.spendSince`, `sinceSaid`). The
  window folds from **its** midnight, so a task that cost forty dollars yesterday arrives with no
  cost at all and the dash's own word is *not recorded* — the three-dashes lie one period out. The
  instant is on the wire rather than a word on the page, because the phone is somewhere else and
  *today* is not the same day there.
- **A `.ts` file in `src/assets/` is renamed to `.js` at publish**, so it is served under one name here
  and another on somebody else's machine. `git add` every asset, too: staging copies only
  `git ls-files` output, so an un-added `.css` is a page with no styles everywhere but here
  (`test/release.test.ts` reads the staged tree the way the server does).
- **A screen is two tables, held equal.** `src/routes.ts` says which paths answer with the shell and
  `src/assets/routes.js` says which the page knows; a path in one and not the other is a screen that
  works until somebody reloads it. `test/routes-client.test.ts` asserts both directions.
- **Nothing in the page derives a state.** `deriveState` already decided and the projection carries
  its answer and its own `reason` clause, verbatim. A second wording is a second state machine — the
  queue's words are `describeQueueState`'s, copied into `glyphs.js` because a browser cannot import a
  `.ts` file and held equal by `test/glyphs.test.ts`. Four rules in `figures.js` are the domain's the
  same way.
- **Outside text is a third kind of value, with two grants of its own.**
  `AUTHORED` is the owner's and rides on the grant for the thing it is part of;
  `OUTSIDE` (`fields.ts`) is a stranger's and rides on `requests` or
  `material`. Neither is scrubbed — rewording somebody's request is the same
  lie as rewording a note, and what an agent was handed and what a person reads
  have to be the same text. What stands instead is the grant, the budget, the
  heading (`MATERIAL_LABEL`, which travels **with** the body rather than being
  the page's to choose), and the page never building markup.
- **A body crosses for the requests somebody is being asked to decide about,
  and every other row says so.** `budget.materials` is a second budget over one
  collection: a machine with forty requests would otherwise put a third of a
  megabyte on every frame for a phone reading one of them. *Not granted*,
  *nothing was written down* and *not on this page* are three different
  answers and `materialSays` says which.
- **An empty inbox has five meanings and four of them are somebody's to fix**,
  which is why the doors are their own collection (`sources`): off, ungranted,
  unwatched, unreachable, rate-limited, refused and found-nothing are seven
  different things to do next, and a page with one word for them says *nothing
  yet* while a connector has been answering `429` since Tuesday. The *kind* of
  trouble is recorded at the look (`troubleOf`) and never parsed back out of
  the sentence.
- **`proposed` and `started` are never one word.** One is waiting for a person
  and the other is an agent spending money; `glyphs.js` keeps them as far apart
  in shape and tone as *wants you* and *working*, because that is what they are.
- **A run is an effort and nothing new**, so its graph is the fold of the task
  files that name it and its edges are the `start.after` the queue's own rule
  reads. The depth is a **number** on the wire and not a drawing: the window
  draws boxes and lines because it has eighty columns, a phone stacks the
  layers, and both read the same `waits` rather than being two layouts of two
  graphs. A cycle is walked with a visited set — these are files anybody can
  edit, and a projection may not hang the window on one.
- **The designer is a list, a form and a dry run, and never a canvas.** The
  form's rows are `workflowFields`' own, so neither surface can offer a field
  the validator would refuse. A template previews its **shape**
  (`workflowPlaces`) and not a dry run, because nobody has filled its inputs
  in; the dry run proper belongs to a *request*, where they are real
  (`intakeWouldRun`).
- **Which template a workflow row's steps are of is said, never inferred.**
  `shows` is `draft`, `published` or `nothing`: a draft is a file no run reads
  and the one thing an edit can reach, a published snapshot is what a run
  points at and never changes, and a row that did not say which would make
  `v3` mean two things on one screen.
- **An act that stays at this machine is named with one clause**, never left as
  a hole and never explained in a paragraph: `locally` on a row is the act and
  a sentence, and the long form is said once where somebody is deciding
  (`LOCAL_ONLY_ACTS`, on the control in Settings).
- **Two nulls, two sentences.** A figure that is null because nobody recorded it and one that is null
  because this device was not granted it are different facts, and a page that drew both as *not
  recorded* tells somebody their work cost nothing. `you.reads` is the only way to tell them apart
  from the page (`mayRead`), and every screen that can draw a dash asks.
- **A screen is built once and then patched.** A delta writes text and classes into nodes that
  already exist (`keyed`, `textIn`), so focus, a half-made selection and the scroll position survive
  it — and **a delta never moves the current tab**, which only navigation does.
- **An age freezes when the stream is not live** and gains the moment it was last true. An age
  counting up against a snapshot nothing can refresh is the lie §5.10 exists to prevent, so `asOf`
  hands the server's own last word to every row rather than the device's clock.
- **Nothing in the client touches `innerHTML`**, there is no Markdown renderer, and the content policy
  has no `unsafe-inline`. Those three are what actually stands against injected script; `HttpOnly`
  stops the *theft* of a credential and not its use.
- **`[hidden]` is an author rule with `!important`, in `tokens.css`.** The page turns a region off
  with `el.hidden = true`, which is `display: none` in the *user agent's* stylesheet — and any author
  rule beats a UA one. The moment a region gained `display: flex`, `hidden` stopped hiding it and
  every control a row said could **not** be asked for was drawn anyway, with its reason beside it.
  Nothing offline could see it; the browser harness found it in one run.
- **A control nothing could carry out is absent with its reason, never disabled.** A task row carries
  two lists — `can`, and `cannot` with a `why` — and `ableOn` puts every verb in exactly one of them
  (`packages/app/test/away.test.ts` asserts it over the cross-product). A verb in neither is a hole
  somebody has to guess at; in both is two answers to one question. **It is not permission**: the
  gate re-asks the scope, the setting, the project and the origin at the act, and the page's `actsOf`
  is a drawing hint read off its own session.
- **Only a `200` clears a box.** A `409` is the world having moved, and throwing away a paragraph
  somebody typed on a phone because of it is the one failure they cannot undo (`afterAnswer`).
- **Two presses for the two acts asking again does not undo** — `done` and `intake` — and the body's
  own `confirm: true` literal is the other half. Neither stands in for the other: the tap stops a
  mis-tap, and the literal means there is no shape of the body that says *do not*.
- **The shell's version is a hash of its own bytes, and there is no stamp anywhere.**
  `shellOf` hashes every file's path and etag; `/sw.js` answers with that as a line of JSON in
  front of `assets/sw.js`. So a browser sees an update because the script's bytes changed, and
  there is nothing to bump — a constant would be right on the machine that wrote it and wrong in
  the tarball, and the symptom is a phone a week out of date with nothing saying why.
- **The worker's source is in the folder and is not served as a file.** `assetFor` refuses
  `/assets/sw.js`: a worker's URL is its scope, so one registered there could only control
  `/assets/`, and the source without its prelude caches nothing while looking exactly like the
  real thing.
- **Turning installing off serves an *uninstalling* worker, never a `404`.** A worker whose script
  fetch fails is left exactly where it was — w3c/ServiceWorker#204, closed as *will not do* in
  2017 — so deactivation is something a device is **told**, and only when it next reaches this
  machine. `INSTALLED_IS_NOT_REVOCABLE` says what that does not cover, and the off worker's bytes
  are a **constant** so that *off* settles instead of reinstalling on every load.
- **The worker precaches a folder and intercepts nothing else.** There is one `addAll`, no `put`
  in the fetch path, and `/api` is not a path it will answer — so an authenticated answer on a
  disk would have to be written on purpose. `test/worker.test.ts` runs the served bytes in a fake
  scope and drives install, upgrade, rollback and uninstall; the browser harness cannot, because
  each means different bytes at one URL and a second listener is a second origin.
- **Nothing reloads a page somebody is typing in.** The serving worker never calls `skipWaiting`
  on install; a waiting one is a bar with a button, and the swap happens on a press. The
  *uninstalling* worker does skip, and it is not an exception: it serves nothing and claims
  nothing, so there is no swap — made to wait it would sit behind that button for as long as a tab
  stayed open, and the removal would never happen.
- **A kept view is counts and a moment, and not a redacted snapshot.** `countsOf` builds a
  different value; `onlyKept` is applied on the way in *and* on the way out; every field is a
  number, which is the form of *no text at all* a test can check in one line.
- **The two cache names are spelt in the page as well as in `installable.ts`**, held equal by
  `test/offline.test.ts` — `glyphs.js`'s treatment, for the same reason: the two moments they
  matter are a cold open with no answer and a session that has just been refused.
- **Installing needs a secure origin, which a LAN address is not.** `127.0.0.0/8`, `::1` and
  `localhost` are potentially trustworthy; `192.168.*` over plain HTTP is not, and the browser
  refuses without saying why. `OFFLINE_NEEDS_HTTPS` is the sentence, and it carries the other half
  people get wrong: an https name is a **new pairing**, because a session is bound to the host it
  was minted on.
- **`page.waitForFunction` cannot be used in the harness.** It polls by compiling a string in the
  page, and the content policy has no `unsafe-eval`. `page.evaluate` goes through the debugger
  protocol and needs none, so the waiting is a loop in `browser.ts` (`until`). That the policy
  refuses it is the point: a harness that loosened the header would be testing a page nobody is
  served.

## Seven sentences that may never get more comfortable

In `src/surface.ts` (re-exported from `@tade/core`'s `away.ts`), said once so no control, README
line or commit message can say the easy half. `test/separation.test.ts` holds each of them.

- `LAN_IS_PLAINTEXT` — on a LAN anybody on the wifi reads every page and the cookie, and
  `tailscale serve` is the way out. **Never** say a LAN is secure, encrypted, private or safe.
- `COOKIES_IGNORE_PORTS` — RFC 6265 §8.5, and **no cookie prefix changes it**. `__Host-` gives real
  `Domain`/`Path` guarantees and nothing about ports; the honest mitigations are the session being
  bound to the exact host it was minted for, and TLS.
- `HTTPONLY_IS_NOT_XSS` — it stops a script reading the cookie, not injected script using it.
- `DEVICES_AND_AGENTS` — `0600` keeps the file from other people, and **an agent is not another
  person**: one on this machine can append a line and pair itself. Said with the way out in the same
  breath — the list shows every device, every act is journalled under its id, and "Disconnect
  everything" needs no network.
- `OFFLINE_NEEDS_HTTPS` — installing needs a secure origin, and a private address on your own wifi
  is **not** one however local it feels. The way out in the same breath, and with it: a new name is
  a new pairing.
- `INSTALLED_IS_NOT_REVOCABLE` — a shell on a phone is that phone's; a `404` does not remove one;
  what comes off, comes off when that device next reaches this machine. Never *erased*, never
  *wiped*, never a guarantee.
- `LAST_VIEW_IS_A_COPY` — the **list** of what is kept, because *minimal* and *redacted* are the
  words a comfortable version would keep while dropping what is actually on the disk.

## The config, and the five controls over it

`surfaces.web` is read in exactly one place — `surfaceOf` — and its eight keys are `never` in
`reach.ts`: each either widens who can reach the control room (`enabled`, `bind`), decides what the
pairing code says (`port`), lets a device change something (`acting`), lets one talk to the model
that holds the tools (`orchestrator`), lets one save a draft every future run of a workflow would
be stamped from (`drafts`), puts Tade's own page on somebody's phone (`install`) or lets that phone
keep a few counts (`offline`, narrowed under `install`). A tier is a property of the path, so
`packages/core/test/reach.test.ts` asserts it by subtree rather than through what Settings happens
to list.

**All eight are `live: false`, honestly.** The listener comes up when the window starts and the epoch
a connected phone holds is per server start, so turning one on mid-session would have to tear down
and rebuild something somebody is looking at. Saying *takes effect on restart* is the honest answer;
doing nothing and saying nothing is the setting Tade accepts and ignores.

**A new key here is a visible change**, so it redraws the README's pictures in the same commit
(`redraw-the-pictures`): the Settings category list grew past the rows the panel has, which is
correct (it scrolls) and moved every settings golden.

## What is not built, and must not arrive because a route was convenient

No setting is writable, nothing grants anything, **nothing publishes a workflow or a persona,
nothing makes, renames or deletes a draft, and nothing touches a published version** — which never
changes once it is out, so a run that points at `name@3` goes on pointing at it. Nothing turns a
source on, nothing starts an agent (`steer` is a message into a conversation that is **already**
running, refused where no agent is), nothing runs a command, nothing pushes, merges, answers a
review or overrules a check, nothing reaches a credential and nothing reaches the `ToolHost` — which is a Unix
socket in `@tade/orchestrator` for the window's own children, and is **not this**
(`test/separation.test.ts`). Each of those is a `never remote` line with an argument behind it; if a
phase wants one, it gets its own setting in the `never` subtree, its own threat model and its own
go/no-go, not a route somebody added.

## Talking to Tade is a third table, not a ninth verb

`surfaces.web.orchestrator` is a **fourth** decision and must never share a
switch with `acting`. Every verb is a target plus the state it expects, each
enumerable; this hands **free text to a model that holds tools**, which is the
difference between answering a question and being able to ask for anything.
So: its own setting, its own scope (`ask`, implied by neither acting tier), its
own table (`ASKS`), its own interface (`WebAsking`), its own event type
(`web_asked`) and its own grant control in the panel.

- **What makes it safe is two gates and a closed list, not the sentence Tade
  prepends.** `cameFromAway` is kept because a person reading the transcript
  needs it and because it tells the model why a refusal is correct — it is
  **not** the enforcement, and anything that treats it as one is the bug.
  `packages/orchestrator/src/origin.ts` has both tables and the argument.
- **Omitting `said` was never enough, and that is the correction to DESIGN
  Phase 3.** `namedBy` reads the last forty lines the *person* said, so a
  remote turn naming a setting they happened to name last week is authorised by
  their line; and `settingReach`'s `open` tier needs no words at all. So the
  answer is not about what a remote turn writes — it is that `config/change` is
  not reachable from one.
- **The harness's own tools are the other half.** pi gives the orchestrator
  `bash`, `write` and `edit`, and those never touch Tade's code — so the gate
  is a `tool_call` hook **inside Tade's own tools extension** (`gateTools`),
  asking the host at the call (`origin/allow`). It needs no approval mode and
  no supervision channel, which is what keeps a local turn exactly as it was;
  and it had to be there rather than in the supervision extension for a
  mechanical reason too — both register this run's extension tools, and pi
  refuses to start on the collision. A remote turn is therefore only possible
  where the harness can hold its own tool calls (`permissionGate`) **and**
  loads Tade's code as its own modules (`nativeExtensions`): `canBeArmed` is
  the one reader, and a harness that lacks either **answers nobody and says
  why** rather than running one unrestricted.
- **A socket that cannot be answered means allow**, and the argument is not
  convenience: the thing that answers `origin/allow` is the window, and the
  window is also the only thing that can serve a message from away. No window,
  no remote turn, nobody to narrow — while failing closed there would break
  the orchestrator of a window that died, for no safety at all.
- **One turn at a time, and the lease is held from the prompt until `idle`.**
  A harness delivers a mid-turn prompt *into* that turn, so a message accepted
  while the person's question is being answered would put a stranger's words
  inside the person's arm. The window is deliberately narrowed wider than the
  remote turn's own calls: a call Tade cannot attribute is judged against the
  *narrower* arm, so the worst case is the person being refused for a few
  seconds — said out loud, with escape as the way out.
- **`status/read` under a remote arm answers that device's own projection.**
  Not `tade status`, which carries project roots, worktrees and the harness's
  summaries of waiting commands. That is what keeps `ask` from being a way
  round every read grant, and it is why `worker/pending` is narrowed to a
  tool's **name** on the way out (`waiting`).
- **`memory/remember`'s `by` is rewritten from the arm.** The tool sends
  `orchestrator`, which is true of a local turn and false of a remote one.
- **The conversation is the one collection whose text is not shown as it was
  said**: every line is path-elided (`chatRows`), because a model quotes what
  its tools answered. `GRANT_MEANS.talk` is where a person is told so, and
  `transcript`, `args`, `payload` and `output` are all still names that fail
  `NEVER_A_FIELD`.

**There are eight verbs and they are the whole of what a device may ever do**: `park`, `answer`,
`steer`, `queue`, `done`, `note`, `context` and `intake`. Park went first because it is the smallest
act that proves the whole path; the rest are §9.1's matrix filled in, each a line in `VERBS`, a
method on `WebActing`, and a control in `acts.js`.

**Three in the matrix are deliberately not verbs**, and `verbs.ts` carries the argument beside the
table: a whole project's queue (it names no task, so it has no entity revision to echo and no replay
could be told from a fresh ask), a diff, a review's text or a lane's output (each ships source or an
agent's bytes to a phone and a browser cache — a *reading* grant with its own threat model, and a
name `NEVER_A_FIELD` already refuses), and stopping an agent (not a hold, not undone by the same
verb).

**Every verb makes two checks and they answer different questions.** `onTask` compares the revision
the device echoed (`was`) against the one the projection would put on that row now — that one is
about *the screen*, it is exact because both sides are `taskRev` over the same facts, and it is **not
a lock**: the projection moves on a beat. What makes each act atomic at the moment of the write is
the door it goes through, and `web-acting.ts` has the table of which door and what it guarantees. A
verb whose answer to that column is "nothing" and whose effect is not idempotent does not ship.

**`taskRev` is one field per thing a verb assumes**, readable rather than hashed: a field no verb
depends on refuses perfectly current acts every time a figure moves, and a thing a verb assumes that
is *not* in it is a replay nothing refuses. Both failures are silent. What cannot fit in a field that
small is named in the act instead — `AnswerCall.approval` carries the approval's own id, because *an
approval is waiting* and *this* approval is waiting are different facts.

**The context verb appends and there is no replace.** A replace would mean sending the context's
current text to the phone first, and this package has no way to read one (`WebReading` is synchronous
and answers out of what the window already holds) — while for a task that came from outside the
machine the body is a stranger's words. So the act carries only what to add, and what falls out is
the property an If-Match was reaching for: **an append cannot overwrite a local edit**. The
containment is `workbench/src/context.ts`' and is owed *there*: the id is `TaskId`'s regex, the
task's folder is `realpath`'d and must come out inside the home, and the file is opened `O_NOFOLLOW`.
Only the last of those is atomic, Node has no `openat`, and that limit is written down rather than
implied away.

**The grant control gives both tiers**, `answer` and `steer`, because one that gave only the gentler
would mean a phone that can allow a command and cannot set the work aside. A control per tier is the
thing to build if somebody wants the narrower grant; until then `ACTING_IS_NOT_YOU` is held to naming
all of it (`test/separation.test.ts`).

**Talking is a second control beside it**, and the two **compose**: `allowDevice` writes the whole
scope list, so every control over it builds from what the device already has (`kept`). Two controls
that each enumerated would mean the second silently revoking the first, with nobody told.

## `tade web`, and what it cannot do

`status`, `devices` and `revoke` read `config.yaml` and `web-devices.jsonl` **directly and never open
the workbench** — questions never need the window, and disconnecting a phone you have lost must not
depend on Tade being open. The file is append-only and keyed by device, so a line the terminal writes
and a line the window writes fold to the same answer whichever order they land in; nothing rewrites
it, which is what makes that true rather than lucky.

`off` is **two acts under one word**: the setting, and every credential. An "off" that leaves
credentials behind lets every phone that was ever paired straight back in when somebody turns it on
again next week.

`pair` **cannot mint a code**. A ticket lives in the memory of the process whose server has to claim
it, and there is no channel from a shell into the window — the `ToolHost` is a Unix socket for the
window's own child agents and must never become this. So it says which window is open and points at
the panel that mints one.

## The page, and what holds it

`test/design.test.ts` checks the design by **arithmetic over the production files**: every hex is the
xterm tone it names, every contrast ratio in a comment is the ratio the hex has, no text is under
13px, the gutter is `padding-inline` and no shorthand can zero it, every token used is declared and
every token declared is used, `--quiet` only appears in a rule that declares its own size, and the
one `outline: none` in the stylesheet is named with its argument.

`scripts/browser.ts` is the other half and it needs a real browser:

```
pnpm add -D -w playwright axe-core && pnpm exec playwright install chromium
node packages/web/scripts/browser.ts --shots /tmp/away
# or, with a Chrome the machine already has:
TADE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node packages/web/scripts/browser.ts
```

It pairs a device through the real page, visits every route at 360/834/1440, runs axe, and checks the
landmarks, the targets and that nothing scrolls sideways. **It pairs three times**: a device granted
nothing, which is what the honesty checks are for; one granted everything at the widest width —
because every figure draws differently with the grant, and the page with actual money, notes and
sign-ins on it is the one the owner will look at; and one granted **both acting tiers** at 360px,
where the three checks only a browser can answer live (`controls`, `touch`, `typing`): that what a
row says may be asked of it is what is drawn and what it says cannot be is absent *with its reason*,
that a real tap and a real `Enter` on a focused `<button>` each ask for exactly one act, and that a
refusal leaves what somebody typed where it was. Its grant is `allowDevice` — the same append the
pairing panel makes, because there is no route for one and there must never be. **Neither is in the lockfile**, because
Playwright's install pulls hundreds of megabytes of browser onto every machine, and this repository
holds the line that `pnpm install` runs two scripts and installs nothing else. **With no browser it
reports `unrun` with the reason and exits 2** — never a pass. That property is what
`test/browser.test.ts` holds, offline, and it is the one that matters: an a11y harness that silently
found nothing and went green is worse than none.

## What a test here cannot prove

A real phone's camera reading the QR at the module size a terminal draws; iOS Safari's local-network
prompt; whether `.local` resolves on the owner's devices; whether a real reverse proxy passes a
stream through unbuffered; **whether the page is beautiful or useful**, which is the owner's after a
week; and how it behaves in Safari and Firefox — the harness drives Chromium, and the other two are
named rather than claimed. Each is **named as outstanding** rather than ticked. `test/qr.test.ts`
proves the *encoding* by decoding it with `jsqr`, which is a different codebase — that is the most a
machine here can say.

**A typed URL cannot pair.** The ticket is in the QR's fragment, so a person who types the address
reaches the pairing page with nothing to present and is told to scan the code in the window.
DESIGN §5.7 wanted a six-digit code as the typeable path; that is a second kind of credential with
its own threat model, and it is **not built** — outstanding, not decided against.
