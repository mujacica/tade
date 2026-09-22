# Tade — agent guide

Tade is a voice-first control room for coding agents: it runs them as pi in lanes (terminals),
derives task status from observable state, and is driven by an orchestrator you talk to. It owns no
state of its own — tmux owns the processes, pi owns the conversations, git owns the work — which is
why closing it is harmless. **You may be a Tade worker editing Tade itself.**

## Commands

- `pnpm check`: the full gate (biome ci, tsc, vitest). Run it before calling work done.
- `pnpm test`: vitest (must stay under 30s with zero network calls).
- `pnpm exec biome check --write .` formats and fixes.
- `pnpm test:smoke`: the cheap end of the suite — the domain, and the tests that hold this
  repository to its own word. A second or two, and what the pre-commit hook runs.
- `pnpm tade <args>` runs the CLI from source.
- `TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts` is the only test that uses a
  real model. It costs money and needs credentials, so it is skipped by default and run before a
  release — but it is the only evidence that a model can choose the right tool from the descriptions
  we wrote, because every other test tells the fake model what to call.

**The commit hook is the fast gate, and CI is the real one.** `.githooks/pre-commit` runs biome,
`tsc` and `pnpm test:smoke` — four or five seconds over the whole repository, because a hook people
wait on is a hook people pass `--no-verify` to. It deliberately leaves out everything that makes
the suite take minutes: real git repositories, real PTYs, the tmux driver, the app's frame loop.
So a green hook is not a green `pnpm check`, and it never stands in for one. `pnpm install` points
git at it (`core.hooksPath`); `pnpm hooks` does it on demand, and leaves a hooks path you chose
yourself alone unless you ask.

**Run the suite on its own.** `pnpm check` runs the gate in sequence for a reason: the tests spawn
real git and PTY processes with short timeouts, so anything CPU-heavy running alongside them —
`tsc` over the monorepo, most obviously — starves those processes and they time out. That looks
exactly like a regression and is not one: 13 such failures over 485s became 465 passing in 8s once
the suite had the machine to itself. Never conclude the suite is broken from a run that shared it.

There is **no build step**. Node ≥22.18 runs `.ts` directly (type stripping). Consequences:
- Relative imports use the `.ts` extension: `import { x } from './x.ts'`.
- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Type-only imports use `import type`.

## The four rules

1. **R1: every port is an interface plus a registry.** A port lives with its subsystem —
   `drivers/core`, `harnesses/core`, `voice/core`, `extensions/core` — next to the conformance suite
   its implementations must pass. Implementations are registered by name in one registry map; call sites
   never `new` a concrete one.
2. **R2: no port interface uses an implementation's vocabulary.** It's `write(lane, bytes)`,
   never `sendKeys`. Check every method name against this before implementing.
3. **R3: capabilities are declared, never sniffed.** Branch on `driver.capabilities.focus`, never on
   `driver.id === 'tmux'`. A Biome plugin (`biome/no-port-id-check.grit`) fails lint on this.
4. **R4: conformance suites come first.** Each port has a shared suite beside it in its `core`
   package (`drivers/core`, `voice/core`, `extensions/core`); every implementation must import and
   pass it.

## Other invariants

- **Status is a query, not a memory.** `deriveState` (`core/src/state.ts`) is a pure function of
  probe results: no I/O, no clock reads (take `now`), no async.
- `status` never throws. Failures degrade to a partial answer plus `warnings[]`.
- **How long an agent ran is derived too, never timed.** `runtimeFrom` (`core/src/runtime.ts`)
  reads the journal's `run_started` and `run_exited` and nothing anywhere holds a stopwatch; a run
  still open counts up to `now`, because an agent working right now is running right now. A run
  nobody wrote an exit for ends where the window closed, or where the next one opened and
  relaunched it — counting the hours Tade was shut would add a night's sleep to every agent's
  morning. The orchestrator is not in it: it has no run of its own, it lives as long as the window.
- Tests use **real git repos** built by `test/fixtures/mkrepo.ts`. Never mock git.
- **A fixture must not be kinder than reality.** If the fixture differs from what a user's machine
  looks like, it hides bugs instead of finding them: `mkrepo` deliberately leaves `.tade/`
  untracked and unignored, because a repository Tade has not worked in yet does, and excluding it
  once concealed a broken teardown. The rules arrive in a fixture the way they arrive anywhere —
  `createTask` writes them — so a test that goes through the workbench gets what a user gets, and
  one that does not is a project before Tade, which is also a thing that exists.
- Git is invoked directly with `--porcelain=v2` / `-z`. No git wrapper libraries.
- Parsers of external formats (provider transcripts) return `null` on unknown shapes, never throw.
- `intent_spoken` is stored verbatim. Never paraphrase or normalise it.
- **Notes are the one thing Tade is told rather than derives**, and so the one exception to "status
  is a query": nothing can recover them, so they are kept verbatim in `<home>/memory.jsonl`,
  append-only, and a line that won't parse is skipped rather than thrown over. Never lowercase or
  reword one — `parseUtterance` recovers the original casing for exactly this reason, and it took a
  test with a capital letter in it to notice that it didn't. A headline may be written *beside* one
  (`summary`, what the note is about and what it does) by whoever takes it down — the orchestrator
  writes one as it calls `tade_remember`, and a person writes one on the note's own page — and the
  window reads a note by it, over the words themselves. It is never made out of the note: a summary drawn from the text at drawing time is a
  guess at what somebody meant, made four times a second, and the whole reason notes are verbatim is
  that nothing can recover that. Optional and always will be, since every note taken before it
  existed has none; those are drawn in their own words, as they always were.
- **A task is finished when the journal says so** (`task_done`). Its agent says it (`tade_done`), a
  person or the orchestrator marks it, or the window sees the task's own rule met and writes that
  down once. The rule is `done` in its task file — `said`, `idle`, `committed`, `merged`, `manual` —
  chosen by whoever made the task. Never infer it from a turn ending (an agent that asked a question
  looks the same) or from a checkout agent having stopped (status calls that `review`). A branch
  that was squash-merged counts as merged: its commits are nowhere in the base, so when there is no
  ancestry to follow Tade asks whether merging it would still change anything.
- **Queued work is a task that has not started**, with `start` in its task file: what it waits on
  and why, not before when, and what its agent is told. The window starts it by rule
  (`readyToStart`) on every look at the tasks — never a model deciding again — as far as
  `max_parallel` leaves room, and writes why (`queue_started`). What it waits on failing, stopping
  or going holds it (`queue_held`), said once to the orchestrator, which asks the person; their
  choice (`queue_changed`) is written down and read back. In a worktree it begins on top of what it
  waited on (`startFrom`), or from the base when that was merged, and keeps its own `.tade` files.
  A plan is checked against what the project is already on — agents working, work an earlier plan
  left queued — and says what it will run into rather than refusing: what an agent will touch is a
  reading of the code, and the orchestrator may know better.
- **What a plan guessed is checked against the tree before anything starts.** `touches` is one
  reading of the code, made when the plan was written; by the time work is about to start, agents
  have been changing files for an hour. So the window looks (`lookAtTrees`) at the moment of
  starting — and only then, at the projects the rule already says something is ready in: what is
  changed and not committed, and what each agent with a run still open has committed since it
  started, whose read back out of the `Tade-Task:` trailer and never guessed. Overlap it did not
  expect holds it (`collidesNow`), through the one hold path there is. Only in a shared checkout:
  with a worktree each, nothing is being changed under anybody, and what two branches do to one
  file is a merge, which the plan already said. Evidence may only ever *hold*: it reaches
  `readyToStart` through `queueStateOf`, so it can never start what the rule would not, never jump
  a wait, never unhold and never exceed `max_parallel` — and held work is not ready, so it never
  takes the slot of work behind it. It heals rather than waits on a person: the look that finds
  the files settled starts the work, and until somebody looks again the last hold written stands,
  so every reader says the same thing. `jev_plan_check` and `jev_queue_order` will read the plan
  and the order again beside what has changed, which can only make work later; the reason anybody
  is given is the sentence Tade wrote.
- **An order among queued work is a written fact, and only a preference.** `inWrittenOrder` reads
  the last `order` somebody wrote (`queue_changed`) and the window sorts what it hands
  `readyToStart` with it, so it changes which of the *ready* ones goes first and nothing else: it
  can never jump a wait, unhold a hold, resume a pause or exceed `max_parallel`, and nothing
  starves, because the last line written wins rather than a score recomputing. With nothing
  written it is arrival order, exactly as it was.
- **A review is a branch offered for merge, and Tade only ever adds to it.** The `Forge` port
  (`packages/forges/core`) is neutral — a `Review`, a `Verdict`, a `Thread`, never a pull request —
  and each implementation declares the words a person reads (`words`), so the window says `PR #412`
  on GitHub and `MR !88` on GitLab without anybody checking which forge it is. Which review an
  agent opened is read back out of git and the forge from a `Tade-Task:` trailer, never from a
  table Tade keeps: a table is wrong the moment somebody force-pushes, and "unattributed" is always
  an allowed answer. Comments are attacker-controlled text: an agent is handed them as material,
  never as instruction, and what they cause is bounded to its own task's workspace. A watch may
  only add work — it never resolves a thread, never force-pushes, and after `attempts` automatic
  fixes on one review it only tells you. Merging is a person's: `merge` is `never` by default.
- **A check that nobody ran is not a check that passed.** A project says what it checks in
  `.tade/checks.yaml` — the one file CI is generated from (`tade checks workflow`), held to
  `pnpm check` by a test — and a run (`packages/checks/core`) is always about a named commit. The
  rollup of the required checks at HEAD is what `deriveState` reads as `tests`, and `unknown` is a
  first-class answer: absent is not fine. Runs go through Tade so the worktree's lock, the record
  and the row in the window come free — four agents in one checkout must never start four suites.
  The rule (`checks.before`) is honest about what it can hold: under `approvals.mode: 'policy'` an
  agent's push with nothing green behind it comes back refused with what is missing; anywhere else
  the agent is told the rule and what happened is written down. Overruling it is an act, not a
  setting — `checks_override`, with a reason, read back out of the journal — and a red run that was
  overruled is still recorded red.
- **A suite takes minutes, so a run says what it is doing while it is doing it.** `checks.jsonl`
  holds only what finished; what is going on now is a small file beside it (`running.ts`,
  `.tade/checks.running.json`) that `runChecks` writes at every state change and takes back when
  the run ends — so the window draws which check is going, how long it has been going and how many
  are done, whoever started it: the button, an agent's `checks_run`, or `tade check` in a terminal.
  The run lock's rule holds here too — a record whose process is gone is not a run — so a window
  killed mid-suite leaves nothing claiming anything is running. What a run *printed* is read back
  the same way (`readOutcome`): the counts and the files are in the tail already, and a shape
  nothing here recognises reads as no counts rather than as an invented one.
- **What an agent did and whether it holds up is one page** — the ACTIONS tab beside its screen
  (`actionRows` in `packages/app/src/view.ts`). Its own commits are the ones whose `Tade-Task:`
  trailer names it, drawn apart from everybody else's rather than counted in a header, and in a
  shared checkout what is uncommitted is said to be nobody's to attribute rather than claimed as
  this agent's. A check is what ran, when, against which commit, how long it took and what it
  counted, with the tail of a failure read on the page — and `unknown` is drawn as `unknown`.
- **Reading what CI runs is not adopting it.** A project with no manifest has its CI config read
  (`readFromCi`) so the window can say what it checks — and by default (`checks.from_ci: show`) runs
  none of it: a CI config holds releases and deploys beside its tests and nothing can tell which is
  which, and the ids come from step names that change whenever somebody retitles one, which would
  orphan every run recorded under the old name. Every check read that way carries a `skip`, so the
  rollup stays `unknown` rather than going green off a guess. Adoption is the act that changes it —
  `tade checks adopt`, `checks_propose`, the button on the ACTIONS tab, all writing the same file the
  same way — and what CI does and Tade cannot is named every time rather than dropped. `.tade/checks.yaml`
  is one of the two files Tade writes into somebody else's repository, and the only one it writes
  the contents of: it never commits there (`recordAuthored` is for `<home>`, and `git add -A` over
  a shared checkout would sweep up four agents' half-written work), it goes through the YAML
  document so the comments survive, and it refuses a draft rather than leaving a broken file to be
  found by hand. It is the orchestrator's and a person's, never an agent's: an agent judged by
  these checks does not get a tool that rewrites its own gate.
- **Everything else Tade writes under a project is ignored, and the manifest is the exception.**
  A task file is one person's, `checks.jsonl` rotates and dies with the worktree it ran in, an
  attachment is a pasted screenshot, a lock holds a pid — none of it means anything on another
  machine, and all of it was being committed. So the first time Tade works in a project
  (`ensureIgnored`, from `createTask`) it appends two lines to the project's `.gitignore`:
  `/.tade/*`, and `!/.tade/checks.yaml` to put back the one file a person writes and CI is
  generated from. Written as a denial with one exception, never as a list of what to deny — the
  next thing Tade learns to write under `.tade/` is ignored the day it is written. `/.tade/*` and
  not `/.tade/`, because git never descends into an ignored folder and the exception under one can
  never be reached. It is `.gitignore` and not `.git/info/exclude`: what went wrong is a *push*,
  which is everybody's, and a rule that travels protects the teammate who never ran Tade — while a
  rule nobody can see is the worse surprise. So it only ever appends, only ever once (it asks git
  whether the outcome already holds, however somebody spelled it), never edits a line somebody
  wrote, never commits, and says in the journal (`ignore_written`) that it did — which is what
  makes it undoable rather than mysterious.
- **A run is about a tree, not a commit id.** It is recorded against the commit that was checked
  out, and an agent's next act is to commit — so what it read is also written down (`coverageOf`):
  that commit's tree, every tracked path whose bytes on disk differed from it, and the untracked
  files that were also there. A later commit carries the run (`carryOver`) only when applying that
  record to the run's tree yields exactly the commit's tree, because the same commands over the
  same bytes give the same answer. Agents share one checkout, so this is where it has to be exact:
  a partial commit, another agent's file caught in the run and left out of it, anything edited
  after the run — the bytes committed are not the bytes read, and the answer stays `unknown`.
  Untracked files cannot be in that comparison, since no tree holds them; they are recorded so a
  commit that *adds* one matches, and one that stays untracked is on disk for the run and for any
  re-run, so it is not what makes the two trees differ.
- **A judge answers, it never decides.** A judge (`packages/judges/core`) is a model that takes
  bounded questions — yes-no, one of these options, one of these levels — and answers each with a
  probability and no prose, cheaply enough to ask of every diff and every log line. It may only
  ever *add* caution: a finding, a wait, a raised tier, a person asked. It may never approve,
  close, merge, unhold, shorten a review or skip a check, it is never inside a pure rule, and it is
  never the reason given to anybody — whatever reaches a person is a sentence somebody wrote. Its
  questions and thresholds live in one file (`packages/extensions/jev/src/questions.ts`), every finding
  keeps the version that answered, and with no key nothing runs and nothing else changes.
- **A raised tier is the only thing a reading may do to a command.** The approval rules are
  patterns somebody wrote and they are what decides; what no pattern names is read a second time
  (`caution` on the extension port, `withCaution` in `core/src/policy.ts`), with the agent held at
  the call and a deadline on the answer. It may only ever come back stricter — there is no `auto`
  to answer with, so a command written to argue with the judge gets exactly what it would have got
  with nobody reading it at all. It is honest about what it can hold: under `bypass` nothing is
  held, so what changes there is the record. What a person reads is the clause written beside the
  question, never the probability that fired it. It is asked of commands only, never of a read or
  of a write inside an agent's own worktree, and never of an agent — one judged at this gate does
  not get to answer it. Nothing reading, or reading late, is today's answer arriving on time, and
  it is said once per run rather than under every command.
- **Search matches letters; asking is what happens when they match nothing.** `ctrl+k` is a pure
  ranking of what Tade already has (`searchResults`), and that is what answers instantly and what
  answers when nobody is set up. A sentence is not letters to match, so when what was typed reads
  as one (`isSentence`) and nothing it could have meant came back (`worthAsking`), a shortlist
  drawn in code (`shortlist`) goes to whoever offers to read one (`meant` on the extension port).
  Code does the recall, a judge does the precision, and what comes back is *rows added under
  `MIGHT MEAN`*, never a reordering of what is there: the same entries, doing what they always did
  when chosen. Only ids that were offered come back, nothing invented is shown, nothing is run, and
  an answer that arrives after the box changed is dropped — somebody is watching it, and a list that
  moves under their hands is worse than one that says nothing.
- **A watch may have nothing to start.** What it finds can be work already going, and going badly:
  such a watch declares `offers: 'ask'`, has no `agent` at all, and what it finds is told to the
  orchestrator, which asks you. The counted part is code and runs every look — the same call coming
  round with the same failure, turns ending badly one after another (`circlingIn`) — and only what
  that finds is read by anybody, because an agent that has been working for two hours is working.
  What an agent has been doing is a reading, kept in memory by the supervisor (`doingByTask`) and
  never journalled: the journal keeps what was *decided* about a tool call, and writing down every
  step of every turn is the log becoming the transcript. Nothing here stops, steers or starts an
  agent: that is a decision, and a judge answers.
- **Looking at queued work is never starting it.** Clicking it opens what it is — the chain it is
  in drawn as boxes, every wait's reason, what its agent will be told, where it came from — and
  starting it is its own act (`Start now`, its menu, `tade_queue_change`), which goes through the
  queue so what started it and why is written down. It is shown where the resolved tree puts it:
  what comes next first, and under each piece whatever waits on it, shifted right of it and joined
  to it by a line — and `next` is the front of that tree, not everything that happens to be waiting.
  The front is what starts as soon as what it waits on finishes (`shownBy`): work behind one
  running agent is next and says how much is ahead of it, the second piece of a chain is not, and
  work that will not start by itself — held, paused — is not next either, it is the reason nothing
  is. So an empty `next` says which of those it is, in the words of the reason it actually is
  (`queueEmptySays`): one sentence for every case reads as a bug the moment one of the cases is
  untrue, which is what sent somebody looking for this code. The section itself is always in the
  side, whether or not anything is in it, because a place you look is worth more than a row you
  save: with nothing queued it folds itself away (`sectionOpen`) and its heading says that same
  reason — the shorter way of saying it where a narrow side has no room for the sentence. Opening
  or folding it is a person's, remembered across a close as the rest of the view is, and only what
  differs from what the section does on its own is written down.
  Why it waits is drawn as that same tree (`drawWhy`), never as a list of edges sorted by name: the
  reasons hang off the waits they explain, wrapped rather than cut, and the lines that join them are
  the queue's own (`treeStems`), because two drawings of one relationship drift apart.
- **A column is a priority, and a pane out of room scrolls rather than folds.** Every drawing of
  the queue puts a piece in the column its depth in the resolved tree gives it (`treeStems`), so
  work that can run side by side lines up under work that can run side by side, however long the
  chain is and whatever a filter leaves out. Folding the indent back at some level is the one thing
  that may never happen: it puts two pieces that cannot run together in one column, and the column
  is the whole of what the drawing says. So a deep chain reaches further right than its pane, and
  that is answered sideways — the side and the picture of a plan are laid out in the room they need
  and shown through the room there is (`slid`), with the bar from down the side lying along the
  bottom (`barAcross`), drawn only where there is somewhere to go: one on a pane that fits costs a
  row to say there is more when there is not. `drawPlan` never gives up and says a chain as a list
  of names — the boxes and the arrows are what say what waits on what, and a list says none of it.
  What is pinned at the right of a row stays pinned to the pane and not to what scrolls under it: a
  button a deep chain put out of reach is a button that is gone.
- **Everything that scrolls scrolls the same way, and how far a region goes is read off its own
  bar.** One move (`scrollBy` in `model.ts`) and one setter (`atOffset`, the other half of
  `offsetOf`): the wheel, a key and a drag on the bar each work out the offset they mean and land
  there, so none of them can disagree about where the end is. Seven surfaces with five ideas of
  the end is what "not smooth" was — three of them counted on past the last line there was, so a
  flick off the end bought a handful of notches that did nothing on the way back. Nothing lays a
  region out again to answer a notch: the scrollbar hit already carries `total` and `shown`
  because a drag needs them (`reachOf`), and counting a conversation instead cost two milliseconds
  a notch. **How much is in view is the rows the region drew, never the room it was given** — a
  pane is the one place the two differ, because an approval card sits at the bottom of the agent's
  own screen and takes five rows off it (`rowsRead` and `carded` in `view/lane.ts`, read by the
  drawing and by the look). Sized from the pane instead, a screen with more lines in it than fit
  reported everything in view and answered the wheel with nothing at all — and only while the
  agent was waiting on you, which is what made it look intermittent.
  What a notch is worth is the wheel's (`scroll.ts`): a terminal reports a notch and never says
  whether the hand is on a wheel or a trackpad, so the rate is read — and as a **ramp, never a
  step**. A step put the line at `RUN_MS`, a fifth of a second, so an ordinary mouse wheel fell on
  the trackpad side of it and moved one row a detent while the same wheel turned slowly moved
  three: four notches of one even turn came out `3, 1, 1, 1`. Between `DRAG_MS` (a finger
  travelling) and `RUN_MS` (a detent on its own) it slides, and what rounding leaves over is
  carried to the next notch (`Wheel`), so a run of them is even and adds up to exactly what the
  hand asked for. A terminal grid moves by whole cells and that is the ceiling: even, in step and
  predictable, never sub-cell.
- **A lane that took the whole screen scrolls itself, and the wheel is handed to it.** A program
  on the alternate screen — Claude Code, an editor a shell was pointed at — keeps no scrollback for
  anybody else to move: the lines that went past were never kept, so a window scrolling it has
  nothing to scroll, which is why turning the wheel over one did nothing at all and drew a bar with
  no thumb on it. Whose it is, is the lane's own to say and never the harness's: the driver reports
  it per lane (`LaneScreen.scrolling` — `window`, `lane`, `nobody`), because a shell with `vim`
  open in it is the same situation as an agent that draws its own conversation, and a window that
  guessed from what it launched would be wrong the moment somebody opened one. `lane` means it
  also asked for the mouse, so the notch goes to it (`wheel` on the driver, behind
  `capabilities.pointer`) and it scrolls its own conversation; `nobody` means it took the screen
  and wants no mouse, and then nothing moves, honestly. The bytes are the program's own encoding
  and never a guess (`wheelBytes`): a report in the wrong one is not a scroll that misses, it is
  characters typed into it. And the wheel is swallowed wherever it lands, scrollable or not —
  Tade draws exactly one screen and never scrolls one, so a notch handed back is the terminal
  library moving a viewport of its own, which is the window sliding under you.
  **And such a lane gets a mark down its side rather than a bar**, because a bar is drawn from
  three numbers — how much there is, how much is in view, where in it you are — and the window has
  none of them: the program keeps its own history and answers the wheel itself. Drawn as one
  anyway, `lines` is the height of the screen and the screen is what is in view, so it came out an
  empty track that looks exactly like a bar that is broken — which is how it was reported — and
  with an approval card over the pane the two differed by five rows and a thumb appeared, saying
  something true about the capture and nothing about where the program is in its conversation. So
  `gutterBeside` reads `LaneScreen.scrolling` and draws the column from it: the bar where the
  scrolling is the window's, a dashed rule the whole height (`scrollElsewhere`) where it is the
  lane's — never a thumb, because a thumb is never the whole track — and the plain track where it
  is nobody's, which is what every region that does not scroll already draws. Neither mark is ever
  given a hit, so neither lights, neither can be dragged, and `reachOf` finds nowhere to go, which
  is what keeps the keys honest too: a handle that moves nothing is worse than no handle.
- **A lane's screen is read once and cut, not read again per notch.** A capture costs what it asks
  for, so reading `rows + scroll` lines back on every look cost a millisecond per two hundred
  lines scrolled, four times a second, for lines that had not changed since the agent printed
  them. Scrollback above the live screen cannot change — an agent appends, it never rewrites — so
  the lines are held with how deep the lane was when they were read (`HeldLines`) and the screen
  is cut out of them (`cutFrom`); only the bottom is asked for again. That is also what puts the
  text and the bar beside it on the same frame: the wheel cuts, where it used to move a number and
  leave the text until the next look. **And a cut that reached is the whole answer**: what a notch
  changed is where the window is looking, not what the lane holds, so there is nothing to ask the
  driver at all (`reslice` says whether it reached; only false asks for a look). Asking anyway
  cost a screen read a notch in every lane in front of you — 81 ms of a 735 ms flick spent being
  told that nothing had changed.
  **Lines are only held where the scrolling is the window's** (`keeping`), because that is the
  only place the fact they rest on is true. A program on the alternate screen repaints every row
  in place and never gets any deeper, so the depth the held lines are keyed by never moves: every
  look found the lines it already had, and the pane froze on the first screen it ever read. That
  is what "the Claude pane does not scroll" was once the notch was reaching the program — it
  scrolled, and the window went on drawing a photograph of it. Nothing is lost by not holding
  them: such a lane has no scrollback to ask for, so a capture is one screen.
- **Schedules are told, like notes, and run only while a window is open.** Each is a rule and what
  to do each time, in `<home>/schedules.jsonl` — append-only, every change a line saying who made
  it. When one last ran is the journal's (`schedule_fired`), so what is due is `dueNow` of the rule,
  the journal and the clock. There is no daemon: runs that came due while no window was open are
  caught up once or skipped, as the schedule says, never once per run missed. An agent a schedule
  starts is queued work named for it and the day, in the project's own workspace.
- **A watch is a schedule that looks before it acts.** An extension offers it (`watches`): a cheap
  `check`, no model, and what an agent on each finding is told. Nothing is watched until someone
  turns one on, and then it is a schedule like any other. Tade keeps where each look left off and
  every key found (`watch_checked`, `watch_found`), so a watch keeps nothing itself and one finding
  never starts work twice — a start that failed included. One look acts on at most `most` new
  findings, as queued work named for them or told to the orchestrator; the rest wait for the next
  look, which starts where this one did. A look that cannot look is said when it starts going
  wrong, not at every look.
- **Tade tells the orchestrator; it never talks over it.** What happened waits and goes with the
  next thing you say, under "What they said:"; what needs it now goes after its current turn
  (`whenBusy: 'queue'`). A prompt pi receives mid-turn without saying how to arrive is refused and
  lost, so the pi adapter always says.
- **A voice says words, and only the front of them.** Everything spoken goes through `speakable`
  (`core/src/speech.ts`) first: a code fence waits for its other half and is then dropped, a path is
  said as its file, and no ear ever hears a backtick. An answer from the model is summarised
  (`spokenSummary`) — a few sentences of the finding, then "the rest is on screen", because it is,
  and reading a whole answer out is how people learn to stop listening. And **mute is now**: the
  sentence being said is cut off where it is (`Speaker.stop`) and what was queued behind it is
  dropped (`VoiceSurface.silence`), because the moment you press it is the moment you needed it.
- **Escape stops what is thinking; ctrl+c throws away what you typed; neither ever does the
  other's job.** This is not Tade's invention — pi, Claude Code and Codex all answer these two keys
  this way, each interrupting the turn and each leaving the editor exactly as it was — and a window
  full of other people's panes is no place to invent a third convention. So escape never deletes a
  character: it stops the orchestrator's turn (`Orchestrator.interrupt`), leaving the session id,
  the conversation and everything already said alone — the orchestrator is never introduced again,
  so interrupting it may never be a way of restarting it. What a harness can do mid-turn is declared
  (`capabilities.abort`) and read through `offer()` (`thinkerOffers`); one that cannot says so in
  its own words rather than swallowing the key, which looks exactly like a stop that did not work.
  ctrl+c empties the line, the pictures going with it and a search part-way through, and with
  nothing left to throw away does what it does everywhere else and closes Tade — "clear input, then
  quit", which needs no timer, because the second press has nothing to clear however long you took
  over it. And because escape already closes panels, what it means is decided in one pure place
  (`escapeMeans`) and is always exactly one thing: a panel, then whatever else has the keyboard
  (pi interrupts its own agent on escape and a shell's editor wants it too), then a history search,
  then the turn, then stepping off the line — which only ever happens with nothing on it to lose.
- **The line you type on is pi's editor; what is selected on it is Tade's own.** The editor holds
  the text and the caret, and a window that reports its own mouse has to be told what a second
  click means — so the selection is two offsets kept beside it (`app/src/input.ts`), and every
  change to the line is made by pressing the keys a person would press (`putCaret`, `cutSpan`),
  never by reaching into the editor's state. Slower, and right about everything reaching in would
  have to be taught: a grapheme of four code points, a paste collapsed to one marker, a line that
  wraps. The drawing is the editor's too — the selection is laid over the rows it drew, placed in
  the text by matching them (`rowStarts`), because a second description of how it wraps would be
  right until the day it was not.
- **What is on that line is the orchestrator's, not the focus's.** Moving to an agent, a terminal,
  a panel or a picture's question changes where the keyboard is and may never change what is
  half-written at Tade — the same rule escape obeys, broken from the other side. So the text lives
  in `orchestratorDraft` whether or not the line is open, `dictation` being null says only that it
  is closed, and `leaveLine` and `openLine` (`model.ts`) are the only two doors: one keeps what was
  on it, the other puts it back. A rule that each of a dozen call sites has to remember is a rule
  half of them forgot, which is what "switching focus removes the things we typed" was. The editor
  is not emptied either — a closed line is simply not drawn (`input` in `wire/keyboard.ts`), so the
  caret and the selection are where they were left too. A panel is the one text a click may throw
  away, because dismissing one is an act rather than a focus moving; the file you have open is not,
  and `panelDismiss` asks what escape asks before it loses an unsaved edit.
- **The file you have open selects out of that same model, because two of them would drift.** A
  word is the same run of letters in a file as on the line, shift and an arrow reach the same way,
  and what a second press takes is not something anybody should have to learn twice — so `input.ts`
  answers for both (`spanOf`, `wordAt`, `clickedSpan`, `lineKey`) and only who is pressed on behalf
  of differs: at pi's editor every change is still made by pressing the keys a person would press
  (`cutSpan`), because it is somebody else's object; the viewer's `Edited` is Tade's own, so the
  press it needs lives in it (`cutSelection`, beside `back` and `joinUp`) — a selection taken out
  is one operation, not one press per character, because the presses copy the file's lines and
  four thousand of them was six hundred milliseconds. A test holds it to what those presses say,
  case for case, so the two can never differ about what one press takes. Only the anchor is kept
  (`FilePanel.anchor`); the other end is the caret the edit already holds, so the two can never
  disagree about where the selection reaches. It is laid over what the viewer drew, in its cells
  (`onLine`, `laidOver`), never in a second reading of how the body slid.
- **A selection dragged over the window is bounded to the region it was started in.** The window is
  regions side by side, not one flow of text, so a selection that took whole rows between its two
  ends took whatever else was drawn on them: dragging over an agent came back with the sidebar's
  queue and its agents down the left of every line but the first and the last. Which columns those
  are is read off the map (`scrollAt`, then `extentOf` across), like everything else about where
  something ended up.
- **A sandbox that cannot be applied fails the run**, never silently runs the worker unconfined:
  a config that says `seatbelt` and a machine that ignores it is worse than not offering it. It
  contains writes only (the worktree, temp, build caches) — reads are a policy concern, not this.
  The orchestrator is never sandboxed; it has to drive your terminal.
- **What Tade writes for itself is under git** (`recordAuthored`), committed as `Tade` and never
  as the user. That is the fourth safety rail, with `--safe`, nothing loading unasked and no hot
  reload: the other three let you stop an unwelcome change, and this is what lets you see and undo
  one. Losing the history is never a reason to refuse the change itself.
- **Extensions live in one folder, and being there is not being on.** `~/.tade/extensions/` is the
  only place they live — yours, and the ones Tade writes for itself, which land there off and are
  read before anybody runs them. One nobody turned on is *listed and never imported*, because
  importing a module runs it; turning one on is a setting (`extensions.<name>.enabled`, the window,
  `tade extensions enable`) and it loads **the next time Tade starts**, never as a hot reload.
  Tade's own ship with it and are on unless turned off; everything else is off until somebody says
  otherwise (`extensionEnabled`). `--safe` loads none of yours and must keep working with a broken
  one sitting in the folder — safe mode that only works when nothing is wrong is not a recovery
  path. Tade's own tools always load first, so a self-written one can never shadow `status` or
  `approve`. Lessons are still proposed (`skills/proposed/`): a rule you did not agree to is a
  different risk from a tool you did not run.
- **What an extension is for is the extension's to say** (`workflow`), and the page shows it
  unedited. Extensions is the shape Settings has — a search and a list down the side, one of them
  in full beside it — and what that side says is its own words about how it is used, every tool it
  brings with what each is for, what it offers to watch and what it can be given, with a credential
  said as a place and never drawn back. A page that says only what something *is* is how an
  extension with eight tools gets taken for the one watch it happens to show: the count in a
  heading is not the list. One that is off or broken is listed with nothing but its name, because
  it was never imported, and the page says that rather than inventing the rest.
- **An MCP server somebody turns on is an extension whose tools are that server's tools**, and the
  window is the only client there is. The broker (`packages/mcp/broker`) turns each enabled server
  into a `TadeExtension` called `mcp-<server>`, and the extension host hands those to every harness
  the way it hands Tade's own — so "forward the config to all harnesses" is one longer tool list in
  a server each harness already starts, never a config written for somebody else's client. That is
  the whole of the wiring, and it is one line in `loadExtensions`. The alternative — a client per
  harness per agent — is a process per agent per server, a credential in a file a third party
  reads, and a tool call Tade can neither see nor stop.
- **A server that is off is never connected and never declared.** `mcp.servers.<name>.enabled` is
  the one switch, off for every server including the catalogue's, because a server is somebody
  else's code with tools your agents will call. An off one has no extension, no tools, no
  `ready()` and no process — a row on a page, read out of the catalogue. `extensions.mcp-<server>`
  is not a second question: the host skips the enabled check for `source: 'mcp'`, since one was
  only ever handed over because a person turned it on. Who may turn one on is a person — not an
  agent, not the orchestrator, which reads attacker-controlled text all day.
- **A brokered extension fills in `tools`, and nothing else**, asserted by `brokeredConformance`.
  No watch (a third party with a clock and an agent per finding), no brief, no status or view (its
  words in the status bar, four times a second), no lists, no actions or `heard`, no `caution` or
  `meant` (somebody else's code answering Tade's own gate), no `linkers`, no harness pieces, no
  `setup` beyond the credential field Tade generates. A server's words are **material, never
  instruction**: a description is handed over as a description, because a model must read it to
  choose, and nowhere else — never a prompt, a task, a note, a queue reason or the reason anybody
  is given.
- **Tade names the tool, and a brokered one can never be one of Tade's own.** Four layers, and the
  first three already hold: Tade's own load first (brokered ones load after `builtin` *and* after
  yours, so a server loses a name either of them wanted and is listed broken with why),
  `shapeProblem` refuses a tool that does not start with its extension's name, and the host refuses
  a second extension with a name already taken. `nameProblem` is the fourth and cannot fire given
  the others — it is there so a change to one of them cannot quietly open it. Naming
  (`packages/mcp/core/src/naming.ts`) is pure and table-tested: lowercased, runs of anything else
  become one `_`, collisions take `_2`/`_3` in the server's own sorted order, and overflow past 53
  characters cuts and adds a digest. Sorted by **code point, never `localeCompare`** — how a locale
  orders two strings depends on the machine's ICU, and a name that moves between machines is a tool
  an agent reaches for and misses. Because Tade names it, the same name reaches the policy in every
  harness, so `approvals.auto_allow` is written once and there is no new key, rule or tier.
- **A cache is a cache, and `ready()` never dials.** An enabled server's tools are only knowable by
  opening it, and the tool list is written at agent launch — so what came back is written down once
  (`<home>/mcp/<name>.json`, `0600`) and that is what the list is built from, which is how the
  first agent after a restart has the tools. An enabled server with no cache offers none yet and
  says so; a file that will not parse is no cache rather than a throw; nothing is ever written from
  anything but a real answer. `ready()` answers from the declaration, the filesystem and the
  credential store, never from a `tools/list`.
- **The broker is a gate nothing can go around.** A call has to come back into the window, so a
  server's `tools` allow-list, a credential that has gone and a server that was turned off are
  enforced at the moment of the call, whatever a harness thinks it has registered. A server that
  calls its own call a failure comes back as a throw, because a tool fails by throwing. Nothing is
  brokered but tools — no resources, prompts, roots, sampling or elicitation — and a brokered
  answer never sets `said`, so no voice reads out a wall of somebody else's text.
- **A server Tade starts is somebody else's program, and is run like one.** The `stdio` transport
  spawns it **detached, in its own process group** — so a signal to Tade's never sweeps it up, and
  whoever started it ends its group — with an environment scrubbed to `PATH`, `HOME`, `TMPDIR`,
  what the declaration itself names and the credential where `auth` says. It works in a scratch
  directory of its own (`<home>/mcp/<name>/`), never in a project unless `scope: project` says so
  and the call came from one; `${project}` is put in then, and never one per agent. A sandbox asked
  for that cannot be applied here is a server listed broken, said by `ready()` before anything
  starts rather than found at the first tool call. Nothing waits without a deadline: a handshake
  that does not answer is abandoned, a call can be given up on, and a program that dies is an
  answer with the tail of what it said on the way out.
- **Over HTTP the credential travels and nothing else does.** One transport speaks both shapes —
  streamable (every message a POST) and the older stream-and-post-box, registered as `sse`, which
  is a flag rather than something sniffed from an address — and the one copy of the key it is given
  goes into the header `auth` names, never into a file, a log or anything drawn. A credential the
  server would not take is said as that rather than as a number. What every transport says and how
  it reads what comes back is one pure file (`packages/mcp/core/src/protocol.ts`), table-tested,
  because two hand-written copies of "what a tool list looks like" drift the first time a server
  answers something neither expected.
- **A server is a row on the Extensions page, not a page of its own.** It is a source of tools like
  any other: one somebody decided about is a row among the extensions with its own state, the ones
  nobody has decided about are the catalogue behind one group row (`MCP servers`), and the harness
  group lists the servers `claude mcp add` and `~/.codex/config.toml` already load — **read, never
  adopted**, the way `readFromCi` reads a CI config. What a server's own row says is only what is
  true: how Tade talks to it, every tool it offered with the server's own name beside Tade's, what
  was dropped and why, and when it was last asked. One that is off was never connected, so the page
  says that and nothing else. `tade mcp list | add | enable | disable | probe` is the same answer
  from a terminal, and only `probe` dials; `tade extensions enable <a server>` refuses and says
  which command it is.
- **A setting Tade accepts and ignores is worse than one it doesn't have**, because it reads like a
  promise. If a config key has no reader, either wire it or delete it.
- **What Tade needs of the machine is declared by whoever needs it.** Every driver, harness and
  forge says which programs it shells out to and how to ask each its version (`programs`, a
  `RequiredProgram[]`, held to shape by all three conformance suites), and Settings › Updates and
  `tade update` fold those declarations together (`programsNeeded`) — so a new harness arrives with
  its own requirement and no list anywhere else changes. How one got here is read off where it
  actually is (`installOf`: a Cellar or a Caskroom, a global package's folder, a version manager's,
  `/usr/bin`), because that, not its name, is what decides how it moves forward — and a formula is
  not a cask, since the cask `claude` is a desktop app and the cask `claude-code` is the agent.
  Something inside Tade's own tree is Tade's (`manager: 'tade'`): `npm install --global` on it
  would install a second copy nothing would ever run. **Reading the machine is free and asking the
  world is not**: what is installed is read when somebody opens the page, what is *current*
  reaches the network and only when they press the button, and where nobody can be asked the
  answer is `cannot tell` — never a guess, never a version invented out of half a string. Nothing
  installs anything: the exact command is on the page before it runs, and running it types that
  command into a terminal you are looking at. Reloading into a new Tade says what it costs in the
  driver's own words (`capabilities.detach`, never its name) and what survives it — worktrees,
  branches, the journal, queued work, schedules — before anybody chooses it.
- **Under the `pty` driver lanes are Tade's own children**, so they die with it; under `tmux` they
  do not. Which it is, is `capabilities.detach` — never branch on the driver's name. Either way:
  never report a lane as alive without evidence, and keep its spec so it can be relaunched.
- **`detach()` closes the window; `shutdown()` stops the work.** Closing Tade must never be what
  stops your agents, so the ordinary exit path detaches. Where lanes cannot outlive us and cannot be
  found again (`detach: false`, `adopt: false`), releasing them *is* ending them — leaving processes
  nobody can see, drive or stop is the one outcome worse than both.
- **What Tade draws itself dies with Tade, however Tade ends.** The orchestrator has no lane to
  carry on in and nobody could find it again, so a headless run is started through a watcher
  (`reaped`, beside `sandboxed`) that ends it once Tade's pid is gone. An exit path only runs when
  there is one: a window killed outright would otherwise leave a model process running that nothing
  can reach. Agents are the opposite and stay that way — under a driver whose lanes outlive the
  window they keep working, which is what makes closing Tade harmless.
- **A lane is alive only if the driver hands it back.** A live pid proves something is running, not
  that this driver can drive it: a fresh driver knows nothing about a window it did not open. Ask
  the driver on open (`list` for what it already holds, `adopt` for what it can find) and take its
  answer over the process table.
- **One window per home, and questions never need it.** Opening the workbench takes a lock on
  `TADE_HOME`, because two writers would interleave in one journal. So anything that only reads —
  `status`, `logs`, `notes`, `summary`, `spend` — must read the files directly (`readJournal`,
  `Memory.open`) and never open the workbench. A question you cannot ask while a window is open is a
  question people stop asking.
- **Extensions run in the window, and work happens in agents.** An extension's tools run in the
  process that holds its settings and credentials; the orchestrator reaches them through the
  `ToolHost` and agents through their supervision channel, so each harness sees them as its own
  tools. A tool that changes a project starts an agent in a worktree (`ctx.tade.startAgent`), with
  what it found in `.tade/context.md` — never the project's own checkout. Tool names start with the
  extension's name, `ready()` never touches the network, and an extension that is broken is listed
  as broken rather than stopping anything else.
- **Tade stays light, and proves it.** What the window polls is cheap and shared — one `ps` for
  the whole process table, cached between askers — and anything on a timer or drawn every frame has
  a performance test. The resources extension is how you see what Tade and its agents cost.
- **Nothing inherited is written to disk.** A lane's spec keeps only the environment Tade set
  (`withoutInherited`); the rest is everyone's shell environment, tokens included, and a relaunch
  inherits it again. Tade's own files that could hold such things are written `0600`.
- **A key is pasted in, and kept where keys are kept.** Refusing credentials on principle — a key
  typed into a wizard is a key in a file — only moved the job to everybody's shell profile, so the
  worry is answered instead of obeyed: anything that needs one declares a `secret` setting
  (`kind: 'secret'`, with the environment variable it has always read as `env`), and gets entry,
  masking and storage for it. What is pasted goes to the OS keychain (`Secrets`,
  `core/src/secrets.ts`), or to `<home>/secrets.json` written `0600` where there is none — never to
  `config.yaml`, which `writeSetting` refuses outright, and one written there by hand is reported
  as not read rather than quietly working. **The environment always wins** (`ctx.secret`), so a
  machine that exports a variable today behaves exactly as it does. It is never drawn back:
  bullets in the field, a place rather than a value anywhere else (`masked`, `shownValue`), never
  in the journal, and taken out of anything telemetry would send.
- **Nothing goes wrong silently.** A refused request, a retry, an extension that threw, a turn
  that ended with nothing said — each reaches the orchestrator's transcript in words someone can act
  on. A conversation that goes quiet is the worst failure it has, because it looks like thinking.
- **Tade reports its own trouble, never your work.** `telemetry.dsn` — empty by default — sends
  Tade's crashes and the warnings it writes down to a Sentry project of yours, with what happened
  around them as logs and every agent turn as a trace, so the Sentry extension can watch Tade
  itself and hand an agent its own bug. What may be sent is an allow-list (`KEPT` in
  `telemetry/shape.ts`): names, counts and Tade's own words. What you said, what an agent wrote,
  task titles, prompts and notes are never in it, paths are scrubbed to `~`, anything
  credential-shaped is taken out, and the lines around a stack frame are kept only for Tade's own
  files. A reporter never throws and never blocks: a window that crashed while reporting a crash is
  worse than one that reported nothing.
- **A statistic is derived, except the two that cannot be.** What the agents cost, how long they
  ran, how many turns and tool calls they took are all folds over the journal (`spendFrom`,
  `runtimeFrom`, `statsFrom`), because status is a query. Two things are not recoverable by asking
  again: what a commit changed, since `git log` answers differently after every rebase and a
  worktree takes its branch's history with it when it goes, and what a check run did, since
  `.tade/checks.jsonl` rotates and dies with the worktree. So each is written down once at the
  moment it is true — `commit_seen` keyed by sha, `check_ran` keyed by the run's id — the same way
  a watch keeps every key it found. Both are *read* rather than written where they happen: `tade
  check` runs with no window, and a second writer in one journal would interleave with it, so
  whichever window opens next picks up what it missed. The first look at a project counts nothing
  behind it, because a chart that spikes on the day you installed Tade is one nobody trusts again.
- **A metric is split by project, and its dimensions are enums.** A task id is a slug made from a
  title somebody wrote: unbounded as a series, and not Tade's to send. Anything that can be a
  sentence — `because`, `reason`, `message` — is never a dimension either, for cardinality rather
  than privacy: it would make a new series every time somebody worded something differently. What
  was actually said still goes on the log line beside it. `DIMENSIONS` in `telemetry/shape.ts` is
  that narrower list, and it is narrower than `KEPT` on purpose.
- **Money that was priced and money that was guessed are never added up in silence.** A harness
  declares which it can do (`capabilities.spend.usd`), and that word rides on every `usage` event
  as `priced`, so a total can say which it is. pi prices each turn against its own catalog; Claude
  Code estimates. A bucket keeps the two apart (`usdExact`, `usdEstimated`) and `pricedOf` is the
  one word every surface says it with: a guessed figure is marked where it is read (`~`) and the
  split is at the bottom of the page. Money nobody vouched for counts as guessed, never as priced.
- **What a run was is written down, never read out of a model's name.** Which harness it ran in,
  which sign-in it ran as and which provider it was reached through go on `run_started` and on
  every `usage` event beside `priced`, for the same reason: they are facts about the run, and a
  fact not recorded when it was true is a question nobody can answer later. So the Spend page can
  ask by harness, by sign-in and by provider as well as by agent, project and model — which is the
  only thing that tells `claude-opus-5`, `anthropic/claude-opus-5` and
  `openrouter/anthropic/claude-opus-5` apart, being one model on a subscription, an API key and a
  router. The name is never parsed for it: `anthropic/claude-opus-5` reached through OpenRouter is
  a real route, and a guess would file it under Anthropic and look certain. `UNRECORDED` is always
  an allowed answer and is drawn as *not recorded*, never as a model called `unknown`.
- **A model has one name, and the routing in front of it is not part of it.** One model is spelled
  as many ways as there are ways of reaching it — `claude-opus-5` from Claude Code,
  `anthropic/claude-opus-5` from a route against an API key, `openrouter/anthropic/claude-opus-5`
  from pi through a router — so added up by the string one agent becomes four rows, which is what
  the Spend page was doing with an agent's hours in one and its money in another. `modelIdentity`
  (`core/src/spend.ts`) is the one rule: the **model is the last segment**, everything in front of
  it is routing, and the routing is kept rather than thrown away — `id` is the spelling that reaches
  it again, which is what starting an agent back up on it needs, and `provider` is what somebody
  wrote down and is never read out of the name. Everything that writes a model into an event writes
  it the same way (`modelDetail`: the name, and `modelId` only where they differ), and everything
  that reads one reads `modelIn` — so a journal full of the old spellings folds into the same rows
  rather than needing a migration nothing could write.
- **A run is timed by what it turned out to be on, and says so itself.** A route asks for
  `anthropic/claude-opus-5` and Claude Code answers `claude-opus-5`, so runtime taken from
  `run_started` alone lands on a different model row from the money — one agent drawn as two. And a
  route that asks for nothing leaves `run_started` with nothing to record at all: pi picks by what
  you are signed in to, which was 86 of the 161 runs in the journal this was found in, every hour of
  them attributed to nobody. So the harness saying which model it opened on is written down
  (`run_model`, from the supervisor's `started` and `usage` signals — once, and again only when it
  changes), `runtimeFrom` reads it inside the run it is timing, and `modelsSaid` is the fallback for
  a journal written before it. A run nothing ever named is `UNRECORDED`, drawn as *not recorded*.
- **How long the agents ran is added across them, and says that in as many words as it takes.**
  `13d 3h` off a machine that has been on since breakfast reads as a bug and is not one: twenty
  agents over an afternoon each ran for the whole of their own afternoon, and a run is wall clock
  from start to stop, so one that finished at noon and sat in its lane until the window closed
  counted the wait. Both are true and both are surprising, so both are said — `runtimeSays` in core
  is the one sentence, read by `tade spend`, and the window says the same fact as a clause
  (`spendFooter`: `2h 5m over 3 runs`, beside `~ $1.26 estimated`). Neither may ever *explain* it
  differently, and the short one may never be the one that leaves something out: `over 3 runs` is
  what makes a figure that is not elapsed time readable, which is the whole of what the paragraph
  was for.
- **A name is the one column that cannot be abbreviated without lying**, so the Spend table is laid
  out from the room there is (`spendColumns`): the figures take what a figure takes, the share
  meter gives ground first, and everything left is the name's. Past that it wraps (`nameLines`) and
  only then ellipsises — and everything cut is cut with `cap`, which says so. Two names that stop
  dead against the next column read as one unreadable row, which is how this was reported.
- **A subscription is not money, and is never totalled with it.** Where a plan pays for the work
  there is no price per turn, so what is used up is a share of a rolling window — and that lives in
  its own type (`PlanWindow`, `core/src/limits.ts`), in its own list on the Spend page, in its own
  indicator in the strip, and in no total anywhere. Every figure is what the *service* told the
  harness and nothing Tade counted. When a harness can say is declared like everything else
  (`capabilities.spend.limits`: `anytime`, `while-working`, `none`, each short of full carrying a
  sentence in `why.limits`) and never sniffed: both subscription harnesses are told as their agents
  run, so before one has, the honest answer is the harness's own sentence rather than zero.
  `planStandings` is where that is decided, and it throws away a share whose window has already
  started over — a percentage belonging to a window that is gone looks exactly like one that is
  true, which is the one way this could be worse than saying nothing. Nothing here asks anybody
  anything: the window draws it on its own beat, so `limits()` reads what the harness already holds.
  What is used of a window is drawn as a bar, the way the context meter draws how much of a context
  is gone, because it is the same kind of figure: on the Spend page a row per window per account,
  and in the strip the windows of **one** account — `tightestPlan`, the account with the fullest
  window anywhere, which is the one about to stop somebody working. One account and not the fullest
  window of each, since one sign-in's session beside another's week is two answers to one question.
  Short of room the strip gives up its trimmings before the controls beside it — when each window
  comes back, then the window that is not the tightest, and the bars themselves last — because both
  are said again one click away on the page it opens, and the model and how hard it thinks are said
  nowhere else.
- **An agent's turn is the work of a model, and is timed as one.** The supervisor sees a turn start,
  the tools it calls and what it cost, so that is where it is timed (`agentTurns`): a
  `gen_ai.invoke_agent` span per turn with `gen_ai.execute_tool` spans inside it, the model and the
  tokens on it. Never from the journal, which knows when a turn ended but not when the agent was
  waiting to be asked. Sampling is the reporter's one decision: turns are always kept, Tade's own
  work is kept at `telemetry.traces`.
- **Sentry's SDK, and nothing automatic.** The extension reads Sentry with plain requests; reporting
  uses `@sentry/node`, because what is wanted is a tracer and the parts nobody should write twice.
  It is imported only when there is a DSN, with `defaultIntegrations: false` and
  `registerEsmLoaderHooks: false`: Tade names its own work where it happens, and a window must
  never have its terminal written over by somebody else's deprecation warning.
- **A tool fails by throwing.** pi reads a tool's `content` and marks a call failed only when it
  throws; anything else reaches the model as an empty answer that looks like success.
- **There is no server.** The one socket left is the `ToolHost`: a channel from the window to its
  own child agents, undiscoverable and dead when the window closes. If something that is not our own
  child would ever want to call it, it has become a daemon again — which is the thing we removed.
- **An agent is a lane with pi in it**, named `<task>/agent`, talking in a pi session named after
  the task. That session id never changes, which is what makes reopening ordinary: the same command
  line starts the conversation the first time and continues it every time after — and why **a task
  name is never used twice**: a new agent given an old one's name would carry on its conversation.
- **A model is chosen per harness.** A route's model is for its own harness; what new agents of
  another harness start on is kept beside it (`workers.routes.<route>.harnesses.<harness>`), and a
  model is always resolved by the harness it is for (`resolveModel`) — never handed across. So a
  picker only ever offers what one harness runs, asked of that harness (`modelsOffered`,
  `agentModels`, `harnessModels`, `Orchestrator.models`), on the account it runs as, since a model
  is reached through a sign-in. There is no everybody's list to fall back on: one that could not
  say comes back with the sentence it declared for exactly that (`why.models`) and the window says
  it in place of a list, because a model of another harness is a name that fails at the next
  launch. Which harness a setting's model is for is part of the question (`{ kind: 'model',
  harness }`), and how hard a thing can be told to think is its harness's too — the orchestrator
  is a harness choice like any other, and pi thinks at `off` where Claude Code does not.
  **Choosing a harness clears what was chosen for the one before it** (`clearedByHarness`): model,
  provider and thinking level go back to unset, which is the harness deciding. Carrying them
  across is how a route ends up asking for something that does not exist there — and the same rule
  reaches backwards, so a run resumed in one harness is only ever told what *that* harness ran it
  on (`modelLastRunOn`).
- **Agents work where `agents.workspace` says.** `checkout` (the default): every agent in the
  project's own checkout, on its branch, at once, each task a folder under `.tade/tasks/<name>`;
  its state is its agent's, never the shared files' (`deriveState` with `shared`), and removing it
  removes only that folder. `worktree`: a worktree and branch each. Nothing that runs git on a
  task's directory may assume the directory is the task's alone — ask `task.workspace`.
- **A model or thinking level chosen for an agent is what new agents start on**, until another is
  chosen: kept in the agent route (`workers.routes.<route>.model`, `.thinking`), which Settings shows.
  Only new agents are given them — one coming back to its conversation keeps what its session was
  on. Left unset, pi picks by what you are signed in to, which is how every agent once ran on the
  same model whatever anyone chose. Nothing may ask pi anything while its extensions load: it
  throws, and a throw there takes the agent down.
- **A harness says how it does things, and why not.** Its capabilities are `live`, `idle`,
  `restart` or `none` per thing a person can ask of a running agent, each short of full with a
  sentence in `why`; every surface reads them through `offer()`, so none offers what another hides.
  A lane records the harness it was started in, and whatever touches a harness's own records —
  its conversation, its spend, where it must write when contained — asks the adapter.
- **An account is the harness's own sign-in, kept apart, and Tade never holds it.** Each harness
  runs as its own default, or as an account added beside it (`accounts.<name>`, a folder under
  `<home>/accounts`), chosen for its new agents (`workers.accounts`) or for one agent (`account` in
  its task file). Signing in runs the harness's own sign-in in a terminal a person can see; a
  subscription token never passes through Tade and is never stored by it, and an API key Tade keeps
  is read by the harness through a command at the moment it is needed. An agent moved to another
  account takes its conversation with it where the harness can carry it.
- **The orchestrator is a harness choice like any other, and what it needs is declared.** It is
  the same `Orchestrator` over the same signals whichever harness it runs in
  (`orchestrator.harness`): what differs is asked of the harness, never branched on its name. It
  must be one Tade can drive itself rather than one that draws its own terminal
  (`capabilities.headless`) — pi's `--mode rpc`, Claude Code's stream-json — and it must take
  Tade's own tools, as modules it loads (`nativeExtensions`) or as an MCP server it starts
  (`mcp`). Those tools are declared once (`orchestratorTools`) and handed to each harness in its
  own terms; two lists would be two tool surfaces, and the golden file would only ever protect one
  of them. Nothing it does is gated — it is Tade's interface, and asking permission to answer
  "where are we" is not a question anybody wants — so it runs unsupervised, and a harness that
  cannot switch model in its session is started again on the same conversation instead.
- **Harnesses come from one registry** (`HARNESS_ADAPTERS` in the workbench, `HARNESS_CHOICES` in
  core for what to offer). A task may name its own (`harness` in its task file); the supervisor
  keeps an adapter per harness and answers each run with the one it started in. Never `new` an
  adapter at a call site.
- **Opening the window starts nothing new, and brings back what was working.** An agent exists
  because someone asked for one; a project whose agents were removed stays empty until asked again.
  An agent that was running when Tade closed — not stopped, not removed, not ended on its own — is
  marked `lost` in `lanes.json` when the next window cannot find it, and that window opens it again
  where it left off. Stopping, removing or exiting clears the mark. Queued work and schedules are
  asked for too: what came due while Tade was closed starts when it opens, and says why.
- **An opening instruction is said once, and nothing that comes back says it again.** Starting an
  agent with a first prompt (`startAgent`) and reattaching to the conversation it already has
  (`reopenAgent`) are two acts, not one call with an empty string: the prompt reaches the harness as
  `LaunchSpec.opening`, is appended at that launch only, and is never written into the lane's spec —
  so relaunching a lane from what was stored, or reopening the window, reattaches in silence. Queued
  work whose agent already has a conversation is brought back rather than told again (`reopened` in
  `queue_started`): an agent that hears its first instruction twice does the work twice.
- **The orchestrator picks its conversation back up, it is never introduced again.** It talks in one
  session of its harness's own, whose id never changes (from `ORCHESTRATOR_TASK`, as every agent's
  does from its task), so closing Tade and opening it again continues the same conversation, with
  everything that was discussed still in it — never "continue the newest", which is how it once met
  someone who had never heard of you. A model chosen for it restarts the process, not the conversation.
  What a session cannot hold is the world, so every open also composes a briefing from the journal
  (`composeBriefing`): when Tade was last open, which agents were still running, what finished, what
  is held, what is queued and scheduled in the queue's own words, and the last things you said, in
  yours. It is appended to its prompt as a snapshot with times on it and says so — status is still a
  query, and what is true now is `tade_status`'s to answer, never the briefing's.
- **Every agent is told it runs in Tade** (`composeAgentPrompt`): its task, where it works and
  who else does, the commit rule (`agents.commit`), your own rules (`agents.instructions`), your
  notes about the work, and its context file. Appended to the harness's own instructions, never
  replacing them.
- **A name a person gives an agent is kept** (`title_named` in its task file) and given to its
  session; any other name is only a guess, replaced when a better one comes.
- **Everything Tade starts runs detached, and the window's title is Tade's own.** A probe on a
  timer — git, ps, lsof, tmux, an extension's commands — and anything long-lived that is not a lane
  — a model process, the recorder — runs in its own process group, or the terminal names its window
  after it: a window that flickered between `pi < node /the/whole/path` and `osascript`. What it
  costs is that a group signal no longer reaches them, so whoever started one ends its group. The
  title left over is written by the window alone (`windowTitle`): an indicator that turns, what the
  agents and the orchestrator are doing, and where you are — re-asserted on the repaint's beat, so
  a title something else took is taken back.
- **A task's id is in its task file, not its branch.** In a worktree, an agent opened from the window
  starts on no branch (a detached worktree) and is given `tade/<its title>` at its first change;
  its lanes and session keep the id it was made with. Status finds a branchless worktree only by that
  file, and never renames a branch it did not make.
- **events.jsonl is the truth**; the SQLite index is derived and must be rebuildable from it. Raw
  lane output never goes in the log (it lives in the lane's scrollback), only sampled byte counts.
- Under subscriber backpressure, `trace` events are dropped first and `blocking` events never.
- `attach` puts the user's terminal in raw mode: every exit path, signals included, must run the
  same `restore()`, and it must be safe to call twice.

## Keeping the repo maintainable

- **This file is the one guide.** `CLAUDE.md` is a link to it, so every agent reads the same words.
- **A file over 800 lines is a conversation.** `test/modularity.test.ts` holds one budget per file —
  `DEFAULT = 800`, and a line of its own for each file allowed to be bigger — and a number in it may
  go **down** in the commit that earns it, never up; a budget sitting more than 150 lines above its
  file is the ratchet failing, so the numbers follow the files down rather than staying at the year
  they were written. It holds the two import rules beside them: `app.ts` imports `wire/*` and no
  `wire/*` imports `app.ts`, and the pure files (`frame.ts`, `model.ts`, `view.ts`, `view/*`,
  `panels/*`, `skin.ts`, `ui.ts`, ...) contain no `node:` import, no clock read and no `async`. It
  runs in `test:smoke`, so a file crossing its line is said at the commit rather than in CI, and every
  failure says what to do about it. `app.ts` reached 8,635 lines because adding the fortieth subject
  to it was never once visibly a decision, and prose does not fail a build.
- **A surface is options and values; the explanation lives where somebody asks for it.** Every
  drawn surface — a settings group, a sidebar section, a panel, a footer — is a heading and then
  controls, and no paragraph. A control whose name says what it is gets no sentence under it; where
  the *consequence* is not guessable from the name, one short line, and only for the thing you are
  on. A caveat that is true under every row of a page is a mark or a clause (`~`, `over 3 runs`,
  `on this machine, not CI's matrix`), never a footnote read four hundred times. What is cut from
  the drawing is not cut from the program: a setting's `means` is still what the search box matches
  on and what `tade config` prints, `runtimeSays` still says the whole of it in `tade spend`, a
  group's `about` is still searchable, and the panel that asks before an act is still where that
  act's cost is spelled out. So the test of a line is not whether it is true — they were all true —
  but whether *this* is the surface somebody would be reading it on.
- **`README.md` is the showcase**, and the source a web page will be built from: a hero, a section per
  feature, each a picture and a line or three, then install and setup — which must stay findable,
  because they are the one thing a README may not lose. Explanations belong where they are used —
  a command's `--help`, a setting's `means`, the shortcuts sheet, a tool's description — so they cannot
  drift from the behaviour they describe; the README shows rather than tells. **Its pictures are
  generated, never taken by hand**: `pnpm screens --assets` redraws `images/` — which sits beside
  the README because that is what asks for it — from the golden screen scenarios
  (`packages/app/scripts/pictures.ts`), so a change to how the window looks is a change to the
  README. Add a picture by adding a scenario, and never advertise what is not built — what is not
  built goes under Planned, named in a line and pointed at the port it would be built against.
  **Changing how anything looks means redrawing them in the same commit** — the recipe is the
  `redraw-the-pictures` skill, and a page showing a window Tade no longer has is a lie every other
  test passes.
- **What the pictures cannot prove, a photograph can.** They are the real renderer over made-up
  state, which is what lets them show an agent at work without an agent — and is why they say
  nothing about the program a person installs: between the two sit the alt screen, the frame loop
  and the terminal's own idea of a colour. So `pnpm screens --live` runs the actual binary in a real
  terminal — Tade's own pty driver — presses real keys at it and keeps what it painted. It reaches
  only what a machine with no agents can reach, and that is the point of having both: it found the
  window drawing the gap between two buttons in the colour of the button before it.
- **There is no `docs/` folder, and adding one is going backwards.** Everything is documented where
  it is used: this file for the invariants, `.claude/skills/` for the recipes, a command's
  `--help`, a setting's `means`, a tool's description, the shortcuts sheet, the README for the showcase,
  and a comment beside the code for why that code is the way it is. A design document is a plan,
  and a plan that outlives its build is a second description of the system that nothing keeps
  honest.
- **A plan lives in the work, and what outlives the work lives in the thing that fails when it
  stops being true.** The folder has now been removed twice — both times because the rule above
  said where a plan may not go and never once said where it does, so the next long plan had
  nowhere to be and invented `docs/` again. So, plainly, in the three places a plan is ever in:
  **while it is being built**, the task — its prompt, its `.tade/context.md`, the agent's own
  conversation. That is local and ignored and goes when the task goes, which is right for a thing
  whose whole purpose ends at the last commit.
  **Across sittings and across agents**, the commit and the review: a plan too long for a prompt
  is the body of the review the work is opened under (`review_open`) or the message of the commit
  that starts it. Both reach everybody, both are kept by git and the forge rather than by the
  tree, so neither can be read by somebody who does not also see what became of it, and both stop
  being in the way the moment the work merges — which is the whole of what a parked `docs/` file
  was being asked for.
  **After it is built**, wherever the thing it describes already is, in the same commit that makes
  it true: an invariant here, a recipe in `.claude/skills/`, a why beside the code it explains, a
  constraint as a test with a number in it. Work a plan named and did not do goes beside the thing
  that will nag whoever next touches it — the budget line a split would lower, the comment at the
  top of the file that would move — never in a list of intentions nobody is reading.
  What has no home here is the fourth thing, and it is the only one that ever gets written: a file
  that only describes, in a folder that only holds descriptions. Nothing reads it at the moment of
  the change, nothing fails when it goes stale, and so it rots in place and is believed anyway.
  **A plan that seems to need a file of its own is a plan whose reasoning has nowhere to be true
  yet** — build the smallest piece that makes it true, and put the reasoning there.
- **`.claude/skills/` holds step-by-step recipes** for recurring changes (a CLI command, a config
  key, an extension, the window, ...). Use the matching skill, and add or update one when you create
  a new extension point or a change teaches you something a recipe should have said. Do not confuse
  them with `<TADE_HOME>/skills`, which is what Tade itself has learned.
- **Third-party notices are generated.** After changing dependencies run `pnpm notices`, which
  rewrites `THIRD_PARTY_NOTICES.md`; programs, services and data Tade uses without installing are
  listed in `scripts/notices.ts`.

## Where things go

Each subsystem is a folder: `core` holds the port and the conformance suite, the siblings are
implementations of it.

| Path | Contents |
|---|---|
| `packages/core` | the domain: object model, state machine, config, policy, memory, prompts |
| `packages/status` | observing reality: git · processes · adoption · tests · liveness |
| `packages/workbench` | what Tade holds while open: lane registry, journal, notes, agents |
| `packages/drivers/core` | the `WorkspaceDriver` port + the suite every driver passes |
| `packages/drivers/{pty,tmux}` | where lanes physically live |
| `packages/harnesses/core` | the `WorkerAdapter` port: what an agent tells us, how we answer |
| `packages/harnesses/{pi,claude,codex}` | runs and supervises pi · Claude Code · Codex |
| `packages/voice/core` | the voice surface + the speech ports |
| `packages/voice/{stt,tts}` | speech in · speech out |
| `packages/judges/core` | the `Judge` port + the suite: bounded questions, answered with a number |
| `packages/forges/core` | the `Forge` port + the suite: a branch offered for merge, and what is said about it |
| `packages/forges/{github,scripted}` | GitHub, through one credential · a table, for tests and demos |
| `packages/checks/core` | the `Runner` port + the suite, the manifest, the record and the run lock |
| `packages/checks/{local,scripted}` | the commands, run here · a table, for tests and demos |
| `packages/judges/{jev,scripted}` | who answers them · a table, for tests and demos |
| `packages/extensions/core` | the `TadeExtension` port, the host that runs extensions, their suite |
| `packages/mcp/core` | the `McpTransport` port + its suite, the naming rules, what is declared, the catalogue |
| `packages/mcp/{stdio,http}` | a program on its pipes · one already running, streamable or over a stream |
| `packages/mcp/scripted` | a table of tools and answers: no process, no network |
| `packages/mcp/broker` | declared servers → `TadeExtension[]`, and the transport registry |
| `packages/telemetry` | the `Reporter` port and its suite: where Tade's own trouble goes |
| `packages/extensions/{checks,deps,jev,review,sentry,resources}` | the extensions that ship with Tade |
| `packages/orchestrator` | the thing you talk to: its tools, its prompt, the built-in extension list |
| `packages/app` | the window: agents, files, terminals, the conversation, panels, push-to-talk |
| `packages/cli` | the `tade` binary |
| `test/fixtures` | `mkrepo.ts`, provider transcript samples |

Exit codes: `0` ok, `1` runtime error, `2` invalid input/config.
