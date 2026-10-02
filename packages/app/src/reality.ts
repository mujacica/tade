import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  type Finished,
  finishedFrom,
  historyFrom,
  type KnownTask,
  type Queued,
  queueStanding,
  queueStateOf,
  summariseWork,
  type TaskState,
  type Upstream,
  type Watched,
  type WorkHistory,
  type WorkSummary,
  type Workspace,
  watchedFrom,
  workedFrom,
} from '@tade/core'
import type { LaneRecord } from '@tade/workbench/registry'
import type { PendingApproval } from '@tade/workbench/workers'
import type { Change, CheckView, CommitView } from './frame.ts'
import type { QueuedView, TaskSnapshot } from './model.ts'

// What git and the journal said, read into the shapes the window draws.
//
// Pure: text in, values out. No clock, no filesystem, no `Live` — which is why
// these are here rather than in `live.ts`, whose subject is the polling and the
// holding. Reading `git log --name-only` has nothing to do with how often
// anybody asks for it, and a parser is worth testing on the bytes a real git
// printed rather than through a window.
//
// Every one of them answers `null`, or leaves a record out, rather than
// guessing: a commit with no `Tade-Task` trailer belongs to nobody, which is
// always an allowed answer.

/**
 * One commit per record, its `Tade-Task` trailer and the files it changed,
 * out of one `git log`. The markers are control characters because a commit
 * subject can hold anything a person can type, and a separator somebody can
 * write by accident is a parser that lies.
 */
export const CHANGED_FORMAT =
  '\u0001%H\u0002%(trailers:key=Tade-Task,valueonly,separator=%x03)\u0002'

/**
 * What `git log --name-only` in `CHANGED_FORMAT` said: which task each commit
 * belongs to, and what it changed. A commit with no trailer belongs to
 * nobody, which is always an allowed answer — it is left out rather than
 * guessed at.
 */
export function changedFrom(stdout: string): { commit: string; task: string; paths: string[] }[] {
  const out: { commit: string; task: string; paths: string[] }[] = []
  for (const record of stdout.split('\u0001')) {
    if (record === '') continue
    const [commit = '', trailer = '', rest = ''] = record.split('\u0002')
    const task = (trailer.split('\u0003')[0] ?? '').trim()
    if (task === '') continue
    const paths = rest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    out.push({ commit, task, paths })
  }
  return out
}

/**
 * Fold what status, the lane registry and the approval queue each know into
 * the one shape the window draws. Pure, because this mapping is the part that
 * decides what you see.
 */
export function snapshotsFrom(
  workspace: Workspace,
  pending: readonly PendingApproval[],
  lanes: readonly LaneRecord[],
  finished: ReadonlyMap<string, Finished> = new Map(),
  queued: ReadonlyMap<string, QueuedView> = new Map(),
): TaskSnapshot[] {
  const snapshots: TaskSnapshot[] = []
  for (const project of workspace.projects) {
    for (const task of project.tasks) {
      const lane =
        lanes.find(
          (record) => record.task === task.id && record.kind === 'agent' && record.alive,
        ) ?? lanes.find((record) => record.task === task.id && record.alive)
      const done = finished.get(task.id)
      snapshots.push({
        task: task.id,
        state: task.state,
        reason: task.reason,
        ...(done ? { finished: { by: done.by, summary: done.summary } } : {}),
        ...(task.done ? { done: task.done } : {}),
        ...(task.by ? { by: task.by } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        ...(queued.has(task.id) ? { queued: queued.get(task.id) } : {}),
        // Kept after it starts: the plan it was part of is still drawn with it,
        // and what it changes is what a later plan is checked against.
        ...(task.start && task.start.after.length > 0 ? { waitsOn: task.start.after } : {}),
        ...(task.start && task.start.touches.length > 0 ? { touches: task.start.touches } : {}),
        title: task.title ?? null,
        // Verbatim, as its task file has it: nothing can recover what somebody
        // asked for once it has been reworded, which is why search matches it
        // rather than a summary of it.
        ...(task.intent_spoken ? { intent: task.intent_spoken } : {}),
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
    const counted = counts.get(path)
    out.push({ path, mark, added: counted?.added ?? null, removed: counted?.removed ?? null })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The commits of a branch, as `git log` with the trailer format and
 * `--shortstat` hands them back: a `\x01` before each, then
 * `<sha>\0<when>\0<subject>\0<Tade-Task trailers>\0`, then what it touched.
 *
 * The record separator is what makes the stat line safe to read: a subject
 * can hold anything, a stat line begins with a space, and without a mark
 * saying where a commit starts the two run into each other.
 *
 * The trailer is git's own mechanism, which is why attribution survives a
 * squash merge and a machine with no Tade on it. A commit that names no task
 * is unattributed, and that is a first-class answer rather than a guess.
 */
export function commitsFrom(stdout: string): CommitView[] {
  return stdout.split('\u0001').flatMap((entry) => {
    if (entry.trim() === '') return []
    const [head, ...rest] = entry.split('\u0000\n')
    const [sha, at, subject, trailer] = (head ?? '').split('\u0000')
    if (!sha) return []
    // ` 3 files changed, 48 insertions(+), 12 deletions(-)` — absent for a
    // merge and for a commit that changed nothing, which reads as unknown
    // rather than as zero.
    const stat =
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
        rest.join('\u0000\n'),
      )
    return [
      {
        sha,
        at: Number(at ?? 0) * 1000,
        subject: subject ?? '',
        // Several trailers on one commit is somebody copying a message: the
        // first is the one it was written for.
        task: (trailer ?? '').split(',')[0]?.trim() || null,
        files: stat?.[1] ? Number(stat[1]) : null,
        added: stat?.[2] ? Number(stat[2]) : null,
        removed: stat?.[3] ? Number(stat[3]) : null,
      },
    ]
  })
}

/**
 * A line of somebody else's output as a row of the page: no colour, no tabs
 * and no control bytes. A tab in a row is a row whose width the window and
 * the terminal disagree about, which is the one thing `draw` may never do.
 */
export function plainly(line: string): string {
  return stripTerminalSequences(line).replace(/\t/g, '  ').replace(CONTROL, '')
}

/** Built from character codes: a control character in a regex literal reads as a typo. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
)

/** The same tasks, as the resolver wants them. */
export function knownTasks(snapshots: readonly TaskSnapshot[]): KnownTask[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.task,
    project: snapshot.task.split('/')[0] ?? snapshot.task,
    state: snapshot.state,
  }))
}
