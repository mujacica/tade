import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { readOutcome, settled } from '@tade/checks-core'
import {
  type Config,
  type DoneRule,
  type Effort,
  effortsIn,
  type Finished,
  finishedFrom,
  historyFrom,
  type KnownTask,
  type Note,
  pricesFrom,
  type Queued,
  type QueueFacts,
  queueStanding,
  queueStateOf,
  type Reality,
  RUNTIME_EVENTS,
  type RuntimeReport,
  ruleMet,
  runtimeFrom,
  type SpendReport,
  spendFrom,
  startOfToday,
  summariseWork,
  type TadeEvent,
  type TaskState,
  type Upstream,
  type Watched,
  type WorkHistory,
  type WorkSummary,
  type Workspace,
  watchedFrom,
  workedFrom,
  workspaceFor,
} from '@tade/core'
import type { LaneScreen, PointerReport, WheelTurn } from '@tade/drivers-core'
import { collectStatus, git } from '@tade/status'
import { chatsFrom, terminalsFrom, type Workbench } from '@tade/workbench'
import { checksAt } from '@tade/workbench/checks'
import { livenessFrom } from '@tade/workbench/lane-liveness'
import type { LaneRecord } from '@tade/workbench/registry'
import type { PendingApproval } from '@tade/workbench/workers'
import { type FileEntry, type Listed, marksFrom, treeOf } from './files.ts'
import type { ActionsView, Change, CheckView, CommitView, NoteShown } from './frame.ts'
import type { QueuedView, TaskSnapshot } from './model.ts'
import { branchOf } from './projects.ts'
import {
  CHANGED_FORMAT,
  changedFrom,
  changesFrom,
  commitsFrom,
  plainly,
  snapshotsFrom,
} from './reality.ts'

// Reached for alongside `Live` by everyone who reaches for either, so it is
// still here to be imported from: what moved to `reality.ts` was where these
// are written, not who asks for them.
export { knownTasks, snapshotsFrom } from './reality.ts'

// Where the app gets its facts.
//
// Status is a query, so this polls rather than keeping its own idea of the
// world, and the journal it accumulates is what lets the resolver answer
// "which one did you mean".

/** How much journal to keep for working out what recently moved. */
const JOURNAL = 500

/**
 * How often commits and check runs that have landed since are written down.
 *
 * A minute, not the refresh beat: this shells out to `git log` once per
 * project, and what it is watching for — somebody finishing a commit — does
 * not move faster than that. The refresh beat is two seconds, and thirty git
 * invocations a minute to notice one commit is the opposite of light.
 */
const LANDED_MS = 60_000

/** What decides where queued work stands, read from the whole journal rather than its tail. */
const QUEUE_READS = [
  'task_removed',
  'run_started',
  'run_exited',
  'failed',
  'queue_started',
  'queue_held',
  'queue_changed',
  'schedule_fired',
  // What a watch has found, which is never forgotten: one finding, one piece of work.
  'watch_checked',
  'watch_found',
] as const

/**
 * What runtime is derived from: when an agent started and stopped, when its
 * lane went, and when the window that was watching it did — a run nobody wrote
 * an exit for ended when Tade closed, not at breakfast the next morning. The
 * list is `runtimeFrom`'s own, so the panel can never read less than it reads.
 */
const RUNTIME_READS = RUNTIME_EVENTS

/** A schedule's runs as the journal has them, newest last. */
export interface ScheduleRun {
  due: number
  ran: boolean
  missed: number
  task: string | null
}

/** How long a folder listing is good for. */
const LISTING_MS = 2_000

/** How many commits one look at a project's tree reads, at the most. */
const COMMITS_READ = 200

/** How long the branch a project's own checkout is on is good for. */
const BRANCH_MS = 10_000

/** How often a task's commits and recorded runs are read again, at the most. */
const WORK_MS = 10_000

/**
 * And while a run is going: a suite you are watching has to move, and what it
 * costs is a small file and the records beside it, not a suite of its own.
 */
const WORK_RUNNING_MS = 1_000

/** How many lines of a failing check's output the page keeps to show you. */
const TAIL_LINES = 40

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
  now?: () => number
  onTasks?: (tasks: TaskSnapshot[]) => void
  onEvent?: (event: TadeEvent) => void
  onWarning?: (message: string) => void
  /** Something drawn from a background look has changed. */
  onChange?: () => void
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
  /** Where each task lives on disk, which is what parking one needs. */
  private readonly worktrees = new Map<string, string>()
  /** The last listing of each folder, so the sidebar is not a disk read. */
  private readonly listings = new Map<string, { at: number; entries: Listed[] }>()
  /** What git says about the files of each folder the tree is showing, as last looked. */
  private readonly marks = new Map<string, { at: number; marks: Record<string, string> }>()
  /** The branch each project's checkout was last seen on, and whether a look is under way. */
  private readonly branches = new Map<string, { at: number; branch: string | null }>()
  /**
   * The last look at what is changed in a checkout, keyed by the place and the
   * base it is measured from, and whether a look is under way.
   */
  private readonly changed = new Map<string, { at: number; changes: Change[] }>()
  private readonly looking = new Set<string>()
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
   * Every `usage` event there has ever been, which is what the Spend page can
   * be asked for: it offers the whole journal as a range, and a list cut to a
   * week is a range that quietly answers a different question.
   */
  private usage: TadeEvent[] = []
  /** The last spend fold, and the day and the event count it was of. */
  private spent: { since: number; of: number; report: SpendReport } | null = null
  /**
   * When commits and check runs were last picked up. Opening the workbench
   * has just done it, so the window's own first look is a minute away.
   */
  private lookedAtLanded = 0
  /**
   * What says how long anything has run, from the whole journal rather than a
   * window of it: a run that began last week and is still going is time spent
   * today, and a time filter would drop the start it is measured from.
   */
  private runEvents: TadeEvent[] = []
  /** Which tasks have finished, from the whole journal: the last 500 events forget. */
  private finished = new Map<string, Finished>()
  /** Which tasks' agents have ended a turn since they last started. */
  private worked = new Set<string>()
  /** Tasks whose own rule is met and not yet written down, as the last refresh saw. */
  private met: { task: string; rule: DoneRule }[] = []
  /** Tasks whose agent has ever started: queued work that has started is not queued. */
  private started = new Set<string>()
  /** What the queue reads: removals, runs, failures, and every choice made about queued work. */
  private queueEvents: TadeEvent[] = []
  /** Queued work, and what it waits on, as the last refresh saw. */
  private queue: Queued[] = []
  private states = new Map<string, { state: TaskState; reason: string }>()
  private upstreams = new Map<string, Upstream>()
  /** What each project's tree said the last time work was about to start in it. */
  private realities = new Map<string, Reality>()
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null

  private constructor(opts: LiveOptions) {
    this.opts = opts
  }

  static async start(opts: LiveOptions): Promise<Live> {
    const live = new Live(opts)
    // Recent history first, so "park it" works the moment the window opens.
    const past = await opts.client.events({ limit: JOURNAL }).catch(() => [])
    live.journal.push(...past)
    // Spend is read on its own: the journal above is the last 500 events, and
    // a busy morning is more than that. All of it, because the Spend page's
    // longest range is the journal itself — the fold that reads it is kept
    // rather than re-done per frame (`wire/spend.ts`), which is what makes
    // that affordable.
    live.usage = await opts.client.events({ types: ['usage'] }).catch(() => [])
    // Finishing is read the same way: whether a task is done cannot depend on
    // how busy the journal has been since.
    const told = await opts.client
      .events({ types: ['task_done', 'run_started', 'turn_done'] })
      .catch(() => [])
    live.finished = finishedFrom(told)
    live.worked = workedFrom(told)
    live.runEvents = await opts.client.events({ types: [...RUNTIME_READS] }).catch(() => [])
    live.queueEvents = await opts.client.events({ types: [...QUEUE_READS] }).catch(() => [])
    for (const event of live.queueEvents) {
      if (event.type === 'run_started' && event.task) live.started.add(event.task)
    }
    await opts.client.subscribe((event) => live.record(event))
    // Opening the workbench has just looked at what landed while Tade was
    // shut, so the window's own beat starts a minute from here.
    live.lookedAtLanded = live.now()
    await live.refresh()
    live.timer = setInterval(() => void live.refresh(), opts.pollMs ?? 2_000)
    live.timer.unref?.()
    return live
  }

  /** Read the config again: a project opened from the window is status's to see at once. */
  useConfig(config: Config): void {
    this.opts.config = config
    void this.refresh()
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
    const at = this.atWork(project)
    const working = [...at.keys()].sort()
    const bare: Reality = { workspace, working, dirty: [], committed: [] }
    // In worktrees nothing is changed under anybody, so there is nothing to
    // read: the branch is the answer, not the tree.
    if (workspace !== 'checkout') return bare
    const root = this.opts.config.projects[project]?.root
    if (!root || working.length === 0) return bare
    const since = [...at.values()].sort((one, other) => one - other)[0]
    const [status, log] = await Promise.all([
      git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      git(root, [
        'log',
        '-n',
        String(COMMITS_READ),
        ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
        `--format=${CHANGED_FORMAT}`,
        '--name-only',
      ]),
    ])
    const committed = new Map<string, Set<string>>()
    for (const commit of log.ok ? changedFrom(log.stdout) : []) {
      // Whose a commit is, is read back out of the trailer that says so —
      // never a table Tade keeps. One without it belongs to nobody.
      if (!at.has(commit.task)) continue
      const paths = committed.get(commit.task) ?? new Set<string>()
      for (const path of commit.paths) paths.add(path)
      committed.set(commit.task, paths)
    }
    return {
      workspace,
      working,
      dirty: status.ok ? Object.keys(marksFrom(status.stdout)).sort() : [],
      committed: [...committed].map(([task, paths]) => ({ task, paths: [...paths].sort() })),
    }
  }

  /**
   * The agents at work in a project now, and when each started — a run the
   * journal opened and never closed. An agent between turns is still in the
   * checkout and still about to change things, which is why this is its run
   * and not whether status happens to call it `working` this second.
   */
  private atWork(project: string): Map<string, number> {
    const open = new Map<string, number>()
    for (const event of this.queueEvents) {
      const task = event.task
      if (!task?.startsWith(`${project}/`)) continue
      if (event.type === 'run_started') open.set(task, Date.parse(event.ts))
      if (event.type === 'run_exited') open.delete(task)
    }
    // Work that is finished is work whatever starts next builds on, not work
    // going on around it.
    for (const task of this.finished.keys()) open.delete(task)
    return open
  }

  /** What each task could hand queued work to begin from: its branch, where it is, its rule. */
  get upstream(): ReadonlyMap<string, Upstream> {
    return this.upstreams
  }

  /** Each schedule's runs, from the whole journal, oldest first. */
  runsOf(schedule: string): ScheduleRun[] {
    return this.queueEvents
      .filter((event) => event.type === 'schedule_fired' && event.detail.schedule === schedule)
      .map((event) => ({
        due: Date.parse(String(event.detail.due ?? event.ts)),
        ran: event.detail.ran !== false,
        missed: typeof event.detail.missed === 'number' ? event.detail.missed : 0,
        task: event.task,
      }))
  }

  /** What a watch schedule has done — its looks, what it found, where it looks next — from the whole journal. */
  watchedOf(schedule: string): Watched {
    return watchedFrom(this.queueEvents, schedule)
  }

  /**
   * Tasks whose own rule — an idle turn, committed work, a merge — was met at
   * the last look and has not been written down. Writing it is the window's.
   */
  get rulesMet(): readonly { task: string; rule: DoneRule }[] {
    return this.met
  }

  get history(): WorkHistory {
    return historyFrom(this.journal, this.now())
  }

  /** What has happened recently, for anything that has to read it directly. */
  get events(): readonly TadeEvent[] {
    return this.journal
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
   * The files under a folder — an agent's worktree, or the project itself when
   * no agent is in front of you — with the folders you opened listed under
   * themselves. Each folder is read at most once per `LISTING_MS`: the window
   * draws four times a second, and must not read the disk every time it does.
   */
  files(root: string | null, expanded: readonly string[]): FileEntry[] {
    if (!root) return []
    return treeOf(expanded, (folder) => this.listing(join(root, folder)))
  }

  private listing(dir: string): Listed[] {
    const seen = this.listings.get(dir)
    if (seen && this.now() - seen.at < LISTING_MS) return seen.entries
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
    return entries
  }

  /**
   * What git says about each file under a folder — changed, new, conflicted —
   * for marking them in the tree. From the last look; looks again in the
   * background, like everything else drawn four times a second.
   */
  marksAt(root: string | null): Readonly<Record<string, string>> {
    if (!root) return {}
    const seen = this.marks.get(root)
    if (!seen || this.now() - seen.at >= LISTING_MS) {
      this.marks.set(root, { at: this.now(), marks: seen?.marks ?? {} })
      void git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
        .then((out) => {
          if (!out.ok) return
          const marks = marksFrom(out.stdout)
          const was = JSON.stringify(seen?.marks ?? {})
          this.marks.set(root, { at: this.now(), marks })
          if (JSON.stringify(marks) !== was) this.opts.onChange?.()
        })
        .catch(() => {})
    }
    return seen?.marks ?? {}
  }

  /** The project checkout's branches, newest first, and the one it is on. */
  async branchesOf(root: string): Promise<{ name: string; current: boolean; when: string }[]> {
    const out = await git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(HEAD)%00%(refname:short)%00%(committerdate:relative)',
      'refs/heads',
    ])
    if (!out.ok) return []
    return out.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [head, name, when] = line.split('\0')
        return { name: name ?? '', current: head === '*', when: when ?? '' }
      })
      .filter((row) => row.name !== '')
  }

  /**
   * The branch a project's own checkout is on. Answers from the last look and
   * looks again in the background, for the same reason `changes` does.
   */
  branchAt(root: string): string | null {
    const seen = this.branches.get(root)
    if (!seen || this.now() - seen.at >= BRANCH_MS) {
      this.branches.set(root, { at: this.now(), branch: seen?.branch ?? null })
      void branchOf(root)
        .then((branch) => {
          this.branches.set(root, { at: this.now(), branch })
          if (branch !== seen?.branch) this.opts.onChange?.()
        })
        .catch(() => {})
    }
    return seen?.branch ?? null
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
      this.workLooking.add(task)
      void this.lookAtActions(task, root)
        .then((work) => {
          if (!work) return
          this.works.set(task, { at: this.now(), work })
          this.opts.onChange?.()
        })
        .catch(() => {})
        .finally(() => this.workLooking.delete(task))
    }
    if (!seen) return null
    // What status already knows is taken from it rather than looked up again:
    // it is polled every couple of seconds anyway.
    const facts = this.facts.get(task)
    return {
      ...seen.work,
      ahead: facts?.ahead ?? seen.work.ahead,
      dirty: this.changed.get(task)?.changes.length ?? seen.work.dirty,
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

  private async lookAtActions(task: string, root: string): Promise<ActionsView | null> {
    const project = task.split('/')[0] ?? task
    const base = this.bases.get(task) ?? null
    const head = await git(root, ['rev-parse', 'HEAD'])
    const commit = head.ok ? head.stdout.trim() : null
    const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
    const from = since?.ok ? since.stdout.trim() : null
    // Trailers, so a commit says which task it belongs to wherever it ends
    // up: git's own mechanism, readable in a year by somebody with no Tade.
    // `--shortstat` for what each touched, which is what makes a commit on
    // this page worth more than its subject.
    const log = await git(root, [
      'log',
      '--no-color',
      '-n',
      '30',
      '--format=%x01%H%x00%ct%x00%s%x00%(trailers:key=Tade-Task,valueonly,separator=%x2C)%x00',
      '--shortstat',
      ...(from ? [`${from}..HEAD`] : []),
    ])
    const commits = log.ok ? commitsFrom(log.stdout) : []
    const stood = await checksAt({
      config: this.opts.config,
      project,
      worktree: root,
      tadeHome: this.opts.tadeHome,
      commit,
    })
    const going = stood.running
    const checks: CheckView[] = stood.plan.map((check) => {
      const run = stood.at.find((one) => one.check === check.id)
      const inFlight = going?.checks.find((one) => one.check === check.id)
      // A run in flight is the truth about now; the record is the truth about
      // what finished. Neither is guessed from the other.
      const live = inFlight && !settled(inFlight.state) ? inFlight : null
      const log = run ? stood.runs.find((one) => one.id === run.id) : undefined
      const seconds =
        run?.startedAt && run.finishedAt
          ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
          : null
      const outcome = readOutcome(log?.tail ?? '')
      return {
        id: check.id,
        title: check.title,
        run: check.run,
        state: live ? live.state : (run?.state ?? 'not run'),
        required: check.required,
        skip: check.skip ?? null,
        chosen: stood.rule.run_here[check.id] ?? null,
        needs: check.needs ?? [],
        summary: run?.summary ?? null,
        seconds: live ? null : seconds,
        startedAt: live?.startedAt ? Date.parse(live.startedAt) : null,
        at: run?.finishedAt ? Date.parse(run.finishedAt) : null,
        commit: run?.commit ?? null,
        carried: run ? stood.carried.has(run.id) : false,
        counts: outcome.counts,
        places: outcome.places,
        more: outcome.more,
        // Only what failed keeps its tail on the page: nobody opens a green
        // check to read what it printed, and every row here is a row the
        // failure below it does not get.
        tail:
          log && (log.state === 'failed' || log.state === 'timed out')
            ? log.tail.split('\n').slice(-TAIL_LINES).map(plainly)
            : [],
      }
    })
    const notes: string[] = []
    if (stood.plan.length > 0) {
      // A tick here means less than a tick in CI. Six words of it rather than
      // a sentence: the caveat is true under every check on every page, and
      // one that is read four hundred times is one nobody reads.
      notes.push('on this machine, not CI’s matrix')
    }
    const workspace = this.facts.get(task)?.workspace ?? 'checkout'
    return {
      task,
      branch: this.facts.get(task)?.branch ?? null,
      base,
      ahead: this.facts.get(task)?.ahead ?? null,
      behind: null,
      dirty: 0,
      shared: workspace === 'checkout',
      commit,
      mine: commits.filter((one) => one.task === task),
      others: commits.filter((one) => one.task !== task),
      review: null,
      checks,
      rollup: stood.rollup.state,
      unread: stood.read.problems,
      // Read, not configured: so it says which file said so, and where nothing
      // did, that nothing did — which is the answer, not a gap in the page.
      source:
        stood.plan.length > 0
          ? `read from ${stood.read.from ?? stood.read.source}`
          : 'Nothing here says what checking this project means — no workflow that runs on a change, no commit hook.',
      running: going
        ? {
            since: Date.parse(going.at) || this.now(),
            by: going.by,
            done: going.checks.filter((one) => settled(one.state)).length,
            total: going.checks.length,
          }
        : null,
      notes,
    }
  }

  /**
   * What a task has changed: where it works, measured from where it branched.
   * A task names a place and a base, and the answer is about the place — so an
   * agent sharing the project's checkout sees everything uncommitted in it,
   * whoever changed it.
   */
  changes(task: string | null): readonly Change[] {
    if (!task) return []
    const root = this.worktrees.get(task)
    if (!root) return []
    return this.changesAt(root, this.bases.get(task) ?? null)
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
   */
  changesAt(root: string | null, base: string | null): readonly Change[] {
    if (!root) return []
    const key = JSON.stringify([root, base])
    const seen = this.changed.get(key)
    if ((!seen || this.now() - seen.at >= LISTING_MS) && !this.looking.has(key)) {
      this.looking.add(key)
      void this.lookAtChanges(root, base)
        .then((changes) => {
          if (!changes) return
          const was = JSON.stringify(seen?.changes ?? [])
          this.changed.set(key, { at: this.now(), changes })
          if (JSON.stringify(changes) !== was) this.opts.onChange?.()
        })
        .catch(() => {})
        .finally(() => this.looking.delete(key))
    }
    return seen?.changes ?? []
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

  /**
   * One file's diff, from a root and a base like `changesAt` and `marksAt`: a
   * change in a shared checkout is nobody's, so a task only names where to look.
   * `null` is a look that could not happen, and never an empty one.
   */
  async diffAt(root: string, base: string | null, path: string): Promise<string | null> {
    const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
    const from = since?.ok ? since.stdout.trim() : 'HEAD'
    const tracked = await git(root, ['diff', '--no-color', '-U3', from, '--', path])
    if (tracked.ok && tracked.stdout.trim() !== '') return tracked.stdout
    // Nothing from `git diff` is two opposite answers: a file git tracks that
    // nobody changed, and one it never heard of, which is all new — an unchanged
    // file used to come back as the whole of it in green. `--no-index` exits 1
    // whenever it finds anything, so its output is all that says it looked.
    const known = await git(root, ['ls-files', '--error-unmatch', '--', path])
    if (known.ok) return tracked.ok ? tracked.stdout : null
    const added = await git(root, ['diff', '--no-color', '-U3', '--no-index', '/dev/null', path])
    return added.stdout.trim() === '' ? null : added.stdout
  }

  /** The branch a task's changes are counted against: `main`, usually. */
  baseOf(task: string | null): string | null {
    return task ? (this.bases.get(task) ?? null) : null
  }

  /**
   * Everything since the task branched, measured from where it branched — the
   * merge base, so work that landed on main since is not counted as the task's.
   */
  private async lookAtChanges(root: string, base: string | null): Promise<Change[] | null> {
    const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
    const from = since?.ok ? since.stdout.trim() : 'HEAD'
    const [names, numstat, status] = await Promise.all([
      git(root, ['diff', '--name-status', '-z', from]),
      git(root, ['diff', '--numstat', '-z', from]),
      git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    ])
    if (!names.ok) return null
    return changesFrom(
      names.stdout,
      numstat.ok ? numstat.stdout : '',
      status.ok ? status.stdout : '',
    )
  }

  /** What you have told Tade that applies to a project, newest first. */
  notes(project: string | null): NoteShown[] {
    const all: readonly Note[] = this.opts.client.recallAll()
    return all
      .filter(
        (note) =>
          note.scope === null || note.scope === project || note.scope?.startsWith(`${project}/`),
      )
      .slice()
      .reverse()
      .map((note) => ({
        text: note.text,
        at: note.at,
        scope: note.scope,
        by: note.by,
        ...(note.summary ? { summary: note.summary } : {}),
      }))
  }

  /** Every `usage` event the journal holds, for the Spend page's own ranges. */
  get spending(): readonly TadeEvent[] {
    return this.usage
  }

  /** Every event the Spend panel measures runtime from, oldest first. */
  get runs(): readonly TadeEvent[] {
    return this.runEvents
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
   * `usage` only ever grows, so the same count of events over the same day is
   * the same answer — and this is read from `facts()`, which is four times a
   * second, over every usage event there has ever been. Twenty-four thousand of
   * them was 3% of a core spent re-deriving a number that only moves when an
   * agent spends something, and on an idle window nothing ever does. The list
   * is the whole journal now, which makes the kept fold worth more rather than
   * less: it is the Spend page's longest range that put it there.
   */
  spendToday(): SpendReport {
    const since = startOfToday(this.now())
    const spent = this.spent
    if (spent && spent.since === since && spent.of === this.usage.length) return spent.report
    // Priced the same way the Spend page prices it, so the strip's figure and
    // the page's are one number: a harness that says it prices nothing still
    // has a rate for the model it ran on.
    const report = spendFrom(this.usage, { since, prices: pricesFrom(this.opts.config.prices) })
    this.spent = { since, of: this.usage.length, report }
    return report
  }

  /** How long the agents have run since midnight, in total and by task. */
  runtimeToday(): RuntimeReport {
    return runtimeFrom(this.runEvents, { since: startOfToday(this.now()), now: this.now() })
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
   * Turn the wheel over a lane that scrolls itself: a program that took the
   * whole screen and asked for the mouse, whose transcript is its own to
   * move. Nothing happens for a lane that never asked, and a lane that went
   * away while we turned is not an error worth showing.
   */
  async wheel(lane: string | null, turn: WheelTurn): Promise<void> {
    if (!lane) return
    try {
      await this.opts.client.wheel(lane as never, turn)
    } catch {
      // As `capture` does: a lane that just exited is not news.
    }
  }

  /**
   * Tell a lane what the pointer did, for a program that answers it itself.
   * How much of it that program actually hears is the driver's, from what it
   * asked for; a lane that went away while we pressed is not an error worth
   * showing.
   */
  async point(lane: string | null, report: PointerReport): Promise<void> {
    if (!lane) return
    try {
      await this.opts.client.point(lane as never, report)
    } catch {
      // As `capture` does: a lane that just exited is not news.
    }
  }

  /** Ask everything again. Never throws: the window must keep drawing. */
  async refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async doRefresh(): Promise<void> {
    void this.lookAtWhatLanded()
    try {
      const [workspace, pending, lanes] = await Promise.all([
        collectStatus({
          config: this.opts.config,
          now: this.now(),
          home: this.opts.home,
          tadeHome: this.opts.tadeHome,
          pr: false,
          ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
          liveness: livenessFrom(this.opts.client),
        }),
        this.opts.client.pendingApprovals(),
        this.opts.client.lanes(),
      ])
      this.servers = workspace.toolServers
      for (const warning of workspace.warnings) this.opts.onWarning?.(warning)
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
      // Chats first, then this project's terminals: the two conversations in
      // the lower pane — the orchestrator's tab and the chats — sit together,
      // and the terminals stay next to the `+` that makes another.
      this.opts.onTerminals?.(
        [...chatsFrom(lanes), ...terminalsFrom(lanes)].map(({ id, project, name }) => ({
          id,
          project,
          name,
        })),
      )
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
            this.queue.push({ task: task.id, project: project.name, start: task.start })
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
      this.snapshots = snapshotsFrom(workspace, pending, lanes, this.finished, queued)
      this.opts.onTasks?.(this.snapshots)
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
    this.journal.push(event)
    if (event.type === 'usage') this.usage.push(event)
    if ((RUNTIME_READS as readonly string[]).includes(event.type)) this.runEvents.push(event)
    if (event.task && event.type === 'task_done') {
      for (const [task, done] of finishedFrom([event])) this.finished.set(task, done)
    }
    if (event.task && event.type === 'run_started') {
      this.worked.delete(event.task)
      this.started.add(event.task)
    }
    if (event.task && event.type === 'turn_done') this.worked.add(event.task)
    if ((QUEUE_READS as readonly string[]).includes(event.type)) this.queueEvents.push(event)
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    this.opts.onEvent?.(event)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
