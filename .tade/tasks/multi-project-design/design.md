# Many projects, and work that spans them

A design, before any code. What follows is in three parts: what is already true and where the
question's assumptions are wrong; the design itself, end to end; and the smallest slice worth
building first, with an explicit list of what I would not build at all.

---

## 1. What is already true

Six facts, each checkable, because the design only makes sense against them.

**Projects are already plural.** `config.projects` is a record of project name to root
(`packages/core/src/config.ts:426`), `collectStatus` loops every one of them
(`packages/status/src/status.ts:72`), and the window draws them as tabs along the top with
`ctrl+o` to open one and `ctrl+shift+1–9` to go to one (`packages/app/src/view.ts:688`,
`config.ts:351,363`). "Open multiple projects" is not a feature to build. It is built, and
`packages/app/src/projects.ts` already browses the disk to find the next one.

**Everything is already namespaced by project.** A task id is `<project>/<task>`, a lane id is
`<project>/<task>/<lane>`, a terminal id is `<project>/terminals/<n>`
(`packages/workbench/src/terminals.ts`), and the `Tade-Task:` trailer on a commit carries the same
fully-qualified id. A commit in any repository on this machine already says which project's task it
belongs to, and `commit_seen` keys it by sha. Nothing needs a new identifier.

**There is one journal, one lock, one home.** `events.jsonl` is per `TADE_HOME`, every event carries
the qualified task id, so the project is derivable from every line. There is no per-project state to
unify later, because there never was any.

**There is one orchestrator, and it is one conversation.** `ORCHESTRATOR_TASK = 'tade/orchestrator'`
is a fixed session id per home (`packages/orchestrator/src/orchestrator.ts:81`), which is what makes
closing the window harmless. `config.orchestrator` is a single block: one harness, one model, one
set of extensions. So: **yes, one orchestrator for all the projects.** That assumption is correct.

**The queue is already keyed by project where it has to be.** `readyToStart` takes
`room: Map<project, number>` and never exceeds a project's `max_parallel`
(`packages/core/src/queue.ts:406`); `queuePaused(events, project)` pauses one project's queue;
`Reality` — the start-time tree evidence — is gathered per project (`queue.ts:43`).

**And the queue's *waits* are already project-blind in exactly the right way.** `queueStateOf`
resolves each `after` entry against `facts.finished` and `facts.tasks`, which are flat maps of
fully-qualified ids built over every project (`packages/app/src/live.ts:1062`). A task file in
`getsentry` whose `after` names `sentry-cli/bump` would already wait for it correctly. Nobody can
write one — but the engine would keep it.

### Where the question is wrong

1. **"Open multiple projects" is done.** What is single-project is almost everything downstream:
   the briefing, the plan tool, the workspace setting, and — quietly the worst of them — the fact
   that the orchestrator is never told which project you are looking at.

2. **"orchestrator can anyhow orchestrate and manage tasks in between" — it cannot, and the
   refusal is one line.** `planTasks` builds the set of existing tasks filtered to `plan.project`
   (`packages/workbench/src/workbench.ts:965`), so `checkPlan` refuses any wait naming a task
   elsewhere with *"waits on X, which is neither in the plan nor a task in \<project\>"*. One filter
   is the whole of what stops cross-repo orchestration at the tool.

3. **If you hand-wrote that wait, the queue would keep it and then start it wrong.** `startFrom`
   (`queue.ts:440`) reads the `upstream` map, which is flat across every project
   (`live.ts:1062`), and would hand repo A's branch name to `git worktree add` in repo B — failing,
   or worse, silently matching a coincidentally-named ref. Cross-repo waits are *half* built today:
   the waiting is right, the starting is dangerous. This is the one correctness bug in the area.

4. **"two unrelated things in one repo" is not a new concept — it is `worktree` mode, and you
   cannot ask for it per project.** `agents.workspace` is one global setting
   (`config.ts:378`), read globally by `lookAtTree` (`live.ts:509`), `planTasks`
   (`workbench.ts:969`) and the agent prompt. You cannot say "Sentry is worktree, this little repo
   is checkout". That single missing key is most of the Sentry answer.

5. **The orchestrator must not "know" branches and worktrees.** Status is a query. `tade_status`
   already returns, per project and per task: the branch, the worktree path, the dirty paths, ahead
   and behind, the base ref, whether it is merged into base, the review and its state, and every
   live agent (`GitSnapshot` and `Task` in `core/src/model.ts`). There is nothing to teach it and
   nothing to remember; a tool that handed back a remembered map of branches would be wrong within
   the minute. What it genuinely lacks is not knowledge — it is **where you are**. Nothing in `ask`
   (`packages/app/src/app.ts:4850`) tells it which project tab is in front of you.

---

## 2. One orchestrator, and it stays one

**Recommendation: one. Do not split it.**

**What one shared context buys.** A change that spans repositories only exists in one conversation.
The moment there are two orchestrators, the interesting case — "the scope change in `sentry` has to
land before the client bump in `sentry-cli`" — requires them to tell each other, and "tell each
other" means a protocol between two models about who owns a piece of work. That is a distributed
system built to solve a problem a single conversation does not have. Beyond that: notes, lessons,
the journal, the queue order and the spend are all one thing per home already. Splitting the model
but not the memory gives you two writers of one conversation history, which is the failure the fixed
session id exists to prevent.

**Where it genuinely collides, said honestly.**

- *Context length.* Five repositories of briefing is a real cost, and the briefing is already the
  longest thing the orchestrator reads before it says anything. The answer is to give the briefing a
  **shape**, not a bigger budget — §5.
- *Ambiguity.* "Start an agent on the flaky test" with five projects open is not answerable. Today
  it guesses or asks. The answer is to tell it where you are, every turn — §5.
- *One busy turn blocks every project.* Real, and I would still not fix it by splitting.
  `whenBusy: 'queue'` already exists for what cannot wait, and what a person actually wants while a
  turn is running is the window, which is not blocked at all.

**What it would take to have one per project, and what is lost.** Mechanically: `ORCHESTRATOR_TASK`
becomes `tade/orchestrator/<project>`; `config.orchestrator` becomes overridable per project the way
`worker` and `checks` already are; the bottom strip becomes per tab; the `ToolHost` routes a call to
the right session. All of it is ordinary. What is lost is the only thing worth having — **nobody
holds the change that spans repositories** — plus a subtler thing: a session id with a project name
in it breaks the day somebody renames the project, and renaming a project is a config edit.

So: not several. But the door is left open for free. Nothing in this design puts a project name into
`ORCHESTRATOR_TASK`, every orchestrator tool already takes `project` explicitly, and the one new
thing the orchestrator is told (§5) is a derived fact on the turn rather than a session-shaped
assumption. If context ever becomes the binding constraint, splitting is additive from here.

**The one thing that changes now.** The orchestrator is told **where you are, every turn, as a fact
and never as memory** — one line appended by `ask`, exactly the way `withNews` already appends what
happened:

> You are looking at `sentry › flaky-tests`. Four projects are open.

Derived from `state.project` and `state.focused` at the moment of asking, never stored, never in the
briefing. That last clause matters: a briefing that says "you were in sentry" is wrong the instant
somebody presses a tab, and a remembered location is the same class of bug as a remembered branch.

---

## 3. A change that spans repositories

One intent, three repos, three branches, three reviews, an order between them.

### The unit is a sibling link, not a multi-workspace task

**Rejected: a task with several workspaces.** Concretely, it breaks five things at once. A lane has
one `cwd` and one harness, so "one task, three agents" is three lanes pretending to be one. `Task`
has one `worktree: string` and one `GitSnapshot`, and `deriveState` is a pure function of that one
snapshot. `taskFilePath` and `sharedTaskDir` assume one file in one tree. The `Tade-Task:` trailer
would name one task across three histories, so "what did this task change" stops having one answer
in any one repository. And worst: **`done: merged` has no meaning when there are three branches** —
which is precisely the "what if two of three are merged" question, made unanswerable in the one
place nothing can see it.

**The unit is an *effort*: a name, the sentence you said, and the tasks in it.** Nothing else. It
has no workspace, no branch, no agent, no review and no done rule. Underneath it, one ordinary task
per repository — `getsentry/oauth-scopes`, `sentry-cli/oauth-scopes`, `docs/oauth-scopes` — each with
its own worktree, branch, agent, checks, review and done rule, exactly as tasks work today.

This is right because everything a task already does keeps working unchanged. Three reviews found by
the review extension's existing per-host machinery, which already spans repositories
(`include: acme/*`). Three sets of checks, each from that repo's own `.tade/checks.yaml`. Three
`Tade-Task:` trailers, each naming exactly one task in exactly one history. Git, the forge port and
the checks record learn no new word.

### An effort is a plan that spans repositories

`Plan` is already `{ project, said, agents[] }`, where `said` is the whole request verbatim and each
agent covers a slice of it with its own `after` and `touches` (`queue.ts:472`). That *is* an effort.
It just cannot cross a project. So:

- `PlannedAgent` gains `project?: string`; `Plan.project` stays and becomes the default for agents
  that name none. Every existing call is unchanged in meaning.
- `planTasks` widens its task set from one project to all (`workbench.ts:965`) — the ids in it are
  already fully qualified, so `checkPlan`'s existing dep resolution starts working across repos
  with no change to its logic.
- `checkPlan`'s `idOf(name)` becomes `idOf(agent)` = `${agent.project ?? plan.project}/${name}`.
- **`overlaps` must stop comparing paths across repositories.** Two agents that both touch
  `src/index.ts` in two different repos are not overlapping, and today `shares()` would warn that
  they are. Overlap is computed within a project, per project. This is a bug the widening would
  otherwise introduce, so it lands in the same change.
- `PlanContext.workspace` becomes per project, since `done: committed` / `done: merged` are refused
  in checkout mode (`queue.ts:529`) and with several projects the answer differs per agent.
- `Plan` gains `effort?: string` — the slug — since a plan has no name of its own today. With
  one, every task it makes carries it and the plan's `said` is recorded once as the effort's
  sentence, verbatim. Without one, the plan behaves exactly as it does now and makes no effort.

### Where an effort lives: nowhere new

Not in a table — a table is wrong the moment somebody removes a task. `TaskFile` gains one optional
field, `effort: <slug>`, and **an effort is the fold of the task files that name it**. Status already
reads every task file in every project, so grouping is free, a removed task leaves the effort
correctly smaller, and there is nothing to rebuild or keep in sync. One journal line,
`effort_named`, records the slug and the sentence verbatim, once, when it is made — for the same
reason `intent_spoken` is journalled: nothing else can reconstruct the sentence after the task files
are gone.

### The queue, concretely

**No new queue events.** What is already written is already enough, because the ids in it are already
qualified:

- `task_created` with `detail.after: ['sentry/oauth-scopes']` on a task in `sentry-cli`
  (`workbench.ts:940`) — the cross-repo wait, recorded at the moment it is made.
- `queue_started` with `detail.after` and `detail.why` — the cross-repo wait, satisfied.
- `queue_held` with `detail.on: 'sentry/oauth-scopes'` and a `because` — the cross-repo wait, gone
  wrong. Said once to the orchestrator, which asks the person, whose answer is a `queue_changed`.
- `effort_named` is the one addition, and it is not a queue event.

**The one rule that has to change.** `startFrom` must not hand a ref across a repository: queued work
in a worktree begins on top of what it waited on **only when that work is in the same project**.
Cross-repo, repo B's worktree branches from repo B's base, as it would with no wait at all. That is
one argument and one filter, and without it cross-repo waits are worse than absent.

**What the person reads.** `inProject(pane.project, text)` strips only the pane's own project prefix
(`view.ts:1494`), so a cross-repo wait keeps its prefix automatically: `held: after
sentry/oauth-scopes` rather than the lie `held: after oauth-scopes`. That already works; it is worth
writing down so nobody "tidies" it.

### The trailer stays one task, deliberately

`Tade-Task: sentry-cli/oauth-scopes`. It never names the effort. The trailer is read in four places
(`core/src/compose.ts:161`) and every one of them asks *whose is this commit*, which has exactly one
answer. The effort is recoverable from the task — read the task file, read its `effort` — so a
`Tade-Effort:` trailer would be a second copy of a derivable fact, written into the one place Tade
can never correct it: a commit message on somebody else's machine.

### What "finished" means when two of three are merged

Plainly, and deliberately boring:

- **Each task finishes by its own rule**, unchanged. `merged` for the ones whose landing another
  waits on, `said` for the rest.
- **An effort is finished when every task in it is finished**, and until then it does not have a
  state — **it has a list**. "Two of three" is not a state anybody can act on; *which one is not* is.
  So the window and `tade_status` say `oauth-scopes: 2 of 3 — sentry-cli/oauth-scopes still working`.
- **There is no effort-level done rule.** A fourth rule above three rules is a rule that will
  eventually disagree with them, and when it does there is no way to tell which is right.
- **There is no effort-level merge.** Merging is a person's, per review, per repository, and three
  merges are three acts. An order between them is `done: merged` plus a wait, which is the queue
  already doing its job.

---

## 4. Two unrelated streams in one repo

The Sentry case: search performance and billing emails, in one checkout, with nothing to do with
each other.

**Today's honest answer.** In `checkout` mode both agents share one tree on one branch. For two
unrelated efforts that is not a limitation to work around — it is **wrong**: the two efforts' commits
land on one branch and a review of either carries the other's work. Tade already knows this, which is
why `done: committed` and `done: merged` are refused outright in checkout mode (`queue.ts:529`). In
`worktree` mode each task already gets its own tree and its own `tade/<slug>` branch, and two
unrelated streams in one repo *already work*. The person simply cannot ask for it, because
`agents.workspace` is global.

**So how a person says "these are two separate efforts here":**

1. **`workspace` moves into `ProjectConfigSchema`**, optional, falling back to `agents.workspace` —
   exactly the shape `checks` already has. One key, one reader (`workspaceOf(config, project)` in
   core), four call sites moved to it. This is what lets Sentry be `worktree` while a small repo
   stays `checkout`, and it is most of the answer.
2. **Two efforts is two efforts**, the same way it is across repos: `effort: search-perf` and
   `effort: billing-emails`, each with its own tasks in the same project. The effort is what carries
   *"these are separate"*; the worktree is what makes it true. Nothing about an effort is
   cross-repository — it happens to be able to span repositories, which is a different thing.
3. **One plan is one effort.** Two efforts is two `tade_plan` calls. A plan whose agents belong to
   two unrelated efforts is a plan whose `said` is two sentences, and then the effort's sentence is
   not the thing anybody said.

**What shows in the window.** The sidebar is today a flat list of the selected project's agents
(`agentsHere`, `packages/app/src/model.ts:422`). With two efforts in one project that list is two
unrelated things interleaved. So: **when a project has more than one effort, the sidebar groups by
effort** — a one-line header per effort carrying its sentence shortened to the room, its agents under
it, and everything with no effort in a last group with *no header at all*, because a heading that
says "no effort" is noise in the common case where nothing has one. Drag order is kept within a
group. This is drawing only: `tasksOf` (`model.ts:429`) gains a grouping, `agentsHere` is unchanged,
and a project with one effort or none looks exactly as it looks today.

**How the collision checks behave.** This is the sharpest part, and the answer is that they are
already right.

- In a project set to `worktree`, the start-time tree evidence **does nothing at all**, and should
  not: `collidesNow` returns `null` immediately when the workspace is not `checkout`
  (`queue.ts:335`), and `lookAtTree` returns `bare` before making a single git call
  (`live.ts:515`). Two efforts in two worktrees cannot change files under each other. What two
  branches do to one file is a merge, which the plan already warned about.
- In a project still in `checkout` mode, two unrelated efforts share one tree and the evidence
  behaves **exactly as it does now** — and it will hold work more often, because two unrelated
  efforts in one tree collide constantly. **That is the check telling the truth.** The fix is
  `workspace: worktree` for that project, not a looser check.
- **The check must never learn about efforts.** It must not treat "different effort" as *collides
  harder*, and — the dangerous one — it must not treat "same effort" as permission. `collidesNow`
  exempts exactly one thing today: what a task waits on, because those changes are the reason it is
  starting at all (`queue.ts:342`). An effort is a name for related work, not a lock on a file, and
  two agents in one effort editing one file in one checkout is the same accident as any other.
  Writing this down is the point of this paragraph.
- One consequence of the config move: `lookAtTree` must read *the project's* workspace rather than
  the global one (`live.ts:509`). Same change, same commit.

---

## 5. What the orchestrator knows

**Nothing remembered.** `tade_status` already answers all of it, per project, derived fresh: branch,
worktree path, dirty paths, ahead/behind, base ref, merged-into-base, the review and its state, every
live agent and whether it is between turns. The only thing to add is one field per task in that
answer — `effort` — read from the task file status already opens.

**The briefing has to gain a shape, not a budget.** `composeBriefing` is today a flat list capped at
six tasks (`packages/orchestrator/src/briefing.ts:40`). With five repositories open, six lines is one
repository's worth and the rest vanish without a word — which is worse than a long briefing, because
silence reads as *nothing is happening there*. So:

- **A first line that says the size of the world**: `Five projects are open: getsentry, sentry,
  sentry-cli, relay, tade.` The orchestrator should never have to infer how many there are from what
  it happened to be told about.
- **Per project, not globally.** The task cap becomes per project — two or three — **with a count
  line for what was left out**: `sentry: 9 more not listed`. A cap that truncates silently across
  projects breaks the rule that nothing goes wrong silently, and it is exactly the shape of bug that
  sends somebody looking for this code.
- **Efforts before tasks.** One effort line replaces three task lines and says more:
  `oauth-scopes (sentry, sentry-cli, docs): 2 of 3 finished — sentry-cli/oauth-scopes still working.`
- **Two sections stay global and uncapped**: work held and waiting on a person, and the last things
  the person said in their own words. Those are already small, and they are the two that must never
  be lost to a per-project budget.

**How it stays honest across a restart.** Unchanged, because the mechanism is already right: the
briefing is a fold of the journal, every line says when it was true, and the closing sentence says
the whole thing is a snapshot with `tade_status` as the authority. Efforts change none of that —
an effort is a fold of task files, read fresh every time. Two rules keep it honest:

- **The briefing may never say which project you are looking at.** That is the window's to say, on
  every turn, because it is true only at the moment it is said.
- **The briefing may never say a branch or a worktree path.** They are a query, they go stale within
  the minute, and a remembered branch in a prompt is a lie with a timestamp on it.

---

## 6. What the window looks like

Most of it exists.

- **Switching**: tabs along the top, `ctrl+o` to open, `ctrl+shift+1–9` to go
  (`view.ts:688`, `config.ts:351,363`). Nothing to design.
- **Terminals**: already per project — `<project>/terminals/<n>`, filtered by the selected project
  (`workbench/src/terminals.ts`). Unchanged.
- **Sidebar**: grouped by effort when a project has more than one, as in §4. Unchanged otherwise.
- **Tabs gain a mark.** With five projects the sidebar shows one of them, so a project with a failed
  agent or a decision waiting is invisible while you are in another tab. The tab row already exists
  and already draws each project's name; each tab carries the mark of the most urgent thing in it —
  the sidebar's own marks, not a second vocabulary. That is the smallest thing that keeps a buried
  project from going quiet, and it costs a row nothing.
- **"Where are we" in one sentence** already works and is already cross-project. The window title
  counts every pane in every project (`app.ts:5457`) and puts where-you-are last, dropped first when
  there is no room: `⠹ tade · 3 working · 1 waiting — sentry › flaky-tests`. Counts global, location
  local, and the location is what goes when the tab bar is narrow — what is happening outlives what
  you are looking at. The orchestrator's spoken answer to "where are we" should be this same
  sentence per project, composed from `tade_status`, and **not a new tool**.

---

## 7. Migration

Every change is additive and every default reproduces today's behaviour exactly.

| Change | Absent means |
|---|---|
| `ProjectConfig.workspace` | falls back to `agents.workspace`, whose default is still `checkout` |
| `TaskFile.effort` | the task is in no effort; the sidebar draws it exactly as now |
| `PlannedAgent.project` | `plan.project`, so every existing `tade_plan` call is unchanged |
| `Plan.effort` | the plan makes no effort, and its tasks carry none |
| `startFrom`'s project argument | in a single-project home it returns exactly what it returns today |
| `effort_named` | an old journal has none, and briefs identically |

A config with no `projects` block at all keeps working: `resolveProjects` falls back to the
repository the CLI is standing in (`status.ts:290`). Task files written before `effort` existed parse
unchanged, because the field is optional. And a new journal read by older code is safe by
construction: `readJournal` does `JSON.parse` with no schema validation
(`packages/workbench/src/events.ts:239`), so an `effort_named` line falls through every reader's
type checks and is ignored rather than throwing — the same property that lets `RENAMED_TYPES` exist.

Nothing in here requires touching a single existing task file, config file, branch or worktree.

---

## 8. The first slice

**Make many projects work properly before making one change span them.** The slice is two changes,
neither of which commits us to the effort model, and both of which are worth having even if the rest
is never built.

**1. `workspace` per project.** `ProjectConfigSchema.workspace?: 'checkout' | 'worktree'`, one reader
`workspaceOf(config, project)` in core, and four call sites moved onto it: `lookAtTree`
(`live.ts:509`), `planTasks` (`workbench.ts:969`), `createTask`'s default, and `composeAgentPrompt`.
Pure function, four substitutions, a config key with a `means`.

**2. The orchestrator is told where you are.** One line appended in `ask` (`app.ts:4850`), the way
`withNews` already appends what happened: `You are looking at sentry › flaky-tests. Four projects are
open.` Derived, never stored, never in the briefing.

Together those answer the Sentry question outright — two unrelated efforts in one repo, each in its
own tree, with the orchestrator able to act on "start an agent on this" without guessing which repo
you meant. Both halves are testable as pure functions. Neither touches the queue.

**It deliberately leaves out**: efforts, cross-repo waits, the sidebar grouping, the briefing shape.
A project in worktree mode with two unrelated streams is readable enough as a flat list; it is two
streams in *five* projects that needs the grouping, and by then the effort exists.

**Slice two** would be cross-repo waits: `PlannedAgent.project`, widen the task set in `planTasks`,
fix `startFrom` to stay inside a repository, and keep `overlaps` from comparing paths across repos.
It comes second because a cross-repo wait landing in a project still on `checkout` mode is the one
combination that can quietly produce a branch carrying two efforts' work.

**Slice three** would be efforts: `TaskFile.effort`, `effort_named`, grouping in the sidebar, the
effort line and the per-project caps in the briefing, and `effort` on each task in `tade_status`.

---

## 9. What I would not build

- **A second orchestrator, or one per project.** §2. The cost is a protocol between two models about
  who owns a piece of work, to solve a problem one conversation does not have.
- **A task with several workspaces.** §3. It makes "what did this task change" and "is it merged"
  unanswerable inside the task, where nothing can see that they have become unanswerable.
- **An effort-level done rule, merge, review or branch.** A fourth rule above three rules is a rule
  that will disagree with them, and nothing can say which is right when it does.
- **A `Tade-Effort:` commit trailer.** Derivable from the task, and the one place Tade can never
  correct a mistake after the fact.
- **A registry, file or table of efforts.** Grouping is a fold of what task files already say; a
  table is wrong the moment a task is removed.
- **A cross-repository merge queue, or landing three reviews atomically.** That is the forge's
  problem, and some forges cannot do it at all. Tade says the order and says what has not merged; a
  person merges.
- **Auto-detecting that two repositories are related** — a shared org, a lockfile pointing at the
  other. A guess about what belongs together, read out of files, is precisely the kind of remembered
  fact that goes stale. The person says it once, in a plan.
- **Per-project orchestrator models or prompts.** `config.orchestrator` stays one block. A model
  chosen per project is a second thing to keep straight while there is one conversation.
- **A global `max_parallel`.** Per project already exists and is what people mean. A global cap would
  starve the project somebody is watching in favour of one they are not, and it would do it silently.
- **Cross-repository `touches` collision checks.** Two files named `src/index.ts` in two repositories
  are not the same file. The check stays inside a project — and gains a guard so the widening cannot
  make it lie.
- **A level above project** — a "workspace", a "monorepo group", a super-project. It adds a segment
  to every id in the system and buys nothing the effort does not already give.
