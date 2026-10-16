import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RunnerError } from '@tade/checks-core'
import {
  type CaseStarted,
  type Config,
  caseDetail,
  casesFor,
  isTestPath,
  outcomesFrom,
  type Plan,
  type PlanBusy,
  pricesFrom,
  REPLAY_EVENTS,
  REPLAY_LAST,
  type Replay,
  type ReplayCandidate,
  type ReplayCase,
  type ReplayEntrantFacts,
  type ReplayRequest,
  RUNTIME_EVENTS,
  replayPlan,
  replayRecords,
  replaysIn,
  runtimeFrom,
  spendFrom,
  type TadeEvent,
  workedOf,
} from '@tade/core'
import { git } from '@tade/status'
import { checksAt, runProjectChecks } from './checks.ts'
import type { EventLog } from './events.ts'
import type { PlanMade } from './plans.ts'
import { taskContextPath } from './tasks.ts'

// The two acts a replay has that touch the world (`replay.ts` in core is the
// rest, and pure): reading which landed work there is to ask again, with what
// git still knows about each piece of it, and grading one entrant against the
// tests the original added.
//
// **Every case is read out of the journal first**, because the journal is the
// one thing that outlives a task: `task_created` keeps the words verbatim and
// the commit it began from, `commit_seen` keeps whose each commit was and what
// it changed, `usage` and the runs keep what it cost and took. Git is asked
// only what it alone can say — whether that commit is still there, and which
// of the original's files are tests.
//
// **Grading never touches the entrant's branch.** It detaches the entrant's
// own worktree (prepared when it started, so the checks can run there at all),
// lays the original's test files over its head in a commit nobody will ever
// see, runs the project's checks through the one door every run goes through
// (`runProjectChecks`: the locks, the machine's slot and the record come free),
// and puts the worktree back on its branch — in a `finally`, and again before
// the next grading, so a window that closed half way leaves nothing behind.

/** The events a case is read out of. */
export const CASE_EVENTS = [
  'task_created',
  'template_used',
  'run_started',
  'run_model',
  'run_exited',
  'turn_started',
  'turn_done',
  'usage',
  'task_done',
  'commit_seen',
] as const

/** Every task that landed in a project, as a case to replay: newest first. */
export async function landedCases(opts: {
  home: string
  config: Config
  project: string
  events: readonly TadeEvent[]
  /** Tasks a forge said were merged at the last look, where anybody looked. */
  merged?: ReadonlySet<string> | null
  now: number
}): Promise<ReplayCase[]> {
  const root = opts.config.projects[opts.project]?.root
  if (!root) throw new Error(`there is no project called ${opts.project}`)
  const outcomes = outcomesFrom(opts.events, {
    since: 0,
    merged: opts.merged ?? null,
    projects: new Set([opts.project]),
  }).filter((one) => one.landed && one.done !== null)
  if (outcomes.length === 0) return []
  const spent = spendFrom(opts.events, { since: 0, prices: pricesFrom(opts.config.prices) }).byTask
  const runtime = runtimeFrom(opts.events, { now: opts.now }).byTask
  const created = new Map<string, Record<string, unknown>>()
  const commits = new Map<string, { sha: string; at: string; added: number; removed: number }[]>()
  for (const event of opts.events) {
    if (!event.task) continue
    if (event.type === 'task_created') created.set(event.task, event.detail)
    if (event.type === 'commit_seen' && typeof event.detail.sha === 'string') {
      const n = (key: string) =>
        typeof event.detail[key] === 'number' ? (event.detail[key] as number) : 0
      commits.set(event.task, [
        ...(commits.get(event.task) ?? []),
        {
          sha: event.detail.sha,
          at: typeof event.detail.at === 'string' ? event.detail.at : event.ts,
          added: n('added'),
          removed: n('removed'),
        },
      ])
    }
  }
  const cases: ReplayCase[] = []
  for (const one of outcomes) {
    const detail = created.get(one.task) ?? {}
    const own = (commits.get(one.task) ?? []).sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
    )
    const head = own.at(-1)?.sha ?? null
    const base = await baseOf(root, detail.base, own[0]?.sha)
    const spend = spent[one.task]
    const ran = runtime[one.task]
    cases.push({
      task: one.task,
      project: opts.project,
      said: typeof detail.intent_spoken === 'string' ? detail.intent_spoken : '',
      base,
      baseThere: base !== null && (await git(root, ['cat-file', '-e', `${base}^{commit}`])).ok,
      harness: one.harness,
      model: one.model,
      done: one.done ?? 0,
      context: await contextOf(opts.home, one.task),
      usd: spend?.hasCost ? spend.usd : null,
      workedMs: ran && workedOf(ran) === 'recorded' ? ran.workingMs : null,
      size:
        own.length > 0
          ? {
              added: own.reduce((sum, c) => sum + c.added, 0),
              removed: own.reduce((sum, c) => sum + c.removed, 0),
            }
          : null,
      tests: head
        ? await testsOf(
            root,
            own.map((c) => c.sha),
            head,
          )
        : [],
      head,
    })
  }
  return cases.sort((a, b) => b.done - a.done)
}

/**
 * Where a task began: what its `task_created` said, or — for one made before
 * that was written down — the parent of its first own commit.
 */
async function baseOf(
  root: string,
  said: unknown,
  first: string | undefined,
): Promise<string | null> {
  if (typeof said === 'string' && /^[0-9a-f]{7,40}$/.test(said)) return said
  if (!first) return null
  const parent = await git(root, ['rev-parse', '--verify', '--quiet', `${first}^`])
  return parent.ok ? parent.stdout.trim() : null
}

/** What a task was given to read first, where it still has it. */
async function contextOf(home: string, task: string): Promise<string | null> {
  const path = taskContextPath(home, task)
  if (!existsSync(path)) return null
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.trim() ? text : null
}

/** The test files these commits touched that are still there at `head`. */
async function testsOf(root: string, shas: readonly string[], head: string): Promise<string[]> {
  const shown = await git(root, ['show', '--name-only', '--format=', ...shas], 20_000)
  if (!shown.ok) return []
  const touched = [...new Set(shown.stdout.split('\n').map((one) => one.trim()))].filter(
    (one) => one !== '' && isTestPath(one),
  )
  if (touched.length === 0) return []
  const there = await git(root, ['ls-tree', '-r', '--name-only', head, '--', ...touched])
  return there.ok
    ? there.stdout
        .split('\n')
        .filter((one) => one.trim() !== '')
        .sort()
    : []
}

/** What starting one needs of whoever starts it — the window, or the CLI's workbench. */
export interface ReplayStartDeps {
  home: string
  config: Config
  log: Pick<EventLog, 'read' | 'append'>
  planTasks(plan: Plan, by?: string, busy?: readonly PlanBusy[]): Promise<PlanMade>
  merged?: ReadonlySet<string> | null
  now: number
}

/** What somebody asked a replay to be. */
export interface ReplayAsk {
  project: string
  name: string
  said: string
  candidate: ReplayCandidate
  /** How many landed tasks: `REPLAY_LAST` when unsaid. */
  last?: number
  ceilingUsd: number
  at?: string
  atOnce?: number
  by: string
}

/** A replay started: its plan's tasks, and every case it took. */
export interface ReplayMade {
  made: PlanMade
  cases: CaseStarted[]
}

/**
 * Start a replay: read the landed cases, make the plan, and only once its tasks
 * are made write down what was asked and what each case became — so a replay
 * that could not be made leaves no record of one. Throws every reason.
 */
export async function startReplay(
  deps: ReplayStartDeps,
  ask: ReplayAsk,
  busy: readonly PlanBusy[] = [],
): Promise<ReplayMade> {
  const events = await deps.log.read({ types: [...CASE_EVENTS] })
  const cases = await landedCases({
    home: deps.home,
    config: deps.config,
    project: ask.project,
    events,
    merged: deps.merged ?? null,
    now: deps.now,
  })
  const request: ReplayRequest = {
    project: ask.project,
    name: ask.name,
    said: ask.said,
    candidate: ask.candidate,
    cases: casesFor(cases, ask.candidate, ask.last ?? REPLAY_LAST),
    ceilingUsd: ask.ceilingUsd,
    ...(ask.at ? { at: ask.at } : {}),
    ...(ask.atOnce !== undefined ? { atOnce: ask.atOnce } : {}),
  }
  const planned = replayPlan(request)
  if (!planned.ok) throw new Error(`the replay was not started: ${planned.problems.join('; ')}`)
  const made = await deps.planTasks(planned.plan, ask.by, busy)
  await deps.log.append({
    type: 'replay_started',
    detail: {
      replay: ask.name,
      project: ask.project,
      said: ask.said,
      by: ask.by,
      candidate: ask.candidate,
      ceiling_usd: ask.ceilingUsd,
      at_once: ask.atOnce ?? null,
      cases: planned.cases.map(caseDetail),
    },
  })
  return { made, cases: planned.cases }
}

/** One entrant to grade: where it is, and what of the original to lay over it. */
export interface GradeRequest {
  config: Config
  project: string
  task: string
  replay: string
  /** The entrant's own worktree, prepared when it started. */
  worktree: string
  /** The original's newest own commit, which its tests are taken from. */
  from: string | null
  tests: readonly string[]
  /** $HOME, so a tail says `~`. */
  home: string
  tadeHome: string
  log: Pick<EventLog, 'append'>
  /** How long to wait for the machine's slot before this look gives up and the next tries. */
  waitMs?: number
}

const GRADER = ['-c', 'user.name=Tade', '-c', 'user.email=tade@localhost']

/**
 * Put a worktree a grading run detached back on its branch, where one was left
 * half way: the branch it is a worktree of, from what git says it checked out.
 * Nothing when it is on a branch already.
 */
export async function putBackOnBranch(worktree: string, branch: string): Promise<void> {
  const on = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (on.ok || !branch) return
  await git(worktree, ['checkout', '--force', branch], 20_000)
}

/**
 * Grade one entrant: the project's checks at its head, with the original's
 * tests laid over it, written down as `replay_graded`. Returns what it wrote.
 */
export async function gradeEntrant(
  req: GradeRequest,
): Promise<{ state: string; failed: string[] }> {
  const branch = (
    await git(req.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  ).stdout.trim()
  const head = (await git(req.worktree, ['rev-parse', 'HEAD'])).stdout.trim()
  const write = async (state: string, failed: string[], laid: readonly string[], why = '') => {
    await req.log.append({
      type: 'replay_graded',
      task: req.task,
      detail: {
        replay: req.replay,
        project: req.project,
        state,
        failed,
        laid: [...laid],
        sha: head,
        ...(why ? { why } : {}),
      },
    })
    return { state, failed }
  }
  if (!branch || !head) {
    return write('could not run', [], [], 'its worktree is not on its own branch')
  }
  const dirty = await git(req.worktree, ['status', '--porcelain=v2', '--untracked-files=no'])
  if (!dirty.ok || dirty.stdout.trim() !== '') {
    return write('could not run', [], [], 'its worktree has changes nobody committed')
  }
  let laid: string[] = []
  let commit = head
  try {
    if (req.from && req.tests.length > 0) {
      await git(req.worktree, ['checkout', '--detach'])
      const taken = await git(req.worktree, ['checkout', req.from, '--', ...req.tests], 20_000)
      if (!taken.ok)
        return await write(
          'could not run',
          [],
          [],
          `the original’s tests would not check out: ${taken.stderr}`,
        )
      laid = [...req.tests]
      const made = await git(req.worktree, [
        ...GRADER,
        'commit',
        '--no-verify',
        '--allow-empty',
        '-q',
        '-m',
        `replay ${req.replay}: the original's tests over ${head.slice(0, 7)}`,
      ])
      if (!made.ok)
        return await write(
          'could not run',
          [],
          laid,
          `the tests could not be laid over it: ${made.stderr}`,
        )
      commit = (await git(req.worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    }
    const logs = await runProjectChecks({
      config: req.config,
      project: req.project,
      worktree: req.worktree,
      task: req.task,
      commit,
      by: `replay:${req.replay}`,
      home: req.home,
      tadeHome: req.tadeHome,
      waitMs: req.waitMs ?? 0,
    })
    if (logs.length === 0) {
      return await write('could not run', [], laid, 'the project says nothing to check')
    }
    const failed = logs
      .filter((one) => one.state === 'failed' || one.state === 'timed out')
      .map((one) => one.check)
    return await write(failed.length > 0 ? 'failed' : 'passed', failed, laid)
  } catch (err) {
    // Somebody else has the worktree or the machine: nothing is written, and the
    // next look grades it — a grading that never ran is not one that failed.
    if (err instanceof RunnerError && err.trouble === 'busy') throw err
    return await write('could not run', [], laid, err instanceof Error ? err.message : String(err))
  } finally {
    await putBackOnBranch(req.worktree, branch)
  }
}

/** What `replaysOnDisk` reads of the journal. */
export const REPLAY_READS = [
  ...REPLAY_EVENTS,
  ...RUNTIME_EVENTS,
  'task_created',
  'task_removed',
  'task_done',
  'usage',
] as const

/**
 * Every replay, read from files alone — the journal, each entrant's worktree
 * and its check records — for a question asked with no window open (`tade
 * eval show`). Nothing here reads a judge: what it would say about straying is
 * `null`, which every surface says as not read.
 */
export async function replaysOnDisk(opts: {
  home: string
  config: Config
  events: readonly TadeEvent[]
  now: number
}): Promise<Replay[]> {
  const records = replayRecords(opts.events)
  if (records.started.size === 0) return []
  const worktrees = new Map<string, string>()
  const finished = new Set<string>()
  const removed = new Set<string>()
  for (const event of opts.events) {
    if (!event.task) continue
    if (event.type === 'task_created' && typeof event.detail.worktree === 'string') {
      worktrees.set(event.task, event.detail.worktree)
    }
    if (event.type === 'task_done') finished.add(event.task)
    if (event.type === 'task_removed') removed.add(event.task)
  }
  const spent = spendFrom(opts.events, { since: 0, prices: pricesFrom(opts.config.prices) }).byTask
  const ran = runtimeFrom(opts.events, { now: opts.now }).byTask
  const facts = new Map<string, ReplayEntrantFacts>()
  for (const started of records.started.values()) {
    for (const one of started.cases) {
      if (!one.task) continue
      const runtime = ran[one.task]
      const worktree = worktrees.get(one.task)
      const look =
        worktree && existsSync(worktree)
          ? await lookAt(opts, started.project, one.task, worktree, one.original?.base ?? null)
          : null
      facts.set(one.task, {
        task: one.task,
        removed: removed.has(one.task),
        started: runtime !== undefined && runtime.runs > 0,
        finished: finished.has(one.task),
        state: null,
        checks: look?.checks ?? null,
        failed: look?.failed ?? [],
        strayed: null,
        size: look?.size ?? null,
        usd: spent[one.task]?.hasCost ? (spent[one.task]?.usd ?? null) : null,
        workedMs: runtime && runtime.runs > 0 ? runtime.workingMs : null,
      })
    }
  }
  return replaysIn(records, (task) => facts.get(task) ?? null)
}

/** One entrant's tree, looked at: its checks at its head, and what it changed since it began. */
async function lookAt(
  opts: { home: string; config: Config },
  project: string,
  task: string,
  worktree: string,
  base: string | null,
): Promise<{
  checks: ReplayEntrantFacts['checks']
  failed: string[]
  size: ReplayEntrantFacts['size']
}> {
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim() || null
  const stood = await checksAt({
    config: opts.config,
    project,
    worktree,
    tadeHome: opts.home,
    task,
    commit: head,
  }).catch(() => null)
  let size: ReplayEntrantFacts['size'] = null
  if (base && head) {
    const count = await git(worktree, ['rev-list', '--count', `${base}..${head}`])
    const stat = await git(worktree, ['diff', '--shortstat', base, head])
    if (count.ok && stat.ok) {
      const n = (what: RegExp) => Number(what.exec(stat.stdout)?.[1] ?? 0)
      size = {
        commits: Number(count.stdout.trim()) || 0,
        added: n(/(\d+) insertion/),
        removed: n(/(\d+) deletion/),
      }
    }
  }
  return {
    checks: stood ? stood.rollup.state : null,
    failed: stood ? [...stood.rollup.failed] : [],
    size,
  }
}
