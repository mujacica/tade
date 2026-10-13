import { stat } from 'node:fs/promises'
import { type CheckLog, readRuns, recordsPath } from '@tade/checks-core'
import { recordsDir, type Workspace } from '@tade/core'
import { type CheckTreeIn, inTime } from '@tade/web'
import { checkTreeIn } from '../away-checks.ts'

// What ran in each tree, for the away view's checks: every project's checkout
// and every task's own worktree, as their run records (`checks.jsonl`) say.
//
// **A held value and a look behind it**, the shape `Live.actions` has: the
// beat takes the last read at once and never waits, and a read older than
// `RECORDS_MS` starts one more in the background. Only a beat somebody asked
// for builds the collections (`Away.collections`), so with nobody reading the
// away view nothing here runs at all. A record is two hundred runs and a
// megabyte and a half with their tails, so each is read again only when its
// size or time changed (`stampOf`): a quiet project costs one `stat` a look.
//
// Nothing here decides anything about a check. How long one has been red, and
// how much of it crosses, is the projection's (`checkTreesOf`).

/** How old the last read may be before a beat starts another. */
export const RECORDS_MS = 15_000

/** The most one look may take before what it read so far is all it says. */
const LOOK_MS = 5_000

export interface RecordsDeps {
  /** A tree's runs, oldest first: `readRuns`, or a counted one in a test. */
  read(dir: string): Promise<readonly CheckLog[]>
  /** What tells one version of a record from the next, or null where there is none. */
  stamp(dir: string): Promise<string | null>
  now(): number
  /** The most one look may take, `LOOK_MS` but in a test. */
  lookMs: number
}

/** The record's size and time: a write that changed it changed one of the two. */
export async function stampOf(dir: string): Promise<string | null> {
  const found = await stat(recordsPath(dir)).catch(() => null)
  return found === null ? null : `${found.size}:${found.mtimeMs}`
}

/** The trees a project's runs are recorded in: its checkout, then each task in a worktree of its own. */
export function treesOf(
  home: string,
  world: Workspace,
): { dir: string; project: string; task: string | null }[] {
  return world.projects.flatMap((project) => [
    { dir: recordsDir(home, project.name), project: project.name, task: null },
    ...project.tasks
      .filter((task) => task.workspace === 'worktree')
      .map((task) => ({
        dir: recordsDir(home, project.name, task.id),
        project: project.name,
        task: task.id,
      })),
  ])
}

export class CheckRecords {
  private held: readonly CheckTreeIn[] | null = null
  private lookedAt = Number.NEGATIVE_INFINITY
  private looking = false
  /** Each record as last read, under the stamp it had: read again only when that moved. */
  private readonly read = new Map<string, { stamp: string | null; tree: CheckTreeIn }>()
  private readonly deps: RecordsDeps

  constructor(deps: Partial<RecordsDeps> = {}) {
    this.deps = {
      read: deps.read ?? readRuns,
      stamp: deps.stamp ?? stampOf,
      now: deps.now ?? Date.now,
      lookMs: deps.lookMs ?? LOOK_MS,
    }
  }

  /** The last read — null before the first — and a look behind it when it has gone stale. */
  heldNow(home: string, world: Workspace): readonly CheckTreeIn[] | null {
    if (!this.looking && this.deps.now() - this.lookedAt >= RECORDS_MS) {
      void this.look(home, world)
    }
    return this.held
  }

  /** One look at every tree, finished or given up on inside `lookMs`. Never throws. */
  async look(home: string, world: Workspace): Promise<void> {
    this.looking = true
    this.lookedAt = this.deps.now()
    try {
      const trees = treesOf(home, world)
      const made: CheckTreeIn[] = []
      const reading = (async () => {
        for (const one of trees) made.push(await this.treeAt(one))
        return true
      })().catch(() => false)
      // A tree that did not answer in time is left out, and a checkout left
      // out is a project the projection says nothing was read for — never a
      // project where nothing ran.
      await inTime(reading, this.deps.lookMs, false)
      const dirs = new Set(trees.map((one) => one.dir))
      for (const dir of this.read.keys()) if (!dirs.has(dir)) this.read.delete(dir)
      this.held = [...made]
    } finally {
      this.looking = false
    }
  }

  private async treeAt(one: { dir: string; project: string; task: string | null }) {
    const stamp = await this.deps.stamp(one.dir).catch(() => null)
    const was = this.read.get(one.dir)
    if (was !== undefined && was.stamp === stamp) return was.tree
    const runs = stamp === null ? [] : await this.deps.read(one.dir).catch(() => [])
    const tree = checkTreeIn(one.project, one.task, runs)
    this.read.set(one.dir, { stamp, tree })
    return tree
  }
}
