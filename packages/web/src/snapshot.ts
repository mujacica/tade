import type { PlanStanding, Spend } from '@tade/core'
import { taskRev } from './acting.ts'
import { withoutPaths } from './fields.ts'
import type {
  FindingIn,
  NoteIn,
  QueueIn,
  QueueStateIn,
  ReasonIn,
  SnapshotInput,
  TaskIn,
} from './input.ts'
import { BUDGET, type Budget, type Page, pageOf, textOf, withheld } from './page.ts'
import type {
  Collection,
  FindingRow,
  Freshness,
  NoteRow,
  PlanRow,
  ProjectRow,
  QueueRow,
  QueueStateOut,
  Said,
  Snapshot,
  SpendOut,
  TaskRow,
} from './protocol.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import { has, type Reach, readsOf, sees } from './reach.ts'

// The projection. One pure function of what it is handed and the moment.
//
// No `node:` import, no clock read, nothing to await — the same rule the
// window's own pure files are held to (`test/modularity.test.ts`), and for the
// same reason: a function of its arguments can be tested exhaustively, and a
// projection is the one place in the away view where being sure matters more
// than anything else.
//
// `now` is an argument. `epoch` and `rev` are **not** computed here: they
// belong to the server's lifetime, they arrive on `input.lifetime`, and
// `revise` in `delta.ts` is what advances a revision.

/** Where each collection should carry on from, when a client is paging one. */
export type Cursors = Partial<Record<Collection, string | null>>

const ISO = (at: number): string => new Date(at).toISOString()
const ISO_OR = (at: number | null): string | null => (at === null ? null : ISO(at))

/**
 * An empty string is `unknown`, and goes out as `null`.
 *
 * `@tade/core` spells "nobody said" as `UNRECORDED = ''` in some places and
 * `null` in others, which is right inside the domain and wrong on a wire: a
 * client written against two spellings of the same answer gets one of them
 * wrong. One spelling here — `null` — and `test/leak.test.ts` asserts no value
 * in a projection is ever `''`.
 */
const SOME = (text: string): string | null => (text === '' ? null : text)

/** Whether this device may read a note at all, from the scope it was taken in. */
export function noteSeen(reach: Reach, scope: string | null): boolean {
  if (scope === null) return true
  const project = scope.includes('/') ? (scope.split('/')[0] ?? scope) : scope
  return sees(reach, project)
}

/**
 * `deriveState`'s clause, written from the one field that is a name.
 *
 * For every state but one this is the clause itself, verbatim. For a task
 * blocked on an approval it is the same sentence `deriveState` writes — the
 * same words, the same `(+n more)` — with the tool's name where the harness's
 * one-line summary of the call would be. `input.ts`'s `ReasonIn` carries the
 * argument for why the summary never gets this far.
 */
export function reasonOf(reason: ReasonIn): string {
  if (reason.kind === 'clause') return reason.said
  const more = reason.also > 0 ? ` (+${reason.also} more)` : ''
  return `wants approval: ${reason.tool}${more}`
}

/** `blocked | failed | review` — the one flag this file derives rather than reads. */
export function wantsYou(state: TaskIn['state']): boolean {
  return state === 'blocked' || state === 'failed' || state === 'review'
}

function spendOf(spend: Spend): SpendOut {
  return {
    usd: spend.usd,
    usdExact: spend.usdExact,
    usdEstimated: spend.usdEstimated,
    usdListed: spend.usdListed,
    usdOnPlan: spend.usdOnPlan,
    tokens: spend.tokens,
    tokensUnpriced: spend.tokensUnpriced,
    tokensOnPlanUnrated: spend.tokensOnPlanUnrated,
    hasCost: spend.hasCost,
  }
}

function queueStateOf(state: QueueStateIn): QueueStateOut {
  switch (state.kind) {
    case 'waiting':
      return { kind: 'waiting', on: [...state.on] }
    case 'held':
      return {
        kind: 'held',
        on: state.on,
        because: state.because,
        changed: state.changed,
        by: [...state.by],
      }
    case 'scheduled':
      return { kind: 'scheduled', at: ISO(state.at) }
    case 'paused':
      return { kind: 'paused', all: state.all, parked: state.parked }
    default:
      return { kind: 'ready' }
  }
}

function taskRow(task: TaskIn, reach: Reach, budget: Budget): TaskRow {
  const said = (text: string, granted: boolean): Said | null =>
    granted ? textOf(text, budget.text) : null
  return {
    id: task.id,
    project: task.project,
    name: task.id.slice(task.project.length + 1) || task.id,
    state: task.state,
    reason: reasonOf(task.reason),
    stalled: task.stalled,
    parked: task.parked,
    rev: taskRev({ parked: task.parked }),
    wantsYou: wantsYou(task.state),
    question: task.question,
    approval:
      task.approval === null
        ? null
        : { id: task.approval.id, tool: task.approval.tool, since: ISO(task.approval.sinceAt) },
    createdAt: ISO(task.createdAt),
    movedAt: ISO_OR(task.movedAt),
    title: said(task.title, has(reach, 'titles')),
    intent: said(task.intent, has(reach, 'intent')),
    branch: SOME(task.branch),
    ahead: task.ahead,
    behind: task.behind,
    dirty: task.dirty,
    workspace: task.workspace,
    shared: task.shared,
    effort: SOME(task.effort),
    done: task.done,
    produces: task.produces,
    harness: SOME(task.harness),
    model: SOME(task.model),
    account: said(task.account, has(reach, 'accounts')),
    origin: { kind: task.origin.kind, name: task.origin.name },
    spend: has(reach, 'spend') ? spendOf(task.spend) : null,
    checks: {
      state: task.checks.state,
      failed: [...task.checks.failed],
      missing: [...task.checks.missing],
      overridden: task.checks.overridden,
    },
    agents: task.agents,
    lanes: task.lanes,
    review:
      task.review === null
        ? null
        : { state: task.review.state, url: has(reach, 'reviews') ? task.review.url : null },
  }
}

function queueRow(item: QueueIn, reach: Reach, budget: Budget): QueueRow {
  const why = has(reach, 'intent')
  return {
    task: item.task,
    project: item.project,
    state: queueStateOf(item.state),
    order: item.order,
    waitsOn: item.waitsOn.map((one) => ({
      task: one.task,
      why: why ? textOf(one.why, budget.text) : null,
    })),
  }
}

function findingRow(found: FindingIn, budget: Budget): FindingRow {
  return {
    key: found.key,
    question: found.question,
    project: found.project,
    tasks: [...found.tasks],
    at: ISO(found.at),
    probability: found.probability,
    file: found.file,
    stillThere: found.stillThere,
    accounted: found.account !== null,
    account:
      found.account === null
        ? null
        : {
            did: found.account.did,
            said: textOf(found.account.said, budget.text),
            at: found.account.at,
          },
    verdict: found.verdict === null ? null : { was: found.verdict.was, at: found.verdict.at },
  }
}

/**
 * Notes, with an id made for them.
 *
 * A note has no id of its own — the workbench forgets one by `{at, text}` —
 * so the projection needs one, and it has to be stable or a delta will merge
 * one note's text into another's row. `<at>#<n>`, with `n` telling apart notes
 * written in the same millisecond, is stable because `memory.jsonl` is
 * append-only: nothing is ever inserted before a note that already has an
 * ordinal.
 */
export function noteRows(notes: readonly NoteIn[], reach: Reach, budget: Budget): NoteRow[] {
  const seen = new Map<string, number>()
  const rows: NoteRow[] = []
  for (const one of notes) {
    const n = seen.get(one.at) ?? 0
    seen.set(one.at, n + 1)
    if (!noteSeen(reach, one.scope)) continue
    rows.push({
      id: `${one.at}#${n}`,
      at: one.at,
      scope: one.scope,
      by: one.by,
      text: textOf(one.text, budget.text),
      summary: textOf(one.summary, budget.text),
    })
  }
  return rows
}

function planRow(plan: PlanStanding, reach: Reach, budget: Budget): PlanRow {
  return {
    id: `${plan.harness}/${plan.account ?? ''}`,
    harness: plan.harness,
    account: has(reach, 'accounts') ? textOf(plan.account, budget.text) : null,
    pays: plan.pays,
    windows: plan.windows.map((window) => ({
      label: window.label,
      used: window.used,
      resetsAt: window.resetsAt === 0 ? null : ISO(window.resetsAt),
    })),
    at: ISO_OR(plan.at),
    cannotTell: plan.cannotTell,
  }
}

function freshnessOf(input: SnapshotInput, now: number, budget: Budget): Freshness {
  return {
    at: ISO(now),
    epoch: input.lifetime.epoch,
    rev: input.lifetime.rev,
    openedAt: ISO(input.lifetime.openedAt),
    machineUpSince: ISO_OR(input.machineUpSince),
    spendSince: ISO_OR(input.spendSince),
    // **The one metadata field whose words are composed elsewhere**, and so
    // the one that needs the claim kept rather than inherited: `collectStatus`
    // writes a project's own checkout into a warning when git will not answer
    // in it. `withoutPaths` is why *the away view adds no path of its own*
    // stays true of a sentence this package did not write.
    warnings: warningsIn(input.warnings, budget),
  }
}

/**
 * Status's warnings, as much of them as the budget allows.
 *
 * Capped, and **what was left out is said in the last line** rather than in a
 * count beside it: the freshness is on every frame a client is sent, a `tick`
 * included, so a field here is a field paid for twice a second for as long as
 * a phone is awake. A count would need its own place on `Freshness`, and this
 * is a list of sentences for a person to read — one more sentence is the shape
 * it already has.
 */
export function warningsIn(warnings: readonly string[], budget: Budget = BUDGET): string[] {
  const most = Math.max(1, budget.warnings)
  if (warnings.length <= most) return warnings.map(withoutPaths)
  const kept = warnings.slice(0, most - 1).map(withoutPaths)
  kept.push(`and ${warnings.length - (most - 1)} more things could not be read`)
  return kept
}

/**
 * At most `most` tasks from each project, chosen by name.
 *
 * The fairness half of the budget: without it one repository with ninety tasks
 * fills the page and three quiet ones are simply absent, which answers "is
 * anything waiting for me" wrongly and looks complete doing it.
 *
 * Chosen by name rather than by whether a task wants you, which looks like the
 * wrong way round and is not: a choosing order that moves when a state moves
 * makes the page cursor churn, and *that* something wants you is never hidden
 * by this cut — `ProjectRow.counts.wantsYou` is the true count over every task
 * in the project, cut or not.
 */
function fairly(tasks: readonly TaskIn[], most: number): TaskIn[] {
  const kept = new Map<string, number>()
  const out: TaskIn[] = []
  for (const task of [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const already = kept.get(task.project) ?? 0
    if (already >= most) continue
    kept.set(task.project, already + 1)
    out.push(task)
  }
  return out
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * One projection of everything this device may read, as of `now`.
 *
 * Every collection comes out sorted by its own stable id, which is what makes
 * a delta a shallow merge and nothing cleverer. Notes are *chosen* newest
 * first — cutting the newest note would be absurd — and then sorted by id like
 * everything else, because which rows are here and what order they arrive in
 * are two different questions.
 */
export function snapshotOf(
  input: SnapshotInput,
  now: number,
  cursors: Cursors = {},
  budget: Budget = BUDGET,
): Snapshot {
  const reach = input.reach
  const mine = <T extends { project: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => sees(reach, row.project))

  const projects = [...input.projects]
    .filter((project) => sees(reach, project.name))
    .sort((a, b) => byText(a.name, b.name))
  const tasks = mine(input.tasks)
  const queue = mine(input.queue)
  const findings = mine(input.findings)

  const projectPage = pageOf(projects, budget.projects, (row) => row.name, cursors.projects ?? null)
  const taskPage = pageOf(
    fairly(tasks, budget.tasksPerProject),
    budget.tasks,
    (row) => row.id,
    cursors.tasks ?? null,
  )
  const queuePage = pageOf(
    [...queue].sort((a, b) => byText(a.task, b.task)),
    budget.queue,
    (row) => row.task,
    cursors.queue ?? null,
  )
  const findingPage = has(reach, 'findings')
    ? pageOf(
        [...findings].sort((a, b) => byText(a.key, b.key)),
        budget.findings,
        (row) => row.key,
        cursors.findings ?? null,
      )
    : withheld<FindingIn>(findings.length)

  const allNotes = noteRows(input.notes, reach, budget)
  const notePage = has(reach, 'notes')
    ? pageOf(
        [...allNotes].sort((a, b) => byText(b.id, a.id)),
        budget.notes,
        (row) => row.id,
        cursors.notes ?? null,
      )
    : withheld<NoteRow>(allNotes.length)
  const planPage = has(reach, 'spend')
    ? pageOf(
        [...input.plans].sort((a, b) =>
          byText(`${a.harness}/${a.account ?? ''}`, `${b.harness}/${b.account ?? ''}`),
        ),
        budget.plans,
        (row) => `${row.harness}/${row.account ?? ''}`,
        cursors.plans ?? null,
      )
    : withheld<PlanStanding>(input.plans.length)

  const shownPerProject = new Map<string, number>()
  for (const task of taskPage.rows)
    shownPerProject.set(task.project, (shownPerProject.get(task.project) ?? 0) + 1)

  return {
    v: PROTOCOL_VERSION,
    fresh: freshnessOf(input, now, budget),
    you: { device: reach.device, reads: readsOf(reach) },
    pages: {
      projects: info(projectPage),
      // The fairness cut and the page cut are both cuts, so the count has to
      // be the real one: `taskPage.total` is what was left *after* the
      // per-project cut, and reporting that would under-report how many tasks
      // there are by exactly the number that were dropped for fairness.
      tasks: {
        ...info(taskPage),
        total: tasks.length,
        omitted: tasks.length - taskPage.rows.length,
      },
      queue: info(queuePage),
      findings: info(findingPage),
      notes: info(notePage),
      plans: info(planPage),
    },
    projects: projectPage.rows.map((project) =>
      projectRow(project, reach, budget, tasks, shownPerProject.get(project.name) ?? 0),
    ),
    tasks: taskPage.rows.map((task) => taskRow(task, reach, budget)),
    queue: queuePage.rows.map((item) => queueRow(item, reach, budget)),
    findings: findingPage.rows.map((found) => findingRow(found, budget)),
    notes: [...notePage.rows].sort((a, b) => byText(a.id, b.id)),
    plans: planPage.rows.map((plan) => planRow(plan, reach, budget)),
  }
}

function info<T>(from: Page<T>): Snapshot['pages']['tasks'] {
  return { total: from.total, omitted: from.omitted, next: from.next, restarted: from.restarted }
}

function projectRow(
  project: SnapshotInput['projects'][number],
  reach: Reach,
  budget: Budget,
  tasks: readonly TaskIn[],
  shown: number,
): ProjectRow {
  const mine = tasks.filter((task) => task.project === project.name)
  return {
    name: project.name,
    title: has(reach, 'titles') ? textOf(project.title, budget.text) : null,
    counts: {
      tasks: mine.length,
      shown,
      wantsYou: mine.filter((task) => wantsYou(task.state)).length,
      working: mine.filter((task) => task.state === 'working').length,
      queued: mine.filter((task) => task.state === 'queued').length,
    },
  }
}
