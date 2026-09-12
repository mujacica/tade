import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskId } from '@wilco/core'
import { git, parseStatusV2, resolveBaseRef } from '@wilco/probes'
import { stringify } from 'yaml'

// Task lifecycle: a branch, a worktree, and the sentence you said when you
// started. Creating and removing tasks is the only write path into a user's
// repository, so it refuses anything it cannot do safely.

export const TASK_BRANCH_PREFIX = 'wilco/'

export interface CreateTaskOptions {
  /** Project name, used for the task id. */
  project: string
  /** Repository root the worktree is created from. */
  root: string
  /** Task name: the branch becomes `wilco/<slug>`. */
  slug: string
  /** What you said, stored verbatim. Nothing else can reconstruct it. */
  intent: string
  /** Directory that holds task worktrees. */
  worktreeRoot: string
  /** Defaults to the repository's own base branch. */
  base?: string
  now?: Date
}

/** A created task's git facts. The task *model* lives in @wilco/core. */
export interface TaskWorktree {
  id: string
  project: string
  branch: string
  worktree: string
  /** Commit the task branched from, so a later fast-forward merge is detectable. */
  base: string
  baseRef: string
}

export interface RemoveTaskOptions {
  root: string
  worktree: string
  branch: string
  /** Remove even with uncommitted or unmerged work. */
  force?: boolean
}

export type RemoveResult =
  | { removed: true; branchDeleted: boolean }
  | { removed: false; reason: string }

const SLUG = /^[a-z0-9][a-z0-9._-]*$/

export async function createTask(opts: CreateTaskOptions): Promise<TaskWorktree> {
  if (!SLUG.test(opts.slug)) {
    throw new Error(`invalid task name "${opts.slug}": use lowercase letters, digits, - . _`)
  }
  const id = `${opts.project}/${opts.slug}`
  if (!TaskId.safeParse(id).success) throw new Error(`invalid task id: ${id}`)

  const branch = `${TASK_BRANCH_PREFIX}${opts.slug}`
  const exists = await git(opts.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (exists.ok) throw new Error(`branch already exists: ${branch}`)

  const baseRef = opts.base ?? (await resolveBaseRef(opts.root))
  if (!baseRef) throw new Error(`no base branch found in ${opts.root}`)
  const baseSha = await git(opts.root, ['rev-parse', `${baseRef}^{commit}`])
  if (!baseSha.ok) throw new Error(`cannot resolve ${baseRef} in ${opts.root}`)
  const base = baseSha.stdout.trim()

  const worktree = join(opts.worktreeRoot, `${opts.project}-${opts.slug}`)
  await mkdir(opts.worktreeRoot, { recursive: true })
  const added = await git(opts.root, ['worktree', 'add', '-b', branch, worktree, baseRef], 30_000)
  if (!added.ok) throw new Error(`git worktree add failed: ${firstLine(added.stderr)}`)

  const task: TaskWorktree = { id, project: opts.project, branch, worktree, base, baseRef }
  await writeTaskFile(task, opts.intent, opts.now ?? new Date())
  return task
}

async function writeTaskFile(task: TaskWorktree, intent: string, now: Date): Promise<void> {
  await mkdir(join(task.worktree, '.wilco'), { recursive: true })
  await writeFile(
    join(task.worktree, '.wilco', 'task.yaml'),
    stringify({
      id: task.id,
      project: task.project,
      // Verbatim: never paraphrased, never normalised.
      intent_spoken: intent,
      created: now.toISOString(),
      base: task.base,
      parked: false,
    }),
  )
}

/**
 * Remove a task's worktree. Refuses when that would destroy work: uncommitted
 * changes, or commits that are not in the base branch yet.
 */
export async function removeTask(opts: RemoveTaskOptions): Promise<RemoveResult> {
  if (!opts.force) {
    const status = await git(opts.worktree, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
    ])
    if (status.ok) {
      const dirty = parseStatusV2(status.stdout).paths.filter((p) => !/^\.wilco(\/|$)/.test(p))
      if (dirty.length > 0) {
        return { removed: false, reason: `${dirty.length} uncommitted file(s) in ${opts.worktree}` }
      }
    }
    const baseRef = await resolveBaseRef(opts.root)
    if (baseRef) {
      const merged = await git(opts.root, ['merge-base', '--is-ancestor', opts.branch, baseRef])
      if (!merged.ok) {
        return { removed: false, reason: `${opts.branch} has commits not merged into ${baseRef}` }
      }
    }
  }

  // `--force` unconditionally: the refusals above are Wilco's, and they have
  // already passed. Git would otherwise refuse over `.wilco/task.yaml`, which
  // is Wilco's own bookkeeping and never work worth keeping.
  const removed = await git(opts.root, ['worktree', 'remove', '--force', opts.worktree], 30_000)
  if (!removed.ok) throw new Error(`git worktree remove failed: ${firstLine(removed.stderr)}`)

  // -d refuses to delete unmerged work; -D is only reached when forced.
  const deleted = await git(opts.root, ['branch', opts.force ? '-D' : '-d', opts.branch])
  return { removed: true, branchDeleted: deleted.ok }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}
