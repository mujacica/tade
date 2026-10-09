import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type DoneRule,
  producesPath,
  producesProblem,
  type StartCondition,
  TaskFile,
  TaskId,
  taskDir,
} from '@tade/core'
import { git, parseStatusV2, resolveBaseRef } from '@tade/status'
import { parse as parseYaml, stringify } from 'yaml'

// Task lifecycle: where the work happens, and the sentence you said when you
// started. A task works either in the project's own checkout, beside other
// agents, or in a worktree and branch of its own. Creating a task is the only
// thing here that writes into a user's repository at all — a worktree and a
// branch, both git's own — so it refuses anything it cannot do safely.
//
// A task's own files are not in the repository and never were the project's:
// they live in Tade's home, one folder per task under its project
// (`taskDir`), whichever way the task works. That is why a worktree can be
// reset, merged onto or thrown away without Tade's record of the task going
// with it, and why nothing here has to be ignored, excluded or settled after
// a conflict.

/** Where a task's own file is: in Tade's home, under its project. */
export function taskFilePath(home: string, id: string): string {
  return join(taskDir(home, id), 'task.yaml')
}

/** Where a task's context is, whether or not it has one. */
export function taskContextPath(home: string, id: string): string {
  return join(taskDir(home, id), 'context.md')
}

export const TASK_BRANCH_PREFIX = 'tade/'

export interface CreateTaskOptions {
  /** Tade's home: where the task's own files go, outside the repository. */
  home: string
  /** Project name, used for the task id. */
  project: string
  /** Repository root the worktree is created from. */
  root: string
  /** Task name: the branch becomes `tade/<slug>`. */
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
   * to look around leaves no `tade/*` branch behind.
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
  /** The change this is one repository's share of, by its slug. */
  effort?: string
  /** Who asked for it: kept in the task file, as `TaskOrigin` says it. */
  by?: string
  /** How it counts as finished, kept in the task file. */
  done?: DoneRule
  /**
   * The document it produces rather than a change to the code, as a name in the
   * task's own folder. Refused where it would be a path out of that folder.
   */
  produces?: string
  /** When it starts, for queued work: kept in the task file until it does. */
  start?: StartCondition
  now?: Date
}

/** A created task's git facts. The task *model* lives in @tade/core. */
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
  /** Tade's home: where the task's own folder is. */
  home: string
  root: string
  worktree: string
  branch: string
  /** The task's id: whose folder to take away, and what says it shares the checkout. */
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
  // Refused here rather than at any one caller: this is the only write path
  // into a repository, so the window, the orchestrator and a plan all get the
  // same answer about a document that would not survive its task.
  const bad = opts.produces === undefined ? null : producesProblem(opts.produces)
  if (bad) throw new Error(`${id} cannot produce that: ${bad}`)
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
  const dir = taskDir(opts.home, id)
  await writeTaskFile(
    join(dir, 'task.yaml'),
    task,
    opts.intent,
    opts.now ?? new Date(),
    opts.links ?? [],
    {
      by: opts.by,
      done: opts.done,
      produces: opts.produces?.trim(),
      start: opts.start,
      effort: opts.effort,
    },
  )
  const context = contextDocument(opts.context ?? '', opts.links ?? [])
  if (context) await writeFile(join(dir, 'context.md'), context)
  return task
}

/**
 * A task in the project's own checkout: nothing in the repository changes at
 * all, only a folder of Tade's own saying what was asked. The branch is
 * whatever the checkout is on, and stays so.
 */
async function createSharedTask(opts: CreateTaskOptions, id: string): Promise<TaskWorktree> {
  const dir = taskDir(opts.home, id)
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
    {
      by: opts.by,
      done: opts.done,
      produces: opts.produces?.trim(),
      start: opts.start,
      effort: opts.effort,
    },
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
  kept: {
    by?: string | undefined
    done?: DoneRule | undefined
    produces?: string | undefined
    start?: StartCondition | undefined
    effort?: string | undefined
  },
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
      ...(kept.effort ? { effort: kept.effort } : {}),
      ...(links.length > 0 ? { links: links.map(({ title, url }) => ({ title, url })) } : {}),
      ...(kept.by ? { by: kept.by } : {}),
      ...(kept.done ? { done: kept.done } : {}),
      ...(kept.produces ? { produces: kept.produces } : {}),
      ...(kept.start ? { start: kept.start } : {}),
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
  const own = opts.task ? taskDir(opts.home, opts.task) : ''
  if (own && resolve(opts.worktree) === resolve(opts.root)) {
    await rm(own, { recursive: true, force: true })
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
      const dirty = parseStatusV2(status.stdout).paths
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

  // `--force` unconditionally: the refusals above are Tade's, and they have
  // already passed.
  const removed = await git(opts.root, ['worktree', 'remove', '--force', opts.worktree], 30_000)
  if (!removed.ok) throw new Error(`git worktree remove failed: ${firstLine(removed.stderr)}`)
  if (own) await rm(own, { recursive: true, force: true })

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
  /** Tade's home: where the task's own file is. */
  home: string
  /** The task being named, so its file can be found. */
  task: string
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
    await updateTaskFile(taskFilePath(opts.home, opts.task), (file) => {
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
  home: string,
  id: string,
  title: string,
  named: boolean,
): Promise<void> {
  const text = title.replace(/\s+/g, ' ').trim()
  if (!text) return
  await updateTaskFile(taskFilePath(home, id), (file) => {
    // A name a person chose is kept; any other is better replaced by a better one.
    if (named) {
      file.title = text
      file.title_named = true
    } else if (file.title_named !== true) {
      file.title = text
    }
  })
}

/**
 * What a task said it produces, as the detail of the line that says it
 * finished: nothing at all where it produces nothing, and otherwise the path
 * to read it at plus whether the file was actually there.
 *
 * The path is the resolved one (`producesPath`) and not the name off the task
 * file, because whoever is handed this has to be able to open it without
 * knowing which home or which task it came from — and because the folder it is
 * in is the only copy there is.
 *
 * On `task_done` rather than looked up afterwards, because the journal is the
 * only thing that remembers: the task's folder goes when the task does, and a
 * window that was shut when an agent finished still has to be able to say, the
 * next time it opens, that there is a document waiting to be read.
 *
 * `missing` is the same caution every probe here takes — a task that named a
 * document and did not write one is a thing to go and ask about, and claiming
 * a file exists without looking is how a briefing sends somebody to a path
 * that is not there.
 */
export async function producedDetail(
  home: string,
  task: string | null,
): Promise<{ produces?: string; missing?: true }> {
  if (!task) return {}
  const named = (await readTaskFile(home, task))?.produces?.trim()
  // Checked again on the way into the journal: the file on disk is somebody's
  // to hand-edit, and a name Tade would not have written is not one it joins
  // onto a path.
  if (!named || producesProblem(named)) return {}
  const produces = producesPath(home, task, named)
  return existsSync(produces) ? { produces } : { produces, missing: true }
}

/** A task's file, read and checked; null when there is none or it will not read. */
export async function readTaskFile(home: string, id: string): Promise<TaskFile | null> {
  try {
    const parsed = TaskFile.safeParse(parseYaml(await readFile(taskFilePath(home, id), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Begin queued work in its worktree from where it should: on top of what it
 * waited on, merged together when that was more than one. Only while it has
 * nothing of its own — a queued task has not started, so moving it loses
 * nothing, and one that somehow has work is left exactly where it is.
 */
export async function beginFrom(
  home: string,
  worktree: string,
  id: string,
  refs: readonly string[],
): Promise<void> {
  const [first, ...rest] = refs
  if (!first) return
  const file = await readTaskFile(home, id)
  const dirty = await git(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=no'])
  const ahead = file?.base
    ? await git(worktree, ['rev-list', '--count', `${file.base}..HEAD`])
    : { ok: true, stdout: '0' }
  if (!dirty.ok || dirty.stdout !== '' || !ahead.ok || ahead.stdout.trim() !== '0') {
    throw new Error(`${id} already has work of its own in ${worktree}, so it was not moved`)
  }
  const was = await git(worktree, ['rev-parse', 'HEAD'])
  // Nothing of Tade's is in the tree, so a reset and a merge here are only
  // ever about the work: the task's own file and context are in Tade's home
  // and cannot be reset past, committed over or conflicted with.
  const reset = await git(worktree, ['reset', '--hard', first])
  if (!reset.ok) {
    throw new Error(`${id} could not begin from ${first}: ${firstLine(reset.stderr)}`)
  }
  for (const ref of rest) {
    const merged = await git(worktree, [...AS_TADE, 'merge', '--no-edit', ref], 30_000)
    if (merged.ok) continue
    await git(worktree, ['merge', '--abort'])
    // Back where it was planned, so trying again later begins from the same place.
    if (was.ok) await git(worktree, ['reset', '--hard', was.stdout.trim()])
    const conflict = /CONFLICT/.test(`${merged.stdout}${merged.stderr}`)
    throw new Error(
      conflict
        ? `${id} cannot begin from both ${first} and ${ref}: they conflict`
        : `${id} could not put ${first} and ${ref} together: ${firstLine(merged.stderr || merged.stdout)}`,
    )
  }
  const head = await git(worktree, ['rev-parse', 'HEAD'])
  // Its own work is what comes after here, not after where it was planned.
  if (head.ok) {
    await updateTaskFile(taskFilePath(home, id), (task) => {
      task.base = head.stdout.trim()
    })
  }
}

/** Tade's own commits, never the person's: they only put starting points together. */
const AS_TADE = ['-c', 'user.name=Tade', '-c', 'user.email=tade@localhost']

async function updateTaskFile(
  path: string,
  change: (file: Record<string, unknown>) => void,
): Promise<void> {
  const file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
  change(file)
  await writeFile(path, stringify(file))
}

/** Say which harness a task's agent runs in; empty goes back to the route's. */
export async function setTaskHarness(home: string, id: string, harness: string): Promise<void> {
  await updateTaskFile(taskFilePath(home, id), (file) => {
    if (harness) file.harness = harness
    else delete file.harness
  })
}

/** Run a task's agent as an account from its next start on; `null` for its harness's usual one. */
export async function setTaskAccount(
  home: string,
  id: string,
  account: string | null,
): Promise<void> {
  await updateTaskFile(taskFilePath(home, id), (file) => {
    if (account) file.account = account
    else delete file.account
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
export async function setParked(home: string, id: string, parked: boolean): Promise<ParkResult> {
  const path = taskFilePath(home, id)
  let file: Record<string, unknown>
  try {
    file = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>
  } catch {
    throw new Error(`no task file for ${id}`)
  }
  if (typeof file !== 'object') throw new Error(`unreadable task file for ${id}`)
  file.parked = parked
  await writeFile(path, stringify(file))
  return { task: String(file.id ?? ''), parked }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

/**
 * Refuse a name any task has had. A harness keeps a conversation by the task's
 * name, so a new agent under a removed one's name would carry on its
 * conversation — and two names that make the same conversation in any harness,
 * `a.b` and `a-b` in pi, share one. The journal is what remembers a name after
 * its task is gone.
 *
 * Here rather than on the workbench because it is a rule about names and a
 * question put to the journal, and the file it was in is at the size a file is
 * allowed to be.
 */
export async function guardName(
  deps: {
    /** Each harness's own answer for what conversation a task name makes. */
    keyOf: readonly ((id: string) => string)[]
    created: () => Promise<readonly { task: string | null }[]>
  },
  id: string,
): Promise<void> {
  const keys = deps.keyOf.map((key) => key(id))
  const created = await deps.created().catch(() => [])
  const clash = created.find(
    (event) =>
      event.task &&
      (event.task === id || deps.keyOf.some((key, n) => key(event.task as string) === keys[n])),
  )?.task
  if (!clash) return
  throw new Error(
    clash === id
      ? `${id} was used before, and a task's name is never used twice: pick another`
      : `${id} would carry on ${clash}'s conversation, which was used before: pick another name`,
  )
}
