import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type AgentSignal,
  type Config,
  deriveState,
  expandHome,
  isLive,
  type Project,
  type Task,
  TaskFile,
  TaskId,
  type Workspace,
} from '@wilco/core'
import { parse as parseYaml } from 'yaml'
import { type AdoptedSession, scanTranscripts } from './adoption.ts'
import { git, listWorktrees, probeGit, resolveBaseRef, type WorktreeEntry } from './git.ts'
import { type LivenessProbe, noLanes } from './liveness.ts'
import { type AgentProcess, listAgentProcesses } from './processes.ts'
import { readTests } from './tests.ts'

// Assembles `wilco status`: runs every probe fresh, then derives each task's
// state with the pure state machine. Never throws: every failure becomes a
// warning and a partial answer.

export const TASK_BRANCH_PREFIX = 'wilco/'
const TRANSCRIPT_WINDOW_MS = 24 * 60 * 60_000

export interface StatusOptions {
  config: Config
  now: number
  /** $HOME, where provider transcripts live. */
  home: string
  /** Used as an implicit project when the config lists none. */
  cwd?: string
  /** Query `gh` for PR state (network). */
  pr: boolean
  liveness?: LivenessProbe
  processes?: () => Promise<{ processes: AgentProcess[]; warnings: string[] }>
}

interface ProjectRef {
  name: string
  root: string
  brief: string | null
}

type Located = AgentSignal & { cwd: string }

export async function collectStatus(opts: StatusOptions): Promise<Workspace> {
  const warnings: string[] = []
  try {
    return await collect(opts, warnings)
  } catch (err) {
    warnings.push(`status: unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    return { generatedAt: new Date(opts.now).toISOString(), projects: [], elsewhere: [], warnings }
  }
}

async function collect(opts: StatusOptions, warnings: string[]): Promise<Workspace> {
  const { now } = opts
  const liveness = opts.liveness ?? noLanes
  const projects = await resolveProjects(opts, warnings)
  const sessions = opts.config.workspace.adopt ? await adoptSessions(opts, warnings) : []
  const claimed = new Set<Located>()

  const out: Project[] = []
  for (const ref of projects) {
    const tasks: Task[] = []
    const list = await listWorktrees(ref.root)
    if ('error' in list) {
      warnings.push(`${ref.name}: ${ref.root}: ${list.error.split('\n')[0]}`)
      out.push({ ...ref, tasks, untracked: [] })
      continue
    }
    const baseRef = await resolveBaseRef(ref.root)
    if (baseRef === null) warnings.push(`${ref.name}: no base branch (main/master) found`)

    for (const wt of list) {
      // A `wilco/*` branch, or a worktree with no branch at all: an agent that
      // has not changed anything yet has nothing to name one after.
      if (wt.branch ? !wt.branch.startsWith(TASK_BRANCH_PREFIX) : wt.bare) continue
      const task = await buildTask(ref, wt, baseRef, opts, liveness, sessions, claimed, warnings)
      if (task) tasks.push(task)
    }

    const inRepo = list.map((w) => w.path)
    const untracked = sessions.filter(
      (s) => !claimed.has(s) && inRepo.some((p) => within(s.cwd, p)) && isLive(s, now),
    )
    for (const s of untracked) claimed.add(s)
    tasks.sort((a, b) => cmp(a.id, b.id))
    out.push({ ...ref, tasks, untracked: untracked.sort(bySession) })
  }

  const elsewhere = sessions.filter((s) => !claimed.has(s) && isLive(s, now)).sort(bySession)
  out.sort((a, b) => cmp(a.name, b.name))
  return {
    generatedAt: new Date(now).toISOString(),
    projects: out,
    elsewhere,
    warnings: [...new Set(warnings)].sort(),
  }
}

async function buildTask(
  ref: ProjectRef,
  wt: WorktreeEntry,
  baseRef: string | null,
  opts: StatusOptions,
  liveness: LivenessProbe,
  sessions: Located[],
  claimed: Set<Located>,
  warnings: string[],
): Promise<Task | null> {
  const branch = wt.branch ?? ''
  const file = await readTaskFile(wt.path)
  // Without a branch, only Wilco's own record says this worktree is a task.
  if (!branch && file.kind !== 'ok') return null
  const tf = file.kind === 'ok' ? file.value : null

  // The id the task was made with, which never changes: a branch can be given
  // a name after the fact, and an agent's lanes and session are keyed by this.
  const fromBranch = `${ref.name}/${branch.slice(TASK_BRANCH_PREFIX.length).replaceAll('/', '-')}`
  const id = tf?.id?.startsWith(`${ref.name}/`) ? tf.id : fromBranch
  if (!TaskId.safeParse(id).success) {
    warnings.push(`${ref.name}: branch ${branch} does not make a valid task id`)
    return null
  }

  if (file.kind === 'absent' && !wt.prunable) return null // a wilco/* branch without a task
  if (file.kind === 'invalid') warnings.push(`${id}: .wilco/task.yaml: ${file.error}`)
  if (file.kind === 'absent') warnings.push(`${id}: worktree directory is missing`)

  const g = await probeGit(wt.path, { baseRef, taskBase: tf?.base, pr: opts.pr })
  warnings.push(...g.warnings)

  const mine = sessions.filter((s) => within(s.cwd, wt.path))
  for (const s of mine) claimed.add(s)
  const agents: AgentSignal[] = [...(await liveness.lanes(id)), ...mine.map(stripCwd)]

  const derived = deriveState({
    now: opts.now,
    parked: tf?.parked ?? false,
    git: g.snapshot,
    agents,
    // Only counts for the commit it ran against; anything older is unknown.
    tests: await readTests(wt.path, g.snapshot?.head ?? null),
  })

  return {
    id,
    project: ref.name,
    intent_spoken: tf?.intent_spoken ?? '',
    branch,
    ...(tf?.title ? { title: tf.title } : {}),
    ...(tf && tf.links.length > 0 ? { links: tf.links } : {}),
    worktree: wt.path,
    created: tf ? tf.created.toISOString() : '',
    ...derived,
    git: g.snapshot,
    agents: agents.sort((a, b) => cmp(a.sessionId, b.sessionId)),
    // This reported an empty list while Wilco was tracking lanes the
    // whole time, so `wilco status --json` never showed anything to attach to.
    lanes: (await liveness.records?.(id)) ?? [],
  }
}

type TaskFileRead =
  | { kind: 'ok'; value: TaskFile }
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }

async function readTaskFile(worktree: string): Promise<TaskFileRead> {
  let text: string
  try {
    text = await readFile(join(worktree, '.wilco', 'task.yaml'), 'utf8')
  } catch {
    return { kind: 'absent' }
  }
  try {
    const parsed = TaskFile.safeParse(parseYaml(text))
    if (parsed.success) return { kind: 'ok', value: parsed.data }
    const i = parsed.error.issues[0]
    return { kind: 'invalid', error: `${i?.path.join('.') || '(root)'}: ${i?.message}` }
  } catch (err) {
    return { kind: 'invalid', error: `invalid YAML: ${(err as Error).message.split('\n')[0]}` }
  }
}

async function resolveProjects(opts: StatusOptions, warnings: string[]): Promise<ProjectRef[]> {
  const configured = Object.entries(opts.config.projects).map(([name, p]) => ({
    name,
    root: expandHome(p.root),
    brief: p.brief ?? null,
  }))
  if (configured.length > 0 || !opts.cwd) return configured

  // No projects configured: the repo we're standing in is the project.
  const r = await git(opts.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok) {
    warnings.push('no projects configured and not inside a git repository')
    return []
  }
  const root = dirname(r.stdout.trim())
  const name =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '') || 'repo'
  return [{ name, root, brief: null }]
}

async function adoptSessions(opts: StatusOptions, warnings: string[]): Promise<Located[]> {
  const [scan, procs] = await Promise.all([
    scanTranscripts({ home: opts.home, now: opts.now, windowMs: TRANSCRIPT_WINDOW_MS }),
    (opts.processes ?? listAgentProcesses)(),
  ])
  warnings.push(...scan.warnings, ...procs.warnings)
  return toSignals(scan.sessions, procs.processes)
}

/**
 * A running provider process in a session's cwd proves the most recent session
 * there is alive. Absence proves nothing (IDE-hosted agents run elsewhere), so
 * everything else stays `alive: null` and falls back to transcript recency.
 */
export function toSignals(sessions: AdoptedSession[], processes: AgentProcess[]): Located[] {
  const provenAlive = new Set<AdoptedSession>()
  for (const p of processes) {
    const newest = sessions
      .filter((s) => s.provider === p.provider && s.cwd === p.cwd)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (newest) provenAlive.add(newest)
  }
  return sessions.map((s) => ({
    source: 'adopted',
    provider: s.provider,
    sessionId: s.sessionId,
    cwd: s.cwd,
    alive: provenAlive.has(s) ? true : null,
    lastActivityAt: s.lastActivityAt,
    turn: s.turn,
    pendingPermissions: s.pendingPermissions,
    consecutiveFailures: s.consecutiveFailures,
    exitCode: null,
  }))
}

function stripCwd({ cwd: _cwd, ...rest }: Located): AgentSignal {
  return rest
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const bySession = (a: Located, b: Located) => cmp(a.sessionId, b.sessionId)
