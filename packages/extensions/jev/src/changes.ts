import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionContext, ProjectRef } from '@tade/extensions-core'
import { parse as parseYaml } from 'yaml'

// What an agent changed, read out of git and cut down to what a question can
// be about.
//
// The unit is a task's whole diff against what it branched from, not a
// commit: ten times fewer things to read, each one something a person asked
// for, and it makes room for the question nobody else asks — does this do what
// was asked, and what else did it do? A commit is a step; a task is a change.

/** What one file's part of a change looks like. */
export interface FileChange {
  file: string
  patch: string
  /** How much of the patch was left behind, in characters. */
  cut: number
}

/** A branch with work on it that somebody asked for: what a review is about. */
export interface Unit {
  /** What a finding about it is keyed by: the task, or the project and branch. */
  key: string
  project: string
  /** The tasks whose work is in it. */
  tasks: string[]
  /** The words the work was asked for in, verbatim. */
  intent: string
  /** Where git runs for it. */
  root: string
  branch: string
  head: string
  base: string
  /** When its head landed, so a branch still being typed into is left alone. */
  at: number
}

/**
 * Files a question in the pack cannot be about. Dropped in code rather than
 * asked about: a lockfile is not a judgement, it is bulk, and bulk costs
 * accuracy as well as money. `.tade/` goes with them — Tade's own bookkeeping
 * is not anybody's work, and a task file in a diff would be read as one.
 */
const SKIP_IN = /(^|\/)(\.tade|node_modules|vendor|dist)\//

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|.*\.min\.(js|css)|.*\.snap|.*\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|wav|mp3|mp4|woff2?|ttf))$/i

/** How much of one file's patch is read. Past this, a question is about the first half anyway. */
const PATCH_LIMIT = 20_000

/** The most files one unit is read as. Past this it is a rewrite, and saying so is the answer. */
const FILE_LIMIT = 60

async function git(
  ctx: ExtensionContext,
  root: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ ok: boolean; out: string; said: string }> {
  const ran = await ctx.exec('git', ['-C', root, ...args], { timeoutMs })
  return { ok: ran.code === 0, out: ran.stdout, said: ran.stderr.trim() }
}

/** A task file, as far as anything here needs it. Never throws: a file nobody can read is no task. */
async function taskFile(
  path: string,
): Promise<{ id: string; intent: string; base: string } | null> {
  try {
    const parsed = parseYaml(await readFile(path, 'utf8')) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const id = typeof parsed.id === 'string' ? parsed.id : ''
    const intent = typeof parsed.intent_spoken === 'string' ? parsed.intent_spoken : ''
    const base = typeof parsed.base === 'string' ? parsed.base : ''
    return id ? { id, intent, base } : null
  } catch {
    return null
  }
}

/** The task files in one worktree: its own, or the folders of everyone sharing the checkout. */
export async function tasksIn(
  root: string,
): Promise<{ id: string; intent: string; base: string }[]> {
  const own = await taskFile(join(root, '.tade', 'task.yaml'))
  if (own) return [own]
  const shared: { id: string; intent: string; base: string }[] = []
  const dir = join(root, '.tade', 'tasks')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await taskFile(join(dir, entry.name, 'task.yaml'))
    if (found) shared.push(found)
  }
  return shared.sort((a, b) => a.id.localeCompare(b.id))
}

/** Where a project's work joins the rest of it: what everything is diffed against. */
export async function baseRefOf(ctx: ExtensionContext, root: string): Promise<string> {
  const head = await git(ctx, root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (head.ok && head.out.trim()) return head.out.trim()
  for (const name of ['main', 'master']) {
    const found = await git(ctx, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (found.ok && found.out.trim()) return name
  }
  return 'HEAD'
}

/**
 * Every branch in a project with work on it somebody asked for, and what it is
 * diffed against. One worktree with a task file of its own is that task; a
 * checkout everybody shares is one unit per branch, because their work is one
 * branch and no reading can say whose line is whose.
 */
export async function unitsIn(ctx: ExtensionContext, project: ProjectRef): Promise<Unit[]> {
  const listed = await git(ctx, project.root, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) throw new Error(`${project.root} is not a git repository: ${listed.said}`)
  const worktrees: { path: string; head: string; branch: string }[] = []
  let current: { path: string; head: string; branch: string } | null = null
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: line.slice('worktree '.length).trim(), head: '', branch: '' }
    } else if (line.startsWith('HEAD ') && current) current.head = line.slice(5).trim()
    else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
    }
  }
  if (current) worktrees.push(current)

  const baseRef = await baseRefOf(ctx, project.root)
  const units: Unit[] = []
  for (const worktree of worktrees) {
    const tasks = await tasksIn(worktree.path)
    if (tasks.length === 0 || !worktree.head) continue
    const shared = tasks.length > 1 || !(await taskFile(join(worktree.path, '.tade', 'task.yaml')))
    const key = shared
      ? `${project.name}:${worktree.branch || worktree.head.slice(0, 8)}`
      : (tasks[0]?.id ?? '')
    const recorded = tasks.map((task) => task.base).filter(Boolean)
    const base = await baseOf(ctx, worktree.path, recorded, worktree.head, baseRef)
    if (!base || base === worktree.head) continue
    const when = await git(ctx, worktree.path, ['log', '-1', '--format=%ct', worktree.head])
    units.push({
      key,
      project: project.name,
      tasks: tasks.map((task) => task.id),
      intent: tasks
        .map((task) => task.intent)
        .filter(Boolean)
        .join('\n'),
      root: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      base,
      at: Number(when.out.trim() || 0) * 1000,
    })
  }
  return units
}

/**
 * What a unit is measured from: the commit its task file says it branched at,
 * when that is still in the history, and otherwise where it left the base.
 */
async function baseOf(
  ctx: ExtensionContext,
  root: string,
  recorded: readonly string[],
  head: string,
  baseRef: string,
): Promise<string> {
  for (const said of recorded) {
    const ancestor = await git(ctx, root, ['merge-base', '--is-ancestor', said, head])
    if (ancestor.ok) return said
  }
  const found = await git(ctx, root, ['merge-base', baseRef, head])
  return found.ok ? found.out.trim() : ''
}

/**
 * One change, as somebody asked about it: a range they named, or a branch's
 * own work since it left the base. What it is keyed by is the task when the
 * directory is one task's, and the project and what was asked for otherwise.
 */
export async function unitFor(
  ctx: ExtensionContext,
  project: ProjectRef,
  where: { root: string; ref?: string | null },
): Promise<Unit> {
  const root = where.root
  const tasks = await tasksIn(root)
  const on = await git(ctx, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = on.ok ? on.out.trim().replace(/^HEAD$/, '') : ''
  const resolve = async (rev: string) => {
    const found = await git(ctx, root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    if (!found.ok || !found.out.trim()) throw new Error(`${rev} does not resolve in ${root}`)
    return found.out.trim()
  }
  let base: string
  let head: string
  if (where.ref) {
    const range = where.ref.includes('...')
      ? where.ref.split('...')
      : where.ref.includes('..')
        ? where.ref.split('..')
        : [`${where.ref}~1`, where.ref]
    base = await resolve(range[0] || 'HEAD~1')
    head = await resolve(range[1] || 'HEAD')
  } else {
    head = await resolve('HEAD')
    base = await baseOf(
      ctx,
      root,
      tasks.map((task) => task.base).filter(Boolean),
      head,
      await baseRefOf(ctx, root),
    )
    if (!base) throw new Error(`nothing to diff ${branch || head.slice(0, 8)} against in ${root}`)
  }
  const when = await git(ctx, root, ['log', '-1', '--format=%ct', head])
  return {
    key:
      tasks.length === 1 && tasks[0]
        ? tasks[0].id
        : `${project.name}:${where.ref || branch || head.slice(0, 8)}`,
    project: project.name,
    tasks: tasks.map((task) => task.id),
    intent: tasks
      .map((task) => task.intent)
      .filter(Boolean)
      .join('\n'),
    root,
    branch,
    head,
    base,
    at: Number(when.out.trim() || 0) * 1000,
  }
}

/**
 * One change, file by file, with what a question cannot be about left out.
 * Empty when there is nothing in it a rubric could read — which is an answer,
 * and said as one.
 */
export async function changesIn(
  ctx: ExtensionContext,
  root: string,
  range: string,
  paths: readonly string[] = [],
): Promise<FileChange[]> {
  const listed = await git(ctx, root, [
    'diff',
    '--name-only',
    range,
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ])
  if (!listed.ok) throw new Error(`git diff ${range}: ${listed.said || 'it would not resolve'}`)
  const files = listed.out
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file !== '' && !SKIP.test(file) && !SKIP_IN.test(file))
    .slice(0, FILE_LIMIT)
  const changes: FileChange[] = []
  for (const file of files) {
    const shown = await git(ctx, root, ['diff', '--unified=3', range, '--', file], 20_000)
    const patch = shown.out
    if (patch.trim() === '') continue
    changes.push({
      file,
      patch: patch.slice(0, PATCH_LIMIT),
      cut: Math.max(0, patch.length - PATCH_LIMIT),
    })
  }
  return changes
}

/**
 * What a judge is given about a change: structure, with the words the work was
 * asked for in beside the diff — never a blob of prose, and never bulk the
 * questions do not need.
 */
export function stateOf(
  unit: { intent: string; branch: string; tasks: readonly string[] },
  changes: readonly FileChange[],
): Record<string, unknown> {
  return {
    asked_for: unit.intent,
    branch: unit.branch,
    tasks: [...unit.tasks],
    files_changed: changes.map((change) => change.file),
    diff: changes.map((change) => change.patch).join('\n'),
  }
}

/**
 * The files of one change in groups that fit an ask. A file whose own patch is
 * bigger than a group goes on its own, truncated as it was read.
 */
export function inBatches(changes: readonly FileChange[], budgetChars: number): FileChange[][] {
  const batches: FileChange[][] = []
  let batch: FileChange[] = []
  let size = 0
  for (const change of changes) {
    const length = change.patch.length + change.file.length
    if (batch.length > 0 && size + length > budgetChars) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(change)
    size += length
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}
