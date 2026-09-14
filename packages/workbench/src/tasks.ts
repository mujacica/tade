import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_CONTEXT_FILE, TaskId } from '@wilco/core'
import { git, parseStatusV2, resolveBaseRef } from '@wilco/status'
import { parse as parseYaml, stringify } from 'yaml'

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
  /**
   * Start without a branch: the worktree is on the base commit, detached, and
   * `nameTask` gives it a branch when there is work to name. An agent opened
   * to look around leaves no `wilco/*` branch behind.
   */
  detached?: boolean
  /** What the agent should know before it starts, written beside the task file. */
  context?: string
  /** Where the work came from, kept with the task. */
  links?: readonly { title: string; url: string }[]
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

  const branch = opts.detached ? '' : `${TASK_BRANCH_PREFIX}${opts.slug}`
  if (branch) {
    const exists = await git(opts.root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
    if (exists.ok) throw new Error(`branch already exists: ${branch}`)
  }

  const baseRef = opts.base ?? (await resolveBaseRef(opts.root))
  if (!baseRef) throw new Error(`no base branch found in ${opts.root}`)
  const baseSha = await git(opts.root, ['rev-parse', `${baseRef}^{commit}`])
  if (!baseSha.ok) throw new Error(`cannot resolve ${baseRef} in ${opts.root}`)
  const base = baseSha.stdout.trim()

  const worktree = join(opts.worktreeRoot, `${opts.project}-${opts.slug}`)
  await mkdir(opts.worktreeRoot, { recursive: true })
  const added = await git(
    opts.root,
    branch
      ? ['worktree', 'add', '-b', branch, worktree, baseRef]
      : ['worktree', 'add', '--detach', worktree, baseRef],
    30_000,
  )
  if (!added.ok) throw new Error(`git worktree add failed: ${firstLine(added.stderr)}`)

  const task: TaskWorktree = { id, project: opts.project, branch, worktree, base, baseRef }
  await writeTaskFile(task, opts.intent, opts.now ?? new Date(), opts.links ?? [])
  const context = contextDocument(opts.context ?? '', opts.links ?? [])
  if (context) await writeFile(join(worktree, TASK_CONTEXT_FILE), context)
  return task
}

/**
 * What an agent reads before it starts: what it was told, then where the work
 * came from. Empty when there is nothing to say, so no file is written.
 */
export function contextDocument(
  context: string,
  links: readonly { title: string; url: string }[],
): string {
  const parts = [context.trim()]
  if (links.length > 0) {
    parts.push(
      ['## Links', '', ...links.map((link) => `- [${link.title}](${link.url})`)].join('\n'),
    )
  }
  const text = parts.filter((part) => part !== '').join('\n\n')
  return text ? `${text}\n` : ''
}

async function writeTaskFile(
  task: TaskWorktree,
  intent: string,
  now: Date,
  links: readonly { title: string; url: string }[],
): Promise<void> {
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
      ...(links.length > 0 ? { links: links.map(({ title, url }) => ({ title, url })) } : {}),
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
    // No branch means nothing was ever committed to one: only the worktree to check.
    if (baseRef && opts.branch) {
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

  if (!opts.branch) return { removed: true, branchDeleted: false }
  // -d refuses to delete unmerged work; -D is only reached when forced.
  const deleted = await git(opts.root, ['branch', opts.force ? '-D' : '-d', opts.branch])
  return { removed: true, branchDeleted: deleted.ok }
}

/**
 * A branch name from what the work is called: `Fix the double charge on
 * retries!` becomes `fix-the-double-charge-on`. Short, because it is typed and
 * read far more often than it is written.
 */
export function branchSlug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 40) break
    slug = next
  }
  return slug || 'work'
}

export interface NameTaskOptions {
  root: string
  worktree: string
  /** What the work is called. Falls back to the task's own name. */
  title: string
}

/**
 * Give an agent that started without a branch one, named for its work, where
 * it stands — uncommitted changes and any commits come along. The first free
 * name wins: a branch someone already has is never touched.
 */
export async function nameTask(opts: NameTaskOptions): Promise<string> {
  const current = await git(opts.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (current.ok && current.stdout.trim()) return current.stdout.trim()
  const slug = branchSlug(opts.title)
  for (let n = 1; n <= 50; n++) {
    const branch = `${TASK_BRANCH_PREFIX}${n === 1 ? slug : `${slug}-${n}`}`
    const taken = await git(opts.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (taken.ok) continue
    const made = await git(opts.worktree, ['switch', '-c', branch])
    if (!made.ok) throw new Error(`git switch -c ${branch} failed: ${firstLine(made.stderr)}`)
    await updateTaskFile(opts.worktree, (file) => {
      if (typeof file.title !== 'string' || file.title === '') file.title = opts.title
    })
    return branch
  }
  throw new Error(`every branch like ${TASK_BRANCH_PREFIX}${slug} is taken`)
}

/**
 * Say what an agent's work is called. A name you gave it replaces whatever was
 * there; a title taken from the first thing you asked only fills a blank.
 */
export async function setTitle(worktree: string, title: string, named: boolean): Promise<void> {
  const text = title.replace(/\s+/g, ' ').trim()
  if (!text) return
  await updateTaskFile(worktree, (file) => {
    // A name a person chose is kept; any other is better replaced by a better one.
    if (named) {
      file.title = text
      file.title_named = true
    } else if (file.title_named !== true) {
      file.title = text
    }
  })
}

async function updateTaskFile(
  worktree: string,
  change: (file: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(worktree, '.wilco', 'task.yaml')
  const file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
  change(file)
  await writeFile(path, stringify(file))
}

export interface ParkResult {
  task: string
  parked: boolean
}

/**
 * Set a task aside, or pick it back up. Deliberate human choice, so it lives
 * in task.yaml rather than being derived: nothing else can tell "parked" from
 * "idle". Every other field is round-tripped untouched, `intent_spoken` above
 * all.
 */
export async function setParked(worktree: string, parked: boolean): Promise<ParkResult> {
  const path = join(worktree, '.wilco', 'task.yaml')
  let file: Record<string, unknown>
  try {
    file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
  } catch {
    throw new Error(`no task at ${worktree}`)
  }
  if (typeof file !== 'object') throw new Error(`unreadable task at ${worktree}`)
  file.parked = parked
  await writeFile(path, stringify(file))
  return { task: String(file.id ?? ''), parked }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}
