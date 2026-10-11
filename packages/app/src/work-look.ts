import { readOutcome, settled } from '@tade/checks-core'
import type { Config } from '@tade/core'
import { git } from '@tade/status'
import { checksAt } from '@tade/workbench/checks'
import type { ActionsView, CheckView } from './frame.ts'
import { commitsFrom, plainly } from './reality.ts'

// One look at what a task has done, for the ACTIONS tab: the commits that
// carry its own trailer, and how its project's checks stand at the commit in
// hand — a run going on right now included.
//
// Here rather than in `live.ts`, whose subject is how often anybody asks and
// what is held between asks: this is what one ask *is*, a handful of `git`s
// and the run records beside them, and it reads nothing `Live` keeps but what
// it is handed.

/** How many lines of a failing check's output the page keeps to show you. */
const TAIL_LINES = 40

/** What one look at a task's work is handed. */
export interface WorkAt {
  task: string
  /** Where it works. */
  root: string
  /** The branch it was started from, which is where its commits are counted from. */
  base: string | null
  /** What status already said of it: its branch, how far ahead, and whose checkout. */
  facts: { branch: string; ahead: number | null; workspace: 'checkout' | 'worktree' } | null
  config: Config
  tadeHome: string
  now: number
}

export async function lookAtWork(at: WorkAt): Promise<ActionsView> {
  const { task, root, base, facts, config, tadeHome, now } = at
  const project = task.split('/')[0] ?? task
  const head = await git(root, ['rev-parse', 'HEAD'])
  const commit = head.ok ? head.stdout.trim() : null
  const since = base ? await git(root, ['merge-base', 'HEAD', base]) : null
  const from = since?.ok ? since.stdout.trim() : null
  // Trailers, so a commit says which task it belongs to wherever it ends
  // up: git's own mechanism, readable in a year by somebody with no Tade.
  // `--shortstat` for what each touched, which is what makes a commit on
  // this page worth more than its subject.
  const log = await git(root, [
    'log',
    '--no-color',
    '-n',
    '30',
    '--format=%x01%H%x00%ct%x00%s%x00%(trailers:key=Tade-Task,valueonly,separator=%x2C)%x00',
    '--shortstat',
    ...(from ? [`${from}..HEAD`] : []),
  ])
  const commits = log.ok ? commitsFrom(log.stdout) : []
  const stood = await checksAt({
    config,
    project,
    worktree: root,
    tadeHome,
    commit,
  })
  const going = stood.running
  const checks: CheckView[] = stood.plan.map((check) => {
    const run = stood.at.find((one) => one.check === check.id)
    const inFlight = going?.checks.find((one) => one.check === check.id)
    // A run in flight is the truth about now; the record is the truth about
    // what finished. Neither is guessed from the other.
    const live = inFlight && !settled(inFlight.state) ? inFlight : null
    const log = run ? stood.runs.find((one) => one.id === run.id) : undefined
    const seconds =
      run?.startedAt && run.finishedAt
        ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
        : null
    const outcome = readOutcome(log?.tail ?? '')
    return {
      id: check.id,
      title: check.title,
      run: check.run,
      state: live ? live.state : (run?.state ?? 'not run'),
      required: check.required,
      skip: check.skip ?? null,
      chosen: stood.rule.run_here[check.id] ?? null,
      needs: check.needs ?? [],
      summary: run?.summary ?? null,
      seconds: live ? null : seconds,
      startedAt: live?.startedAt ? Date.parse(live.startedAt) : null,
      at: run?.finishedAt ? Date.parse(run.finishedAt) : null,
      commit: run?.commit ?? null,
      carried: run ? stood.carried.has(run.id) : false,
      counts: outcome.counts,
      places: outcome.places,
      more: outcome.more,
      // Only what failed keeps its tail on the page: nobody opens a green
      // check to read what it printed, and every row here is a row the
      // failure below it does not get.
      tail:
        log && (log.state === 'failed' || log.state === 'timed out')
          ? log.tail.split('\n').slice(-TAIL_LINES).map(plainly)
          : [],
    }
  })
  const notes: string[] = []
  if (stood.plan.length > 0) {
    // A tick here means less than a tick in CI. Six words of it rather than
    // a sentence: the caveat is true under every check on every page, and
    // one that is read four hundred times is one nobody reads.
    notes.push('on this machine, not CI’s matrix')
  }
  const workspace = facts?.workspace ?? 'checkout'
  return {
    task,
    branch: facts?.branch ?? null,
    base,
    ahead: facts?.ahead ?? null,
    behind: null,
    dirty: 0,
    shared: workspace === 'checkout',
    commit,
    mine: commits.filter((one) => one.task === task),
    others: commits.filter((one) => one.task !== task),
    review: null,
    checks,
    rollup: stood.rollup.state,
    unread: stood.read.problems,
    // Read, not configured: so it says which file said so, and where nothing
    // did, that nothing did — which is the answer, not a gap in the page.
    source:
      stood.plan.length > 0
        ? `read from ${stood.read.from ?? stood.read.source}`
        : 'Nothing here says what checking this project means — no workflow that runs on a change, no commit hook.',
    running: going
      ? {
          since: Date.parse(going.at) || now,
          by: going.by,
          done: going.checks.filter((one) => settled(one.state)).length,
          total: going.checks.length,
        }
      : null,
    notes,
  }
}
