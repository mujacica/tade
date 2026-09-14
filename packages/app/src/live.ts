import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Config,
  historyFrom,
  type KnownTask,
  type Note,
  type SpendReport,
  spendFrom,
  startOfToday,
  summariseWork,
  type WilcoEvent,
  type WorkHistory,
  type WorkSummary,
  type Workspace,
} from '@wilco/core'
import { collectStatus, git } from '@wilco/status'
import { terminalsFrom, type Workbench } from '@wilco/workbench'
import { livenessFrom } from '@wilco/workbench/lane-liveness'
import type { LaneRecord } from '@wilco/workbench/registry'
import type { PendingApproval } from '@wilco/workbench/workers'
import { type FileEntry, type Listed, marksFrom, treeOf } from './files.ts'
import type { TaskSnapshot } from './model.ts'
import { branchOf } from './projects.ts'
import type { Change } from './view.ts'

// Where the app gets its facts.
//
// Status is a query, so this polls rather than keeping its own idea of the
// world, and the journal it accumulates is what lets the resolver answer
// "which one did you mean".

/** How much journal to keep for working out what recently moved. */
const JOURNAL = 500

/** How long a folder listing is good for. */
const LISTING_MS = 2_000

/** How long the branch a project's own checkout is on is good for. */
const BRANCH_MS = 10_000

/**
 * Fold what status, the lane registry and the approval queue each know into
 * the one shape the window draws. Pure, because this mapping is the part that
 * decides what you see.
 */
export function snapshotsFrom(
  workspace: Workspace,
  pending: readonly PendingApproval[],
  lanes: readonly LaneRecord[],
): TaskSnapshot[] {
  const snapshots: TaskSnapshot[] = []
  for (const project of workspace.projects) {
    for (const task of project.tasks) {
      const lane =
        lanes.find(
          (record) => record.task === task.id && record.kind === 'agent' && record.alive,
        ) ?? lanes.find((record) => record.task === task.id && record.alive)
      snapshots.push({
        task: task.id,
        state: task.state,
        reason: task.reason,
        title: task.title ?? null,
        branch: task.branch,
        lane: lane?.id ?? null,
        waiting: pending.some((approval) => approval.task === task.id),
        approval: approvalOf(pending, task.id),
        lanes: lanes
          .filter((record) => record.task === task.id && record.alive)
          .sort((a, b) =>
            a.kind === 'agent' ? -1 : b.kind === 'agent' ? 1 : a.id.localeCompare(b.id),
          )
          .map((record) => ({
            id: record.id,
            kind: record.kind,
            // What a shell was named, when it was: an agent is always its task.
            ...(record.kind !== 'agent' && record.title && !/ shell$/.test(record.title)
              ? { title: record.title }
              : {}),
          })),
      })
    }
  }
  return snapshots.sort((a, b) => a.task.localeCompare(b.task))
}

/** The oldest approval a task is waiting on, which is the one to answer first. */
function approvalOf(
  pending: readonly PendingApproval[],
  task: string,
): { tool: string; summary: string } | null {
  const first = pending.filter((approval) => approval.task === task).sort((a, b) => a.at - b.at)[0]
  return first ? { tool: first.tool, summary: first.summary } : null
}

/**
 * What a task has changed since it branched: committed or not, plus files
 * nobody has added yet. From `git diff --name-status -z <base>`,
 * `git diff --numstat -z <base>` and `git status --porcelain=v2 -z`. Pure, so
 * the parsing is tested against real git output rather than trusted.
 */
export function changesFrom(nameStatus: string, numstat: string, status = ''): Change[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const stats = numstat.split('\0')
  const count = (value: string | undefined) =>
    value === undefined || value === '-' ? null : Number(value)
  for (let i = 0; i < stats.length; i++) {
    const entry = stats[i]
    if (!entry) continue
    const [added, removed, path] = entry.split('\t')
    if (path === '') {
      // A rename: the old and new paths follow as fields of their own.
      const to = stats[i + 2]
      if (to) counts.set(to, { added: count(added), removed: count(removed) })
      i += 2
    } else if (path !== undefined) {
      counts.set(path, { added: count(added), removed: count(removed) })
    }
  }

  const seen = new Map<string, string>()
  const names = nameStatus.split('\0')
  for (let i = 0; i < names.length; i++) {
    const code = names[i]
    if (!code) continue
    const letter = code[0] ?? 'M'
    if (letter === 'R' || letter === 'C') {
      const to = names[i + 2]
      if (to) seen.set(to, letter === 'R' ? 'R' : 'A')
      i += 2
    } else {
      const path = names[i + 1]
      if (path) seen.set(path, letter === 'T' ? 'M' : letter)
      i += 1
    }
  }
  for (const field of status.split('\0')) {
    if (field.startsWith('? ')) seen.set(field.slice(2), '?')
  }

  const out: Change[] = []
  for (const [path, mark] of seen) {
    // Wilco's own record of the task is untracked on purpose, and is not a
    // change anybody made to the work.
    if (path === '.wilco' || path.startsWith('.wilco/')) continue
    const counted = counts.get(path)
    out.push({ path, mark, added: counted?.added ?? null, removed: counted?.removed ?? null })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** The same tasks, as the resolver wants them. */
export function knownTasks(snapshots: readonly TaskSnapshot[]): KnownTask[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.task,
    project: snapshot.task.split('/')[0] ?? snapshot.task,
    state: snapshot.state,
  }))
}

export interface LiveOptions {
  client: Workbench
  config: Config
  /** $HOME, for finding agent sessions started outside Wilco. */
  home: string
  cwd?: string
  pollMs?: number
  now?: () => number
  onTasks?: (tasks: TaskSnapshot[]) => void
  onEvent?: (event: WilcoEvent) => void
  onWarning?: (message: string) => void
  /** Something drawn from a background look has changed. */
  onChange?: () => void
  /**
   * An agent that started without a branch has changed something, so its work
   * now needs one. Said on every look until it has one; acting once is the
   * listener's business.
   */
  onWork?: (task: { id: string; project: string; worktree: string; title: string }) => void
  /** The terminals open now, whoever opened them: the window, the orchestrator, or voice. */
  onTerminals?: (terminals: { id: string; project: string; name: string }[]) => void
}

export class Live {
  private readonly opts: LiveOptions
  private readonly journal: WilcoEvent[] = []
  private snapshots: TaskSnapshot[] = []
  /** Where each task lives on disk, which is what parking one needs. */
  private readonly worktrees = new Map<string, string>()
  /** The last listing of each folder, so the sidebar is not a disk read. */
  private readonly listings = new Map<string, { at: number; entries: Listed[] }>()
  /** What git says about the files of each folder the tree is showing, as last looked. */
  private readonly marks = new Map<string, { at: number; marks: Record<string, string> }>()
  /** The branch each project's checkout was last seen on, and whether a look is under way. */
  private readonly branches = new Map<string, { at: number; branch: string | null }>()
  /** The last look at what each task has changed, and whether one is under way. */
  private readonly changed = new Map<string, { at: number; changes: Change[] }>()
  private readonly looking = new Set<string>()
  /** The branch each task was started from, as status last saw it. */
  private readonly bases = new Map<string, string>()
  /** Each task's branch and how far ahead of its base, for removing it. */
  private readonly facts = new Map<
    string,
    {
      project: string
      branch: string
      ahead: number | null
      links: readonly { title: string; url: string }[]
    }
  >()
  /** Every `usage` event since midnight, which is what today's spend is. */
  private usage: WilcoEvent[] = []
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
    // a busy morning is more than that. A week of it, which is the longest
    // window the Spend panel offers.
    const since = startOfToday(live.now()) - 6 * 86_400_000
    live.usage = (await opts.client.events({ types: ['usage'] }).catch(() => [])).filter(
      (event) => Date.parse(event.ts) >= since,
    )
    await opts.client.subscribe((event) => live.record(event))
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

  get history(): WorkHistory {
    return historyFrom(this.journal, this.now())
  }

  /** What has happened recently, for anything that has to read it directly. */
  get events(): readonly WilcoEvent[] {
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
   * What a task has changed. Answers from the last look at once, and looks
   * again in the background when that is stale: the window draws four times a
   * second and must never wait on git to do it.
   */
  changes(task: string | null): readonly Change[] {
    const root = task ? this.worktrees.get(task) : null
    if (!task || !root) return []
    const seen = this.changed.get(task)
    if ((!seen || this.now() - seen.at >= LISTING_MS) && !this.looking.has(task)) {
      this.looking.add(task)
      void this.lookAtChanges(root, this.bases.get(task) ?? null)
        .then((changes) => {
          if (!changes) return
          this.changed.set(task, { at: this.now(), changes })
          this.opts.onChange?.()
        })
        .catch(() => {})
        .finally(() => this.looking.delete(task))
    }
    return seen?.changes ?? []
  }

  /** A task's branch, its project, and how many commits it has that its base does not. */
  factsOf(task: string): {
    project: string
    branch: string
    ahead: number | null
    /** Where the work came from: an issue, a trace. */
    links: readonly { title: string; url: string }[]
  } | null {
    return this.facts.get(task) ?? null
  }

  /** One changed file's diff, from where the task branched. */
  async diffOf(task: string, path: string): Promise<string | null> {
    const root = this.worktrees.get(task)
    if (!root) return null
    const base = this.bases.get(task)
    const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
    const from = since?.ok ? since.stdout.trim() : 'HEAD'
    const tracked = await git(root, ['diff', '--no-color', '-U3', from, '--', path])
    if (tracked.ok && tracked.stdout.trim() !== '') return tracked.stdout
    // Untracked: git has no diff for it, but it is all new.
    const added = await git(root, ['diff', '--no-color', '-U3', '--no-index', '/dev/null', path])
    return added.stdout
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

  /** What you have told Wilco that applies to a project, newest first. */
  notes(project: string | null): { text: string; at: string }[] {
    const all: readonly Note[] = this.opts.client.recallAll()
    return all
      .filter(
        (note) =>
          note.scope === null || note.scope === project || note.scope?.startsWith(`${project}/`),
      )
      .slice()
      .reverse()
      .map((note) => ({ text: note.text, at: note.at }))
  }

  /** Every `usage` event of the last seven days, for the Spend panel. */
  get spending(): readonly WilcoEvent[] {
    return this.usage
  }

  /** What an agent last said it runs on. */
  vitals(task: string | null): { model: string | null; contextPercent: number | null } | null {
    const vitals = task ? this.opts.client.vitals(task) : null
    return vitals ? { model: vitals.model, contextPercent: vitals.contextPercent } : null
  }

  /** What has been spent since midnight, in total and by task. */
  spendToday(): SpendReport {
    return spendFrom(this.usage, { since: startOfToday(this.now()) })
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
    try {
      const [workspace, pending, lanes] = await Promise.all([
        collectStatus({
          config: this.opts.config,
          now: this.now(),
          home: this.opts.home,
          pr: false,
          ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
          liveness: livenessFrom(this.opts.client),
        }),
        this.opts.client.pendingApprovals(),
        this.opts.client.lanes(),
      ])
      for (const warning of workspace.warnings) this.opts.onWarning?.(warning)
      for (const project of workspace.projects) {
        for (const task of project.tasks) {
          this.worktrees.set(task.id, task.worktree)
          if (task.git?.baseRef) this.bases.set(task.id, task.git.baseRef)
          this.facts.set(task.id, {
            project: project.name,
            branch: task.branch,
            ahead: task.git?.ahead ?? null,
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
      this.opts.onTerminals?.(
        terminalsFrom(lanes).map(({ id, project, name }) => ({ id, project, name })),
      )
      this.snapshots = snapshotsFrom(workspace, pending, lanes)
      this.opts.onTasks?.(this.snapshots)
    } catch (err) {
      this.opts.onWarning?.(err instanceof Error ? err.message : String(err))
    }
  }

  private record(event: WilcoEvent): void {
    this.journal.push(event)
    if (event.type === 'usage') this.usage.push(event)
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    this.opts.onEvent?.(event)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
