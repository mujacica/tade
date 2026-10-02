import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type AgentSignal,
  type Config,
  checksFor,
  deriveState,
  expandHome,
  isLive,
  type Project,
  projectDir,
  recordsDir,
  type Task,
  TaskFile,
  TaskId,
  type ToolServers,
  taskFolder,
  type Workspace,
} from '@tade/core'
import { parse as parseYaml } from 'yaml'
import { type AdoptedSession, scanTranscripts } from './adoption.ts'
import { git, listWorktrees, probeGit, resolveBaseRef, type WorktreeEntry } from './git.ts'
import { type LivenessProbe, noLanes } from './liveness.ts'
import { type AgentProcess, listAgentProcesses } from './processes.ts'
import { verifiedAt } from './tests.ts'

// Assembles `tade status`: runs every probe fresh, then derives each task's
// state with the pure state machine. Never throws: every failure becomes a
// warning and a partial answer.

export const TASK_BRANCH_PREFIX = 'tade/'
const TRANSCRIPT_WINDOW_MS = 24 * 60 * 60_000

export interface StatusOptions {
  config: Config
  now: number
  /** $HOME, where provider transcripts live. */
  home: string
  /** Tade's own home, where every task's file is. */
  tadeHome: string
  /** Used as an implicit project when the config lists none. */
  cwd?: string
  /** Query `gh` for PR state (network). */
  pr: boolean
  liveness?: LivenessProbe
  processes?: () => Promise<{
    processes: AgentProcess[]
    servers: ToolServers
    warnings: string[]
  }>
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
    // Nothing was looked at, which is `unknown` and never "every server has
    // gone" — the one answer about this that must not be given wrongly.
    return {
      generatedAt: new Date(opts.now).toISOString(),
      projects: [],
      elsewhere: [],
      toolServers: { looked: false, alive: 0 },
      warnings,
    }
  }
}

async function collect(opts: StatusOptions, warnings: string[]): Promise<Workspace> {
  const { now } = opts
  const liveness = opts.liveness ?? noLanes
  const projects = await resolveProjects(opts, warnings)
  // One look at the machine's processes, whatever else is wanted from it.
  // Adopting sessions reads it to prove a quiet one alive; Tade's own tool
  // servers are read off the same pass, because they are the harness's children
  // and looking is the only way to know one has gone. It is one spawn either
  // way, and it used to happen only where adoption was on — which left a window
  // with adoption off unable to say anything about either.
  const procs = await (opts.processes ?? listAgentProcesses)()
  warnings.push(...procs.warnings)
  const sessions = opts.config.workspace.adopt
    ? await adoptSessions(opts, procs.processes, warnings)
    : []
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

    // Every task file this project has, read once: they are all in Tade's own
    // home now, whether the task works in a worktree of its own or beside the
    // others in the checkout, so there is one place to look rather than two.
    const files = await taskFilesOf(opts.tadeHome, ref, warnings)
    const used = new Set<string>()
    for (const wt of list) {
      // A `tade/*` branch, or a worktree with no branch at all: an agent that
      // has not changed anything yet has nothing to name one after.
      if (wt.branch ? !wt.branch.startsWith(TASK_BRANCH_PREFIX) : wt.bare) continue
      const task = await buildTask(ref, wt, baseRef, opts, liveness, sessions, claimed, warnings, {
        files,
        used,
      })
      if (task) tasks.push(task)
    }
    tasks.push(...(await sharedTasks(ref, opts, liveness, warnings, { files, used })))
    for (const [folder, file] of files) {
      if (used.has(folder) || file?.workspace === 'checkout') continue
      // A task whose worktree somebody took away by hand: its folder is all
      // that is left of it, and saying so is what stops it being a task that
      // simply vanished.
      warnings.push(
        `${ref.name}/${folder}: no worktree of its own any more; its files are in ${join(projectDir(opts.tadeHome, ref.name), 'tasks', folder)}`,
      )
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
    toolServers: procs.servers,
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
  own: { files: Map<string, TaskFile | null>; used: Set<string> },
): Promise<Task | null> {
  const branch = wt.branch ?? ''
  // Two ways to the task file, because a worktree is found by git and the file
  // is filed under the task's id. The branch says which task it is; where the
  // branch cannot — a worktree Tade opened detached, which has none yet — the
  // folder Tade made it in is named after the task and says the same thing.
  const here = basename(wt.path)
  const guesses = [
    branch ? `${ref.name}/${branch.slice(TASK_BRANCH_PREFIX.length).replaceAll('/', '-')}` : '',
    here.startsWith(`${ref.name}-`) ? `${ref.name}/${here.slice(ref.name.length + 1)}` : '',
    `${ref.name}/${here}`,
  ]
  const found = guesses
    .filter((one) => one !== '')
    .map((one) => ({ guess: one, folder: taskFolder(one) }))
    .find((one) => own.files.has(one.folder))
  // A folder whose file would not read is still a task: it is one somebody has
  // to fix, and dropping it would make it a task that never existed.
  const tf = found ? (own.files.get(found.folder) ?? null) : null
  if (found) own.used.add(found.folder)

  // Without a branch, only Tade's own record says this worktree is a task.
  if (!branch && !tf) return null

  // The id the task was made with, which never changes: a branch can be given
  // a name after the fact, and an agent's lanes and session are keyed by this.
  const id = tf?.id?.startsWith(`${ref.name}/`) ? tf.id : (found?.guess ?? guesses[0] ?? '')
  if (!TaskId.safeParse(id).success) {
    warnings.push(`${ref.name}: branch ${branch} does not make a valid task id`)
    return null
  }

  if (!found && !wt.prunable) return null // a tade/* branch without a task
  if (wt.prunable) warnings.push(`${id}: worktree directory is missing`)

  const g = await probeGit(wt.path, { baseRef, taskBase: tf?.base, pr: opts.pr })
  warnings.push(...g.warnings)

  const mine = sessions.filter((s) => within(s.cwd, wt.path))
  for (const s of mine) claimed.add(s)
  const held = await liveness.lanes(id)
  // An agent Tade is running whose harness also writes a transcript is found
  // twice: once as the run, once as a session. It is one agent.
  const running = new Set(
    held.flatMap((signal) => (signal.conversation ? [signal.conversation] : [])),
  )
  const agents: AgentSignal[] = [
    ...held,
    ...mine.filter((s) => !running.has(s.sessionId)).map(stripCwd),
  ]

  const derived = deriveState({
    now: opts.now,
    parked: tf?.parked ?? false,
    git: g.snapshot,
    agents,
    // Only counts for the commit it ran against; anything older is unknown.
    tests: await verifiedAt(wt.path, g.snapshot?.head ?? null, {
      name: ref.name,
      root: wt.path,
      records: recordsDir(opts.tadeHome, ref.name, id),
      test: opts.config.projects[ref.name]?.test_command,
      chosen: checksFor(opts.config, ref.name).run_here,
    }),
  })

  return {
    id,
    project: ref.name,
    intent_spoken: tf?.intent_spoken ?? '',
    branch,
    ...(tf?.title ? { title: tf.title } : {}),
    ...(tf && tf.links.length > 0 ? { links: tf.links } : {}),
    ...(tf?.by ? { by: tf.by } : {}),
    ...(tf?.done ? { done: tf.done } : {}),
    ...(tf?.produces ? { produces: tf.produces } : {}),
    ...(tf?.start ? { start: tf.start } : {}),
    ...(tf?.effort ? { effort: tf.effort } : {}),
    worktree: wt.path,
    created: tf ? tf.created.toISOString() : '',
    ...derived,
    git: g.snapshot,
    agents: agents.sort((a, b) => cmp(a.sessionId, b.sessionId)),
    // This reported an empty list while Tade was tracking lanes the
    // whole time, so `tade status --json` never showed anything to attach to.
    lanes: (await liveness.records?.(id)) ?? [],
  }
}

/**
 * The tasks working in the project's own checkout, side by side: each is a
 * folder under its project in Tade's home. Their git facts are the checkout's,
 * shared, so their state is their agent's — never the files, which are
 * everyone's.
 */
async function sharedTasks(
  ref: ProjectRef,
  opts: StatusOptions,
  liveness: LivenessProbe,
  warnings: string[],
  own: { files: Map<string, TaskFile | null>; used: Set<string> },
): Promise<Task[]> {
  const folders = [...own.files]
    .filter(([folder, file]) => !own.used.has(folder) && file?.workspace === 'checkout')
    .map(([folder]) => folder)
  if (folders.length === 0) return []
  const g = await probeGit(ref.root, { baseRef: null, pr: opts.pr })
  warnings.push(...g.warnings)
  const out: Task[] = []
  for (const folder of folders) {
    const tf = own.files.get(folder)
    if (!tf) continue
    own.used.add(folder)
    const id = tf.id?.startsWith(`${ref.name}/`) ? tf.id : `${ref.name}/${folder}`
    if (!TaskId.safeParse(id).success || taskFolder(id) !== folder) {
      warnings.push(`${ref.name}: tasks/${folder} does not name a task`)
      continue
    }
    const agents = await liveness.lanes(id)
    const derived = deriveState({
      now: opts.now,
      parked: tf.parked,
      git: g.snapshot,
      agents,
      tests: 'unknown',
      shared: true,
    })
    out.push({
      id,
      project: ref.name,
      intent_spoken: tf.intent_spoken,
      branch: g.snapshot?.branch ?? '',
      ...(tf.title ? { title: tf.title } : {}),
      ...(tf.links.length > 0 ? { links: tf.links } : {}),
      ...(tf.by ? { by: tf.by } : {}),
      ...(tf.done ? { done: tf.done } : {}),
      ...(tf.produces ? { produces: tf.produces } : {}),
      ...(tf.start ? { start: tf.start } : {}),
      ...(tf.effort ? { effort: tf.effort } : {}),
      workspace: 'checkout',
      worktree: ref.root,
      created: tf.created.toISOString(),
      ...derived,
      git: g.snapshot,
      agents: agents.sort((a, b) => cmp(a.sessionId, b.sessionId)),
      lanes: (await liveness.records?.(id)) ?? [],
    })
  }
  return out
}

/**
 * Every task file a project has, by the folder it is in: one read of Tade's
 * own home rather than one read per worktree, and the one place a task file
 * can be.
 *
 * A folder that will not read is named rather than passed over — a task whose
 * file is broken is a task somebody has to fix, and silence would make it a
 * task that never existed.
 */
async function taskFilesOf(
  home: string,
  ref: ProjectRef,
  warnings: string[],
): Promise<Map<string, TaskFile | null>> {
  const root = join(projectDir(home, ref.name), 'tasks')
  let folders: string[]
  try {
    folders = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // A project Tade has not made a task in yet: no folder, and nothing wrong.
    return new Map()
  }
  const out = new Map<string, TaskFile | null>()
  for (const folder of folders.sort()) {
    const read = await readTaskFile(join(root, folder))
    if (read.kind === 'absent') continue
    // A folder that will not read is kept as a folder with nothing in it: the
    // task is still there, and saying nothing would lose it.
    if (read.kind === 'invalid') {
      warnings.push(`${ref.name}: tasks/${folder}/task.yaml: ${read.error}`)
    }
    out.set(folder, read.kind === 'ok' ? read.value : null)
  }
  return out
}

type TaskFileRead =
  | { kind: 'ok'; value: TaskFile }
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }

async function readTaskFile(dir: string): Promise<TaskFileRead> {
  let text: string
  try {
    text = await readFile(join(dir, 'task.yaml'), 'utf8')
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

async function adoptSessions(
  opts: StatusOptions,
  processes: AgentProcess[],
  warnings: string[],
): Promise<Located[]> {
  const scan = await scanTranscripts({
    home: opts.home,
    now: opts.now,
    windowMs: TRANSCRIPT_WINDOW_MS,
  })
  warnings.push(...scan.warnings)
  return toSignals(scan.sessions, processes)
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
