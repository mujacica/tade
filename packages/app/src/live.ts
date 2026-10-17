import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  atWorkFrom,
  type Config,
  type DoneRule,
  type Effort,
  effortsIn,
  type Finished,
  finishedFrom,
  historyFrom,
  pricesFrom,
  type Queued,
  type QueueFacts,
  queueStanding,
  queueStateOf,
  type Reality,
  RuntimeFold,
  type RuntimeReport,
  ruleMet,
  type SpendReport,
  spendFrom,
  startOfToday,
  summariseWork,
  type TadeEvent,
  type TaskState,
  type Upstream,
  UsageFold,
  type Watched,
  type WorkHistory,
  type WorkSummary,
  type Workspace,
  workedFrom,
  workspaceFor,
} from '@tade/core'
import type { LaneScreen } from '@tade/drivers-core'
import { makeCollector, type StatusCollector } from '@tade/status'
import type { Workbench } from '@tade/workbench'
import { livenessTableFrom } from '@tade/workbench/lane-liveness'
import type { PendingApproval } from '@tade/workbench/workers'
import { aboutRoot } from './away-lifecycle.ts'
import {
  branchesIn,
  ChangesHeld,
  CheckoutGate,
  changesIn,
  diffIn,
  marksIn,
  STILL,
  type TreeSaid,
  toldOf,
  treeIn,
  treesFrom,
} from './checkout-look.ts'
import { type FileEntry, type Listed, treeOf } from './files.ts'
import type { ActionsView, Change, NoteShown } from './frame.ts'
import { type Histories, JOURNAL, QUEUE_READS, RUNTIME_READS, readHistories } from './histories.ts'
import type { QueuedView, TaskSnapshot } from './model.ts'
import { notesShown } from './notes-shown.ts'
import { branchOf } from './projects.ts'
import { snapshotsFrom, tabsFrom } from './reality.ts'
import { SCHEDULE_LINES, ScheduleFold, type ScheduleRuns } from './schedule-fold.ts'
import { lookAtWork } from './work-look.ts'

// Reached for alongside `Live` by everyone who reaches for either, so it is
// still here to be imported from: what moved to `reality.ts` was where these
// are written, not who asks for them.
export { knownTasks, snapshotsFrom } from './reality.ts'

// Where the app gets its facts.
//
// Status is a query, so this polls rather than keeping its own idea of the
// world, and the journal it accumulates is what lets the resolver answer
// "which one did you mean".

/**
 * How often commits and check runs that have landed since are written down.
 *
 * A minute, not the refresh beat: this shells out to `git log` once per
 * project, and what it is watching for — somebody finishing a commit — does
 * not move faster than that. The refresh beat is two seconds, and thirty git
 * invocations a minute to notice one commit is the opposite of light.
 */
const LANDED_MS = 60_000

/** How long a folder listing is good for. */
const LISTING_MS = 2_000

/** How long the branch a project's own checkout is on is good for. */
const BRANCH_MS = 10_000

/** How often a task's commits and recorded runs are read again, at the most. */
const WORK_MS = 10_000

/**
 * And while a run is going: a suite you are watching has to move, and what it
 * costs is a small file and the records beside it, not a suite of its own.
 */
const WORK_RUNNING_MS = 1_000

/** How long a look stays quick after somebody starts a run. */
const HURRY_MS = 30_000

export interface LiveOptions {
  client: Workbench
  config: Config
  /** $HOME, for finding agent sessions started outside Tade. */
  home: string
  /** Tade's own home, where every task's file and every check run is. */
  tadeHome: string
  cwd?: string
  pollMs?: number
  /** When the window opened, which "this window" on the Spend page is measured from. */
  openedAt?: number
  /** Where status is looked at: a window's own child, closed by whoever made it; else here. */
  status?: StatusCollector
  now?: () => number
  /**
   * Every look's tasks, with whether anything in the look is not what the last
   * said (`moved`): only that is news to draw. The rest of a beat still runs.
   */
  onTasks?: (tasks: TaskSnapshot[], moved: boolean) => void
  onEvent?: (event: TadeEvent) => void
  onWarning?: (message: string) => void
  /** Something drawn from a background look has changed. */
  onChange?: () => void
  /**
   * A reader found something due to be looked at again, and nothing else was
   * waiting: look soon (`lookAgain`), so a first answer is not a whole beat away.
   */
  onDue?: () => void
  /**
   * An agent that started without a branch has changed something, so its work
   * now needs one. Said on every look until it has one; acting once is the
   * listener's business.
   */
  onWork?: (task: { id: string; project: string; worktree: string; title: string }) => void
  /**
   * Every tab the lower pane has beside the orchestrator's, whoever opened
   * one: the terminals, and the chats, which carry no project.
   */
  onTerminals?: (terminals: { id: string; project: string; name: string }[]) => void
}

export class Live {
  private readonly opts: LiveOptions
  private readonly journal: TadeEvent[] = []
  private snapshots: TaskSnapshot[] = []
  /** Tade's own tool servers, as the last poll that could look found them. */
  servers: Workspace['toolServers'] = { looked: false, alive: 0 }
  /**
   * What the last look said, kept whole rather than only taken apart.
   *
   * Everything else here is a *piece* of one of these, pulled out for the
   * drawing that needed it; the away view needs the shapes themselves, and may
   * not go and ask — reading `collectStatus` or the supervisor again per page
   * refresh would double the `git` and `ps` work this beat already did and
   * give two answers to one question. Keeping the references costs nothing:
   * both were alive for the length of the refresh anyway. `null` before the
   * first look is `unknown`, and is not an empty workspace — which everything
   * above would read as "nothing is running".
   */
  private seen: Workspace | null = null
  private approvals: PendingApproval[] = []
  /** Where each task lives on disk, which is what parking one needs. */
  private readonly worktrees = new Map<string, string>()
  /** The last listing of each folder, so the sidebar is not a disk read. */
  private readonly listings = new Map<string, { at: number; entries: Listed[] }>()
  /** What git says about the files of each folder the tree is showing, as last looked. */
  private readonly marks = new Map<string, { at: number; marks: Record<string, string> }>()
  /** The branch each project's checkout was last seen on, and whether a look is under way. */
  private readonly branches = new Map<string, { at: number; branch: string | null }>()
  /** The last look at what is changed in a checkout, by place and base, and whether one is under way. */
  private readonly changed = new ChangesHeld()
  private readonly looking = new Set<string>()
  /** What status said of each checkout it looks at, by where it is (`treesFrom`). */
  private trees = new Map<string, TreeSaid>()
  /**
   * Looks a reader found due, waiting for the window's next look to start
   * them (`lookAgain`). Keyed by what is looked at, so a reader asked thirty
   * times between two looks queues one.
   */
  private readonly due = new Map<string, () => Promise<void>>()
  /** What a subject has on screen, asked again on every beat (`keepAsking`). */
  private readonly asking = new Map<string, () => void>()
  /** What lets a checkout nobody has touched cost a few stats, not git (`checkout-look.ts`). */
  private readonly gate = new CheckoutGate((root) => toldOf(this.seen, root))
  /** How many times anything this answers has changed: see `revision`. */
  private revisions = 0
  /** The last look's answer and tabs, as said: one the same is not news (`doRefresh`). */
  private answered: string | null = null
  private tabs: string | null = null
  /** The branch each task was started from, as status last saw it. */
  private readonly bases = new Map<string, string>()
  /** The last look at each task's commits and checks, for the ACTIONS tab. */
  private readonly works = new Map<string, { at: number; work: ActionsView }>()
  /** Tasks something was just started in, and until when to look often for it. */
  private readonly hurry = new Map<string, number>()
  private readonly workLooking = new Set<string>()
  /** Each task's branch and how far ahead of its base, for removing it. */
  private readonly facts = new Map<
    string,
    {
      project: string
      branch: string
      ahead: number | null
      workspace: 'checkout' | 'worktree'
      links: readonly { title: string; url: string }[]
    }
  >()
  /**
   * Every `usage` line there has ever been, merged where nothing could tell two
   * apart (`UsageFold`): the Spend page offers the whole journal as a range,
   * and a list cut to a week is a range that quietly answers a different question.
   */
  private readonly usage: UsageFold
  /** The last spend fold, and the day and the event count it was of. */
  private spent: { since: number; of: number; report: SpendReport } | null = null
  /** The last runtime fold: the day, the run events and the moment it was of. */
  private ran: { since: number; of: number; at: number; report: RuntimeReport } | null = null
  /**
   * When commits and check runs were last picked up. Opening the workbench
   * has just done it, so the window's own first look is a minute away.
   */
  private lookedAtLanded = 0
  /**
   * How long anything has run, folded from the whole journal rather than a
   * window of it: a run that began last week and is still going is time spent
   * today, and a time filter would drop the start it is measured from.
   */
  private readonly runtime = new RuntimeFold()
  /** Which tasks have finished, from the whole journal: the last 500 events forget. */
  private finished = new Map<string, Finished>()
  /** Which tasks' agents have ended a turn since they last started. */
  private worked = new Set<string>()
  /** Tasks whose own rule is met and not yet written down, as the last refresh saw. */
  private met: { task: string; rule: DoneRule }[] = []
  /** Tasks whose agent has ever started: queued work that has started is not queued. */
  private started = new Set<string>()
  /** What the queue reads: removals, runs and their ends, failures, every choice about queued work. */
  private readonly queueEvents: TadeEvent[] = []
  /** What each schedule and watch has done, kept as a tally and its newest (`schedule-fold.ts`). */
  private readonly schedules = new ScheduleFold()
  /** Every line that wrote where a project lives, from the whole journal: what reopening reads. */
  private roots: TadeEvent[] = []
  /** Queued work, and what it waits on, as the last refresh saw. */
  private queue: Queued[] = []
  private states = new Map<string, { state: TaskState; reason: string }>()
  private upstreams = new Map<string, Upstream>()
  /** What each project's tree said the last time work was about to start in it. */
  private realities = new Map<string, Reality>()
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  /** The whole-history lists being read (`histories.ts`), which the first look waits on. */
  private reading: Promise<void> = Promise.resolve()
  /** Whether they have been: before it, a figure folded out of them is unknown, not nought. */
  private read = false
  /** Events heard while they were being read, counted once they have been. */
  private heard: TadeEvent[] | null = []
  /** The newest event the lists held: one at or under it was already counted by them. */
  private upTo = 0
  /** The first look that could (`hasLooked`), for whoever needs the tasks before going on. */
  readonly looked: Promise<void>
  private landed: () => void = () => {}
  /** Where status is looked at, and the gate that lets a quiet worktree cost a `stat` (`collector.ts`). */
  private readonly looker: StatusCollector

  private constructor(opts: LiveOptions) {
    this.opts = opts
    this.usage = new UsageFold(opts.openedAt ?? this.now())
    this.looker = opts.status ?? makeCollector('here')
    this.looked = new Promise((resolve) => {
      this.landed = resolve
    })
  }

  /**
   * Open on what there is and fill in as it arrives: neither the journal's
   * whole-history lists nor the first look at status are waited for here, so
   * the window draws its first frame — *looking…* — before either. The first
   * look waits for the lists instead (`doRefresh`), and `looked` is when it
   * has landed.
   */
  static async start(opts: LiveOptions): Promise<Live> {
    const live = new Live(opts)
    // Heard from before the lists are read, so nothing appended meanwhile is
    // missed, and held until they have been, so nothing is counted twice.
    opts.client.subscribe((event) => live.hear(event))
    live.reading = readHistories(opts.client).then((read) => live.use(read))
    // Opening the workbench has just looked at what landed while Tade was
    // shut, so the window's own beat starts a minute from here.
    live.lookedAtLanded = live.now()
    void live.refresh()
    live.timer = setInterval(() => void live.refresh(false), opts.pollMs ?? 2_000)
    live.timer.unref?.()
    return live
  }

  /** An event, as the journal says it: held while the lists are read, then counted once. */
  private hear(event: TadeEvent): void {
    if (this.heard) this.heard.push(event)
    else if (event.seq > this.upTo) this.record(event)
  }

  /** The whole-history lists, read: kept, and what was heard meanwhile counted after them. */
  private use(read: Histories): void {
    this.journal.push(...read.recent)
    for (const event of read.usage) this.usage.add(event)
    this.finished = finishedFrom(read.told)
    this.worked = workedFrom(read.told)
    for (const event of read.runs) this.runtime.add(event)
    for (const event of read.queue) {
      if (SCHEDULE_LINES.includes(event.type)) this.schedules.add(event)
      else this.queueEvents.push(event)
      if (event.type === 'run_started' && event.task) this.started.add(event.task)
    }
    this.roots = read.roots
    for (const why of read.failed) this.opts.onWarning?.(why)
    this.upTo = read.upTo
    this.read = true
    this.revisions++
    const heard = this.heard ?? []
    this.heard = null
    for (const event of heard) this.hear(event)
  }

  /** Whether the first look at status has landed: before it, what is running is unknown. */
  get hasLooked(): boolean {
    return this.seen !== null
  }

  /** Read the config again: a project opened from the window is status's to see at once. */
  useConfig(config: Config): void {
    this.revisions++
    this.opts.config = config
    void this.refresh()
  }

  /** What the last look said, whole, or null before there has been one. */
  get world(): Workspace | null {
    return this.seen
  }

  /** The approvals waiting, as it found them. Their ids, which the drawing drops. */
  get pending(): readonly PendingApproval[] {
    return this.approvals
  }

  get tasks(): TaskSnapshot[] {
    return this.snapshots
  }

  /**
   * The changes that span repositories, folded out of what the task files say
   * — never a table, so a task removed leaves its effort correctly smaller.
   */
  get efforts(): Effort[] {
    return effortsIn(
      this.snapshots.map((task) => ({
        id: task.task,
        project: task.task.split('/')[0] ?? task.task,
        state: task.state,
        ...(task.effort ? { effort: task.effort } : {}),
      })),
      new Set(this.finished.keys()),
    )
  }

  /** Work made and waiting to start, oldest first, as the last look saw it. */
  get queued(): readonly Queued[] {
    return this.queue
  }

  /** Everything the queue's rules read, as of now. */
  queueFacts(): QueueFacts {
    return {
      tasks: this.states,
      finished: this.finished,
      events: this.queueEvents,
      now: this.now(),
      reality: this.realities,
    }
  }

  /**
   * Look at the tree of every project something is about to start in, and
   * keep what it says. The guess in a task file was written when the work was
   * planned; this is the same files now, and an agent that started since has
   * been changing them all along.
   *
   * Only where the rule already says work is ready, which is rarely: two git
   * calls at the moment of starting, and none at all while a queue waits.
   */
  async lookAtTrees(items: readonly Queued[]): Promise<void> {
    const facts = this.queueFacts()
    const want = new Set<string>()
    for (const item of items) {
      if (queueStanding(item, facts).kind === 'ready') want.add(item.project)
    }
    // Replaced, never merged: what a project's tree said an hour ago, when
    // something else was about to start, is not evidence about anything now.
    const looked = new Map<string, Reality>()
    await Promise.all(
      [...want].map(async (project) => looked.set(project, await this.lookAtTree(project))),
    )
    this.realities = looked
  }

  /** What one project's tree says now: who is at work in it, and what has moved. */
  private async lookAtTree(project: string): Promise<Reality> {
    // This project's answer, never the machine's: with one project in a
    // worktree each and another sharing its checkout, a look that asked the
    // machine held the wrong one and read the wrong tree for the other.
    const workspace = workspaceFor(this.opts.config, project)
    // The tasks as the last look listed them, each with its own workspace.
    const facts = { tasks: this.upstreams, finished: this.finished }
    const at = atWorkFrom(this.queueEvents, project, facts)
    const working = [...at.keys()].sort()
    const bare: Reality = { workspace, working, dirty: [], committed: [] }
    // In worktrees nothing is changed under anybody, so there is nothing to
    // read: the branch is the answer, not the tree.
    if (workspace !== 'checkout') return bare
    const root = this.opts.config.projects[project]?.root
    if (!root || working.length === 0) return bare
    return { workspace, working, ...(await treeIn(root, at)) }
  }

  /** What each task could hand queued work to begin from: its branch, where it is, its rule. */
  get upstream(): ReadonlyMap<string, Upstream> {
    return this.upstreams
  }

  /** How many times a schedule has run, from the whole journal, and its newest runs, oldest first. */
  runsOf(schedule: string): ScheduleRuns {
    return this.schedules.runsOf(schedule)
  }

  /** What a watch schedule has done — its newest looks, everything it found, where it looks next. */
  watchedOf(schedule: string): Watched {
    return this.schedules.watchedOf(schedule)
  }

  /** Tasks whose own rule was met at the last look and not yet written down: the window's to write. */
  get rulesMet(): readonly { task: string; rule: DoneRule }[] {
    return this.met
  }

  /** Whether a task's agent has ended a turn since it last started (`workedFrom`). */
  hasWorked = (task: string): boolean => this.worked.has(task)

  get history(): WorkHistory {
    return historyFrom(this.journal, this.now())
  }

  /** What has happened recently, for anything that has to read it directly. */
  get events(): readonly TadeEvent[] {
    return this.journal
  }

  /** Every `config_changed` about where a project lives, from the whole journal. */
  get rootLines(): readonly TadeEvent[] {
    return this.roots
  }

  /** Where a task lives on disk, once status has seen it. */
  worktreeOf(task: string): string | null {
    return this.worktrees.get(task) ?? null
  }

  /** What one agent has been doing, from the journal. */
  workOn(task: string): WorkSummary {
    return summariseWork(this.journal, task, this.now())
  }

  /**
   * How many times anything this answers has changed: an event recorded, a
   * refresh, the config, a look that came back different.
   *
   * What a subject keys a kept answer on (`wire/kept.ts`), beside what it
   * read of the window's own state — the same revision is the same answers,
   * which is what makes keeping one safe. Never a clock: a kept answer that
   * expired on a timer would be a stale one between the change and the timer.
   */
  get revision(): number {
    return this.revisions
  }

  /**
   * Start every look a reader found due since the last call. The window's
   * look calls it, which is the one place git and the disk are asked for what
   * these readers answer.
   *
   * The readers used to start the look themselves, and a reader is read in the
   * frame: `files`, `marksAt`, `changesAt` and `branchAt` all from the Files
   * subject's facts, so every couple of seconds one frame forked three or four
   * `git`s on its way to the screen. A fork is synchronous on the thread that
   * draws — 9ms at the 95th percentile of the fold, 25 at the worst, on an idle
   * window. Now a frame only ever answers, and what it found due is started a
   * look later: the same looks, as often, and none of them inside a frame.
   *
   * Settles when every look it started has, which only a test waits for.
   */
  lookAgain(): Promise<void> {
    if (this.due.size === 0) return Promise.resolve()
    const due = [...this.due.values()]
    this.due.clear()
    return Promise.all(due.map((look) => look())).then(() => {})
  }

  /**
   * Queue a look for the next `lookAgain`, once however often it is asked,
   * and ask for that look soon when nothing else was waiting.
   */
  private lookSoon(key: string, look: () => Promise<void>): void {
    if (this.due.has(key)) return
    this.due.set(key, look)
    if (this.due.size === 1) this.opts.onDue?.()
  }

  /**
   * Ask `ask` — a subject's reading of what it has on screen — again on every
   * beat, whether or not a frame has read it since.
   *
   * A reader only says a look is due when it is read, and it is read in a
   * frame; and a window nobody is touching draws no frames, because a beat
   * that found what the last one did is not news (`onTasks`). So what is on
   * screen would go stale behind a still window — CHANGES missing the file you
   * just saved — without a door that asks for it on the beat instead.
   */
  keepAsking(name: string, ask: () => void): void {
    this.asking.set(name, ask)
  }

  /** Something this answers is not what it was: counted (`revision`), and said, so it is drawn. */
  private told(): void {
    this.revisions++
    this.opts.onChange?.()
  }

  /**
   * The files under a folder — an agent's worktree, or the project itself when
   * no agent is in front of you — with the folders you opened listed under
   * themselves. Each folder is read at most once per `LISTING_MS`, and never
   * from here: the window draws up to thirty times a second, and the disk is
   * read on its next look (`lookAgain`), like everything else these answer.
   * `null` until the folder itself has been read: not looked is not empty.
   */
  files(root: string | null, expanded: readonly string[]): FileEntry[] | null {
    if (!root) return []
    const tree = treeOf(expanded, (folder) => this.listing(join(root, folder)))
    return this.listings.has(join(root, '')) ? tree : null
  }

  private listing(dir: string): Listed[] {
    const seen = this.listings.get(dir)
    if (!seen || this.now() - seen.at >= LISTING_MS) {
      this.lookSoon(`listing\0${dir}`, async () => this.list(dir))
    }
    return seen?.entries ?? []
  }

  /** Read a folder, and say so where it is not what it was. */
  private list(dir: string): void {
    const was = this.listings.get(dir)?.entries
    let entries: Listed[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        folder: entry.isDirectory(),
      }))
    } catch {
      // A worktree removed under us is not worth a warning: the next status
      // pass stops listing its agent at all.
    }
    this.listings.set(dir, { at: this.now(), entries })
    const same =
      was?.length === entries.length &&
      was.every((one, at) => one.name === entries[at]?.name && one.folder === entries[at]?.folder)
    if (!same) this.told()
  }

  /**
   * What git says about each file under a folder — changed, new, conflicted —
   * for marking them in the tree. From the last look; looks again in the
   * background, like everything else drawn four times a second, and asks git
   * only where the checkout has moved (`CheckoutGate`).
   */
  marksAt(root: string | null): Readonly<Record<string, string>> {
    if (!root) return {}
    // Status has just run `git status` on a tree an agent works in: its word is the marks.
    const said = this.trees.get(resolve(root))
    if (said) return said.marks
    const seen = this.marks.get(root)
    if (!seen || this.now() - seen.at >= LISTING_MS) {
      this.lookSoon(`marks\0${root}`, () => this.lookAtMarks(root))
    }
    return seen?.marks ?? {}
  }

  private async lookAtMarks(root: string): Promise<void> {
    const seen = this.marks.get(root)
    this.marks.set(root, { at: this.now(), marks: seen?.marks ?? {} })
    const named = Object.keys(seen?.marks ?? {})
    const marks = await this.gate
      .ask(`marks\0${root}`, root, named, this.now(), () => marksIn(root))
      .catch(() => null)
    if (marks === null || marks === STILL) return
    this.marks.set(root, { at: this.now(), marks })
    if (JSON.stringify(marks) !== JSON.stringify(seen?.marks ?? {})) this.told()
  }

  /** The project checkout's branches, newest first, and the one it is on. */
  branchesOf(root: string): Promise<{ name: string; current: boolean; when: string }[]> {
    return branchesIn(root)
  }

  /**
   * The branch a project's own checkout is on. Answers from the last look and
   * looks again in the background, for the same reason `changes` does.
   */
  branchAt(root: string): string | null {
    const seen = this.branches.get(root)
    if (!seen || this.now() - seen.at >= BRANCH_MS) {
      this.lookSoon(`branch\0${root}`, () => this.lookAtBranch(root))
    }
    return seen?.branch ?? null
  }

  private async lookAtBranch(root: string): Promise<void> {
    const seen = this.branches.get(root)
    this.branches.set(root, { at: this.now(), branch: seen?.branch ?? null })
    // Wrapped, because no branch at all — a detached HEAD — is an answer.
    const asked = await this.gate
      .ask(`branch\0${root}`, root, [], this.now(), async () => ({ branch: await branchOf(root) }))
      .catch(() => null)
    if (asked === null || asked === STILL) return
    this.branches.set(root, { at: this.now(), branch: asked.branch })
    if (asked.branch !== seen?.branch) this.told()
  }

  /**
   * What a task has done, for the ACTIONS tab: the commits that carry its own
   * trailer, what is changed and not committed, and how its project's checks
   * stand at the commit in hand — including a run going on right now.
   *
   * Answers from the last look at once and looks again in the background,
   * like everything else here: the window draws four times a second and must
   * never wait on git, or on a file, to do it. While a run is going the look
   * comes round faster, because a page you are watching a suite on is a page
   * that has to move.
   */
  actions(task: string | null, review: ActionsView['review'] = null): ActionsView | null {
    if (!task) return null
    const root = this.worktrees.get(task)
    if (!root) return null
    const seen = this.works.get(task)
    const expecting = (this.hurry.get(task) ?? 0) > this.now()
    const every = seen?.work.running || expecting ? WORK_RUNNING_MS : WORK_MS
    if ((!seen || this.now() - seen.at >= every) && !this.workLooking.has(task)) {
      this.lookSoon(`actions\0${task}`, async () => {
        if (this.workLooking.has(task)) return
        this.workLooking.add(task)
        await lookAtWork({
          task,
          root,
          base: this.bases.get(task) ?? null,
          facts: this.facts.get(task) ?? null,
          config: this.opts.config,
          tadeHome: this.opts.tadeHome,
          now: this.now(),
        })
          .then((work) => {
            const was = this.works.get(task)?.work
            this.works.set(task, { at: this.now(), work })
            // Said only where it moved: a look every ten seconds is not news.
            if (JSON.stringify(work) !== JSON.stringify(was)) this.told()
          })
          .catch(() => {})
          .finally(() => this.workLooking.delete(task))
      })
    }
    if (!seen) return null
    // What status already knows is taken from it rather than looked up again:
    // it is polled every couple of seconds anyway.
    const facts = this.facts.get(task)
    return {
      ...seen.work,
      ahead: facts?.ahead ?? seen.work.ahead,
      dirty: this.trees.get(resolve(root))?.dirty ?? seen.work.dirty,
      shared: facts ? facts.workspace === 'checkout' : seen.work.shared,
      review: review ?? seen.work.review,
    }
  }

  /**
   * What the last look at a task's work said, and nothing more.
   *
   * `actions` answers and then looks again in the background; this only ever
   * answers. Search composes what is happening for every task on every
   * keystroke, and a look is git — so what has not been looked at is `null`
   * here rather than a reason to go and find out.
   */
  seenActions(task: string): ActionsView | null {
    return this.works.get(task)?.work ?? null // never `actions`: that looks
  }

  /**
   * Something was just started in this task's tree, so look often for a
   * while: between the button and the run writing anything down there is a
   * moment, and the ten-second look would spend it saying nothing happened.
   */
  hurryUp(task: string): void {
    this.hurry.set(task, this.now() + HURRY_MS)
  }

  /**
   * What a task has changed: where it works, measured from where it branched.
   * A task names a place and a base, and the answer is about the place — so an
   * agent sharing the project's checkout sees everything uncommitted in it,
   * whoever changed it. Not looked at yet reads as none here; what the side
   * draws is `changesAt`'s answer, which can say it has not looked.
   */
  changes(task: string | null): readonly Change[] {
    if (!task) return []
    const root = this.worktrees.get(task)
    if (!root) return []
    return this.changesAt(root, this.bases.get(task) ?? null) ?? []
  }

  /**
   * What is changed in a checkout: measured from `base` where there is one, and
   * from `HEAD` — plain `git status`, in other words — where there is not.
   *
   * Keyed by the place and the base, never by a task, because a change in a
   * checkout is a change whoever made it. Keyed by a task it was nobody's: with
   * no agent in front of you there was no task to ask about, so the view read
   * nothing at all and an edit the orchestrator made by hand was invisible —
   * not stale, never looked for.
   *
   * Answers from the last look at once, and looks again in the background when
   * that is stale: the window draws four times a second and must never wait on
   * git to do it. A look that comes back the same as the last one redraws
   * nothing, like `marksAt` and `branchAt` — this is read every frame now,
   * agent or not, so a beat that always redraws would be a beat that never rests.
   * And a look asks git only where the checkout has moved (`CheckoutGate`).
   * `null` until a look has answered, which the side draws as `…`, never as
   * "nothing changed".
   */
  changesAt(root: string | null, base: string | null): readonly Change[] | null {
    if (!root) return []
    const key = JSON.stringify([root, base])
    const at = this.changed.at(key)
    if ((at === null || this.now() - at >= LISTING_MS) && !this.looking.has(key)) {
      this.lookSoon(`changes\0${key}`, async () => {
        if (this.looking.has(key)) return
        this.looking.add(key)
        const named = this.changed.named(key)
        // The files git does not track are status's to say, where it looks at this tree.
        const asks = !this.trees.has(resolve(root))
        const looked = await this.gate
          .ask(`changes\0${key}`, root, named, this.now(), () => changesIn(root, base, asks))
          .catch(() => null)
          .finally(() => this.looking.delete(key))
        // Still standing is a look that was had: not again until it is stale.
        if (looked !== null && this.changed.keep(key, looked, this.now())) this.told()
      })
    }
    return this.changed.answer(key, this.trees.get(resolve(root))?.untracked)
  }

  /** A task's branch, its project, and how many commits it has that its base does not. */
  factsOf(task: string): {
    project: string
    branch: string
    ahead: number | null
    /** Where it works: the project's checkout with the others, or a worktree of its own. */
    workspace: 'checkout' | 'worktree'
    /** Where the work came from: an issue, a trace. */
    links: readonly { title: string; url: string }[]
  } | null {
    return this.facts.get(task) ?? null
  }

  /** One file's diff, from a root and a base like `changesAt` and `marksAt` (`diffIn`). */
  diffAt(root: string, base: string | null, path: string): Promise<string | null> {
    return diffIn(root, base, path)
  }

  /** The branch a task's changes are counted against: `main`, usually. */
  baseOf(task: string | null): string | null {
    return task ? (this.bases.get(task) ?? null) : null
  }

  /** What you have told Tade that applies to a project, and is still told to anybody. */
  notes(project: string | null): NoteShown[] {
    return notesShown(this.opts.client.recallAll(), project)
  }

  /** What was retired from that, read on asking: the side's RETIRED NOTES. */
  retiredNotes(project: string | null): NoteShown[] {
    const all = this.opts.client.recallAll({ retired: true })
    return notesShown(
      all.filter((note) => note.retired),
      project,
    )
  }

  /** Every `usage` line the journal holds, merged, for the Spend page's own ranges. */
  get spending(): UsageFold {
    return this.usage
  }

  /** How long every run there has been took, for the Spend page to ask of its own ranges. */
  get runs(): RuntimeFold {
    return this.runtime
  }

  /** What an agent last said it runs on. */
  vitals(
    task: string | null,
  ): { model: string | null; thinking: string | null; contextPercent: number | null } | null {
    const vitals = task ? this.opts.client.vitals(task) : null
    return vitals
      ? { model: vitals.model, thinking: vitals.thinking, contextPercent: vitals.contextPercent }
      : null
  }

  /**
   * What has been spent since midnight, in total and by task.
   *
   * Folded once per event rather than once per frame. `spendFrom` is pure and
   * `usage` is only ever added to, so the same count of events over the same day
   * is the same answer — and this is read from `facts()`, which is four times a
   * second, over every usage event there has ever been. Twenty-four thousand of
   * them was 3% of a core spent re-deriving a number that only moves when an
   * agent spends something, and on an idle window nothing ever does. The list
   * is the whole journal now, which makes the kept fold worth more rather than
   * less: it is the Spend page's longest range that put it there. Null until
   * the lists are read: what was spent is unknown then, never nothing.
   */
  spendToday(): SpendReport | null {
    if (!this.read) return null
    const since = startOfToday(this.now())
    const spent = this.spent
    if (spent && spent.since === since && spent.of === this.usage.size) return spent.report
    // Priced the same way the Spend page prices it, so the strip's figure and
    // the page's are one number: a harness that says it prices nothing still
    // has a rate for the model it ran on.
    const report = spendFrom(this.usage.events, {
      since,
      prices: pricesFrom(this.opts.config.prices),
    })
    this.spent = { since, of: this.usage.size, report }
    return report
  }

  /**
   * How long the agents have run since midnight, in total and by task.
   *
   * Kept as `spendToday` is, over every run event there has ever been: the
   * same events over the same day are the same answer — except that a run
   * still going counts up with the clock. It is drawn to the second, so while
   * one runs it is folded again each second, and never while none does. Null
   * until the lists are read, as `spendToday` is.
   */
  runtimeToday(): RuntimeReport | null {
    if (!this.read) return null
    const now = this.now()
    const since = startOfToday(now)
    const ran = this.ran
    const still =
      ran?.since === since &&
      ran.of === this.runtime.size &&
      (!ran.report.total.running || Math.floor(ran.at / 1000) === Math.floor(now / 1000))
    if (ran && still) return ran.report
    const report = this.runtime.report({ since, now })
    this.ran = { since, of: this.runtime.size, at: now, report }
    return report
  }

  /** A rendered snapshot of a lane's screen, or nothing if it has none. */
  async capture(lane: string | null, lines: number, styled = false): Promise<string> {
    if (!lane) return ''
    try {
      return await this.opts.client.capture(lane as never, lines, styled)
    } catch {
      // A lane that just exited is not an error worth showing.
      return ''
    }
  }

  /**
   * How far back a lane can be read, and where typing appears in it — what a
   * scrollbar and a cursor are drawn from. Nothing when it has no lane, or
   * when the lane went away while we asked.
   */
  async screen(lane: string | null): Promise<LaneScreen | null> {
    if (!lane) return null
    try {
      return await this.opts.client.screen(lane as never)
    } catch {
      return null
    }
  }

  /**
   * Ask everything again. Never throws: the window must keep drawing.
   *
   * A look somebody asked for is news whatever it finds, as every look was:
   * whoever asks has usually just changed something on screen and is waiting
   * on it. Only the beat's own (`asked: false`) is held to having found
   * something the last look did not.
   */
  async refresh(asked = true): Promise<void> {
    if (asked) this.answered = null
    // What is on screen, asked about again (`keepAsking`) — every beat, even
    // one a slow look is still answering — and a reading that threw is said.
    for (const ask of this.asking.values()) {
      try {
        ask()
      } catch (err) {
        this.opts.onWarning?.(err instanceof Error ? err.message : String(err))
      }
    }
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
      // After the refresh is let go of, so whoever waited on `looked` and asks
      // again is asking for a new look rather than handed this one.
      if (this.seen) this.landed()
    })
    return this.refreshing
  }

  /**
   * The lower pane's tabs (`tabsFrom`), said only where they moved, like the
   * tasks. Read off the registry as they are said, never as a look began: the
   * window asks the moment it opens one, and a look begun before that must
   * not take the tab away again.
   */
  tabsNow(): void {
    const tabs = tabsFrom(this.opts.client.lanes())
    if (JSON.stringify(tabs) === this.tabs) return
    this.tabs = JSON.stringify(tabs)
    this.opts.onTerminals?.(tabs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.opts.status) await this.looker.close()
  }

  private async doRefresh(): Promise<void> {
    void this.lookAtWhatLanded()
    try {
      const [answer, pending, lanes] = await Promise.all([
        livenessTableFrom(this.opts.client).then((table) =>
          this.looker.collect({
            config: this.opts.config,
            now: this.now(),
            home: this.opts.home,
            tadeHome: this.opts.tadeHome,
            pr: false,
            // Every beat, and held a while by whoever looks (`PORTS_MS`): a dev server's link.
            ports: true,
            cwd: this.opts.cwd,
            lanes: table,
          }),
        ),
        this.opts.client.pendingApprovals(),
        this.opts.client.lanes(),
        // Beside the look rather than before it: whether a task is done and
        // whether queued work has started are folded out of the lists.
        this.reading,
      ])
      // Unknown is said, and the last look that could stands in, with this window's own
      // approvals and lanes: never an empty world. Before any look, `unknown` stays.
      if (!answer.known) this.opts.onWarning?.(answer.why)
      const workspace = answer.known ? answer.workspace : this.seen
      if (!workspace) return
      this.servers = workspace.toolServers
      this.seen = workspace
      this.approvals = pending
      for (const project of workspace.projects) {
        for (const task of project.tasks) {
          this.worktrees.set(task.id, task.worktree)
          if (task.git?.baseRef) this.bases.set(task.id, task.git.baseRef)
          this.facts.set(task.id, {
            project: project.name,
            branch: task.branch,
            ahead: task.git?.ahead ?? null,
            workspace: task.workspace === 'checkout' ? 'checkout' : 'worktree',
            links: task.links ?? [],
          })
          const worked = (task.git?.dirty.length ?? 0) > 0 || (task.git?.ahead ?? 0) > 0
          // Only an agent with a worktree of its own: the checkout's branch is everyone's.
          if (!task.branch && worked && task.workspace !== 'checkout') {
            this.opts.onWork?.({
              id: task.id,
              project: project.name,
              worktree: task.worktree,
              title: task.title ?? task.id.split('/').at(-1) ?? task.id,
            })
          }
        }
      }
      this.tabsNow()
      this.met = []
      this.queue = []
      this.states = new Map()
      this.upstreams = new Map()
      for (const project of workspace.projects) {
        for (const task of project.tasks) {
          this.states.set(task.id, { state: task.state, reason: task.reason })
          this.upstreams.set(task.id, {
            workspace: task.workspace === 'checkout' ? 'checkout' : 'worktree',
            branch: task.branch,
            head: task.git?.head ?? null,
            done: task.done ?? 'said',
          })
          if (task.start && !this.started.has(task.id)) {
            // `parked` comes from the task file rather than from `state`,
            // which a merge is ahead of: the queue's rule needs the told fact.
            this.queue.push({
              task: task.id,
              project: project.name,
              parked: task.parked === true,
              start: task.start,
              ...(task.by ? { by: task.by } : {}),
            })
          }
          const rule = task.done
          if (!rule || this.finished.has(task.id)) continue
          const facts = {
            state: task.state,
            reason: task.reason,
            workspace:
              task.workspace === 'checkout' ? ('checkout' as const) : ('worktree' as const),
            worked: this.worked.has(task.id),
          }
          if (ruleMet(rule, facts)) this.met.push({ task: task.id, rule })
        }
      }
      const facts = this.queueFacts()
      const queued = new Map<string, QueuedView>()
      for (const item of this.queue) {
        const at = item.start.at ? Date.parse(item.start.at) : Number.NaN
        queued.set(item.task, {
          state: queueStateOf(item, facts),
          after: item.start.after,
          prompt: item.start.prompt,
          touches: item.start.touches,
          at: Number.isFinite(at) ? at : null,
        })
      }
      // News is a look that says something the last did not. One that found
      // what the last found keeps `revision`, so every answer kept on it stays
      // kept, and is drawn by nobody: it was ~0.7 frames a second on a window
      // nobody touched. `generatedAt` is the one part of a look that always moves.
      const snapshots = snapshotsFrom(workspace, pending, lanes, this.finished, queued)
      const said = JSON.stringify([{ ...workspace, generatedAt: '' }, pending, snapshots])
      const moved = said !== this.answered
      if (moved) {
        this.answered = said
        this.revisions++
        this.snapshots = snapshots
        this.trees = treesFrom(workspace, this.trees)
        for (const warning of workspace.warnings) this.opts.onWarning?.(warning)
      }
      this.opts.onTasks?.(this.snapshots, moved)
    } catch (err) {
      this.opts.onWarning?.(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Write down commits and check runs that have landed since the last look.
   *
   * Opening the window is not the only time work gets committed: agents commit
   * all morning, and a page that only learns about it at the next open says
   * "nothing committed in this window" on a window full of commits. `git log`
   * is a query and both records are keyed — by sha, by run id — so looking
   * again is idempotent and only ever adds.
   *
   * On its own slow beat, because this shells out to git per project and the
   * refresh beat is two seconds. Nothing waits on it and nothing fails
   * because of it: counting what was produced may never be why the window
   * stops drawing.
   */
  private async lookAtWhatLanded(): Promise<void> {
    const now = this.now()
    if (now - this.lookedAtLanded < LANDED_MS) return
    this.lookedAtLanded = now
    // Through a promise rather than straight at it: a client that cannot do
    // this at all must be a look that found nothing, not an unhandled throw
    // out of the frame loop.
    await Promise.resolve()
      .then(() => this.opts.client.lookAtCommits())
      .catch(() => {})
    await Promise.resolve()
      .then(() => this.opts.client.lookAtChecks())
      .catch(() => {})
  }

  private record(event: TadeEvent): void {
    this.revisions++
    this.journal.push(event)
    this.usage.add(event)
    if ((RUNTIME_READS as readonly string[]).includes(event.type)) this.runtime.add(event)
    if (event.task && event.type === 'task_done') {
      for (const [task, done] of finishedFrom([event])) this.finished.set(task, done)
    }
    if (event.task && event.type === 'run_started') {
      this.worked.delete(event.task)
      this.started.add(event.task)
    }
    if (event.task && event.type === 'turn_done') this.worked.add(event.task)
    if (SCHEDULE_LINES.includes(event.type)) this.schedules.add(event)
    else if ((QUEUE_READS as readonly string[]).includes(event.type)) this.queueEvents.push(event)
    if (aboutRoot(event)) this.roots.push(event)
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    this.opts.onEvent?.(event)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
