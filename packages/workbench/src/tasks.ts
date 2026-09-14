import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sharedTaskDir, TASK_CONTEXT_FILE, TaskId } from '@wilco/core'
import { git, parseStatusV2, resolveBaseRef } from '@wilco/status'
import { parse as parseYaml, stringify } from 'yaml'

// Task lifecycle: where the work happens, and the sentence you said when you
// started. A task works either in the project's own checkout, beside other
// agents, or in a worktree and branch of its own. Creating and removing tasks
// is the only write path into a user's repository, so it refuses anything it
// cannot do safely.

/**
 * Where a task's own file is. A task sharing the checkout keeps it in a folder
 * of its own under `.wilco/tasks`, since the directory is everyone's; one in a
 * worktree keeps it at the worktree's `.wilco/task.yaml`.
 */
export function taskFilePath(worktree: string, id?: string): string {
  if (id) {
    const shared = join(worktree, sharedTaskDir(id), 'task.yaml')
    if (existsSync(shared)) return shared
  }
  return join(worktree, '.wilco', 'task.yaml')
}

/** Where a task's context is, relative to where its agent works, whether or not it has one. */
export function taskContextPath(worktree: string, id?: string): string {
  if (id && existsSync(join(worktree, sharedTaskDir(id), 'task.yaml'))) {
    return `${sharedTaskDir(id)}/context.md`
  }
  return TASK_CONTEXT_FILE
}

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
  /**
   * `checkout`: the agent works in the project's own checkout, beside any
   * others, on the branch it is on. `worktree` (unless said): a worktree of
   * its own.
   */
  workspace?: 'checkout' | 'worktree'
  /** Who asked for it: kept in the task file, as `TaskOrigin` says it. */
  by?: string
  now?: Date
}

/** A created task's git facts. The task *model* lives in @wilco/core. */
export interface TaskWorktree {
  id: string
  project: string
  branch: string
  /** Where the agent works: the checkout itself, or the task's worktree. */
  worktree: string
  /** Commit the task branched from, so a later fast-forward merge is detectable. */
  base: string
  baseRef: string
  workspace: 'checkout' | 'worktree'
}

export interface RemoveTaskOptions {
  root: string
  worktree: string
  branch: string
  /** The task's id: what finds a task sharing the checkout. */
  task?: string
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
  if (opts.workspace === 'checkout') return createSharedTask(opts, id)

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

  const task: TaskWorktree = {
    id,
    project: opts.project,
    branch,
    worktree,
    base,
    baseRef,
    workspace: 'worktree',
  }
  await writeTaskFile(
    join(worktree, '.wilco', 'task.yaml'),
    task,
    opts.intent,
    opts.now ?? new Date(),
    opts.links ?? [],
    opts.by,
  )
  const context = contextDocument(opts.context ?? '', opts.links ?? [])
  if (context) await writeFile(join(worktree, TASK_CONTEXT_FILE), context)
  return task
}

/**
 * A task in the project's own checkout: nothing in git changes, only a folder
 * of Wilco's own under `.wilco/tasks` saying what was asked. The branch is
 * whatever the checkout is on, and stays so.
 */
async function createSharedTask(opts: CreateTaskOptions, id: string): Promise<TaskWorktree> {
  const dir = join(opts.root, sharedTaskDir(id))
  if (existsSync(join(dir, 'task.yaml'))) throw new Error(`task already exists: ${id}`)
  const head = await git(opts.root, ['rev-parse', 'HEAD^{commit}'])
  if (!head.ok) throw new Error(`${opts.root} has no commit to work from yet`)
  const on = await git(opts.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = on.ok ? on.stdout.trim() : ''
  const task: TaskWorktree = {
    id,
    project: opts.project,
    branch,
    worktree: opts.root,
    base: head.stdout.trim(),
    baseRef: branch || head.stdout.trim(),
    workspace: 'checkout',
  }
  await mkdir(dir, { recursive: true })
  await writeTaskFile(
    join(dir, 'task.yaml'),
    task,
    opts.intent,
    opts.now ?? new Date(),
    opts.links ?? [],
    opts.by,
  )
  const context = contextDocument(opts.context ?? '', opts.links ?? [])
  if (context) await writeFile(join(dir, 'context.md'), context)
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
  path: string,
  task: TaskWorktree,
  intent: string,
  now: Date,
  links: readonly { title: string; url: string }[],
  by: string | undefined,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    stringify({
      id: task.id,
      project: task.project,
      // Verbatim: never paraphrased, never normalised.
      intent_spoken: intent,
      created: now.toISOString(),
      base: task.base,
      parked: false,
      ...(task.workspace === 'checkout' ? { workspace: 'checkout' } : {}),
      ...(links.length > 0 ? { links: links.map(({ title, url }) => ({ title, url })) } : {}),
      ...(by ? { by } : {}),
    }),
  )
}

/**
 * Remove a task's worktree. Refuses when that would destroy work: uncommitted
 * changes, or commits that are not in the base branch yet.
 */
export async function removeTask(opts: RemoveTaskOptions): Promise<RemoveResult> {
  // A task sharing the checkout is only its folder: the work in the checkout is
  // everyone's, and the checkout itself is never removed.
  if (opts.task && existsSync(join(opts.root, sharedTaskDir(opts.task), 'task.yaml'))) {
    await rm(join(opts.root, sharedTaskDir(opts.task)), { recursive: true, force: true })
    return { removed: true, branchDeleted: false }
  }
  if (resolve(opts.worktree) === resolve(opts.root)) {
    return { removed: false, reason: `${opts.root} is the project's own checkout` }
  }
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
    await updateTaskFile(taskFilePath(opts.worktree), (file) => {
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
export async function setTitle(
  worktree: string,
  title: string,
  named: boolean,
  id?: string,
): Promise<void> {
  const text = title.replace(/\s+/g, ' ').trim()
  if (!text) return
  await updateTaskFile(taskFilePath(worktree, id), (file) => {
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
  path: string,
  change: (file: Record<string, unknown>) => void,
): Promise<void> {
  const file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
  change(file)
  await writeFile(path, stringify(file))
}

/** Say which harness a task's agent runs in; empty goes back to the route's. */
export async function setTaskHarness(worktree: string, id: string, harness: string): Promise<void> {
  await updateTaskFile(taskFilePath(worktree, id), (file) => {
    if (harness) file.harness = harness
    else delete file.harness
  })
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
export async function setParked(
  worktree: string,
  parked: boolean,
  id?: string,
): Promise<ParkResult> {
  const path = taskFilePath(worktree, id)
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
