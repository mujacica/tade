import type { PlanStanding, Spend } from '@tade/core'
import { projectRev, taskRev } from './acting.ts'
import { commandShown } from './command.ts'
import { callFor } from './conversation.ts'
import { intakeRow, runRow, sourceRow, type WorkflowIn, workflowRow } from './factory.ts'
import { withoutPaths } from './fields.ts'
import {
  type ChatIn,
  type CheckRunIn,
  type CheckTreeIn,
  type FindingIn,
  factsOf,
  type NoteIn,
  projectFactsOf,
  type QueueIn,
  type QueueStateIn,
  type ReasonIn,
  type SnapshotInput,
  type TalkIn,
  type TaskIn,
} from './input.ts'
import { BUDGET, type Budget, type Page, pageOf, textOf, withheld } from './page.ts'
import type {
  ChatPage,
  ChatRow,
  CheckRunOut,
  CheckTrackOut,
  CheckTreeOut,
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
// window's own pure files keep, and for the same reason: a function of its arguments can be tested exhaustively, and a
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

/**
 * Whether a task is waiting on a decision of yours: the window's own mark
 * (`markOf`), carried on the row, so the count on a phone is the count on the
 * screen at the machine — an approval waiting, a turn that ended on something
 * to decide, or an agent that failed, and never one idle at its prompt or one
 * the journal says is finished.
 */
export function wantsYou(task: Pick<TaskIn, 'mark'>): boolean {
  return task.mark === 'needs-you'
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
    mark: task.mark,
    reason: reasonOf(task.reason),
    stalled: task.stalled,
    parked: task.parked,
    // **The row's own revision, built from the same rule the window builds it
    // from at the moment of a write.** Every fact in it is one some verb
    // assumes, so a screen is refused exactly when what it was looking at has
    // moved and not when some figure did.
    rev: taskRev(factsOf(task)),
    wantsYou: wantsYou(task),
    question: task.question,
    approval:
      task.approval === null
        ? null
        : {
            id: task.approval.id,
            tool: task.approval.tool,
            since: ISO(task.approval.sinceAt),
            // Only to a device that may answer it (`ANSWERING`): seeing what you
            // say yes to goes with saying it, and with nothing else.
            command:
              reach.answers === true && task.approval.command !== null
                ? commandShown(task.approval.command, budget.material)
                : null,
          },
    finished: task.finished,
    // Carried as the window worked them out: whether a thing is possible is a
    // question about a harness and a lane, which only the window can answer.
    can: task.can.map((one) => ({ verb: one.verb, how: one.how })),
    cannot: task.cannot.map((one) => ({ verb: one.verb, why: one.why })),
    lane: task.lane,
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
    servers: [...(task.servers ?? [])],
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

/**
 * The conversation's lines, as this device may read them.
 *
 * Three things happen here and nowhere else, and each is the reason this is a
 * function rather than a `map` in `snapshotOf`:
 *
 * 1. **Every line is run through `withoutPaths`, a person's own included.**
 *    This is the one collection whose text is not held to the authored rule,
 *    and the reason is what a conversation *is*: a model quotes what its tools
 *    answered — `tade status`'s own JSON, a file it read, an error with a path
 *    in it — and a person types paths at it all day. Leaving it verbatim would
 *    make the projection's claim (*the away view adds no path of its own*)
 *    false for the largest string on the page, and leaving only replies
 *    scrubbed would make the claim depend on which half a reader happened to
 *    look at. So it is kept at the boundary that makes it, as it is for
 *    `fresh.warnings` — the other string here this package did not write.
 *
 *    What that costs, said rather than implied: a path somebody typed into a
 *    message reads as `…` on the phone. It is the one place the away view does
 *    not show what was said as it was said, and `GRANT_MEANS.talk` is where a
 *    person is told so before granting it.
 * 2. **A tool line carries a name and an outcome**, and its call — what it
 *    was handed and what it answered — only where `withCalls` puts it: under
 *    `lanes`, cleaned. Never by the names `NEVER_A_FIELD` keeps for the raw
 *    thing (`args`, `payload`, `output`).
 * 3. **The newest lines win.** A conversation is read from the bottom, so the
 *    budget takes the *last* `budget.chat` lines rather than the first, and
 *    the count says how many were left behind.
 * 4. **What was said is the thing the screen is for**, so every line crosses
 *    whole — a person's words, the model's, and Tade's own: a reply cut at any
 *    length is a table with no end and a code block that never closes, and a
 *    line saying there was more is no use to somebody who wanted to read it.
 */
export function chatRows(lines: readonly ChatIn[]): ChatRow[] {
  return lines.map((line) => ({
    id: line.id,
    at: ISO(line.at),
    kind: line.kind,
    from: SOME(line.from),
    text: line.text === '' ? null : { words: withoutPaths(line.text), more: false },
    tool: SOME(line.tool),
    outcome: line.outcome === '' ? null : line.outcome,
    call: null,
    streaming: line.streaming,
    ask: line.ask === undefined || line.ask === '' ? null : withoutPaths(line.ask),
  }))
}

/**
 * The lines said before `before`, as `GET /api/chat` answers them: the newest
 * `budget.chat` of them, oldest first, each as the snapshot would carry it.
 *
 * `before` is a line's id and is only ever **compared**, never looked up:
 * an id sorts in the order things were said (`chatLines`), so a page asks for
 * what came before the oldest line it holds whether or not that line is still
 * held here — nothing is skipped and nothing starts over.
 */
export function chatBefore(
  talk: TalkIn | null,
  reach: Reach,
  before: string,
  budget: Budget = BUDGET,
): ChatPage {
  if (talk === null) return { v: PROTOCOL_VERSION, rows: [], earlier: false, why: 'off' }
  if (!has(reach, 'talk')) {
    return { v: PROTOCOL_VERSION, rows: [], earlier: false, why: 'not granted' }
  }
  const older = chatRows(talk.lines.filter((line) => line.id < before)).sort((a, b) =>
    byText(a.id, b.id),
  )
  const rows = older.slice(-budget.chat)
  return {
    v: PROTOCOL_VERSION,
    rows: withCalls(rows, talk, has(reach, 'lanes')),
    earlier: older.length > rows.length || talk.earlier === true,
    why: null,
  }
}

/**
 * The lines a device is sent, each tool line given its call where the device
 * was granted an agent's own bytes (`lanes`) — and only the lines on its page,
 * because cleaning is the work and a page is what crosses.
 */
export function withCalls(
  rows: readonly ChatRow[],
  talk: TalkIn | null,
  granted: boolean,
): ChatRow[] {
  if (!granted || talk === null) return [...rows]
  const held = new Map(talk.lines.map((line) => [line.id, line]))
  return rows.map((row) => {
    const line = held.get(row.id)
    if (line?.call === null || line?.call === undefined) return row
    return {
      ...row,
      call: callFor(
        row.id,
        line.call.input,
        line.call.result,
        talk.known,
        talk.places,
        line.call.id ?? null,
      ),
    }
  })
}

/** A sign-in's plan beside the id its row is keyed by (`plansKeyed`). */
interface KeyedPlan {
  plan: PlanStanding
  id: string
}

/**
 * Every sign-in's plan with its row's id, in the order the page walks them.
 *
 * **Its harness and its place among that harness's sign-ins, never the
 * account's name.** The id rides on the row every `spend` device is sent, and
 * the page's cursor is made of it, so one spelt `<harness>/<account>` handed
 * the name over to a phone that was refused `accounts`, beside an `account` of
 * null. The place is in name order, the harness's own sign-in first, and says
 * nothing the rows do not: how many there are, and the order they arrive in.
 *
 * Positional, which `KEYED` warns against, and the price is paid only when a
 * harness gains or loses a sign-in: every row after it is a changed row on
 * the next delta. Padded, and then sorted by it, so that the order the ids
 * sort in — which is what a client's merge sorts by — is the order chosen here.
 */
function plansKeyed(plans: readonly PlanStanding[]): KeyedPlan[] {
  const named = (plan: PlanStanding) => `${plan.harness}/${plan.account ?? ''}`
  const sorted = [...plans].sort((a, b) => byText(named(a), named(b)))
  const many = new Map<string, number>()
  for (const plan of sorted) many.set(plan.harness, (many.get(plan.harness) ?? 0) + 1)
  const placed = new Map<string, number>()
  return sorted
    .map((plan) => {
      const at = placed.get(plan.harness) ?? 0
      placed.set(plan.harness, at + 1)
      const width = String((many.get(plan.harness) ?? 1) - 1).length
      return { plan, id: `${plan.harness}/${String(at).padStart(width, '0')}` }
    })
    .sort((a, b) => byText(a.id, b.id))
}

function planRow({ plan, id }: KeyedPlan, reach: Reach, budget: Budget): PlanRow {
  return {
    id,
    harness: plan.harness,
    // The own sign-in by the name somebody gave it, so its card says it: the
    // row's id is still its place, never the name (`plansKeyed`).
    account: has(reach, 'accounts')
      ? textOf(plan.account ?? plan.ownName ?? null, budget.text)
      : null,
    pays: plan.pays,
    windows: plan.windows.map((window) => ({
      label: window.label,
      used: window.used,
      resetsAt: window.resetsAt === 0 ? null : ISO(window.resetsAt),
    })),
    at: ISO_OR(plan.at),
    cannotTell: plan.cannotTell,
    uses: has(reach, 'accounts') ? usesOf(plan.uses, reach, budget) : null,
  }
}

/**
 * Who runs as a sign-in, as one device may read it: a project it may not read
 * is not named, and is not counted either — a count is still a fact about
 * work it cannot see. What is left over the projects' own budget is counted.
 */
function usesOf(uses: PlanStanding['uses'], reach: Reach, budget: Budget): PlanRow['uses'] {
  if (uses === undefined) return null
  const seen = uses.projects.filter((project) => sees(reach, project))
  const projects = seen.slice(0, budget.projects)
  return { newAgents: uses.newAgents, projects, notShown: seen.length - projects.length }
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
  const findings = mine(input.findings ?? [])

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
  // Findings are *chosen* unanswered first — no verdict yet, whoever's move it
  // is — and then by key, so a cut list still holds every one the badge counts
  // before it holds any that is settled; then sorted by key like everything
  // else (below).
  const findingPage = has(reach, 'findings')
    ? pageOf(
        [...findings].sort(
          (a, b) => Number(a.verdict !== null) - Number(b.verdict !== null) || byText(a.key, b.key),
        ),
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
  // **The factory floor.** Every one of the four is narrowed to the projects
  // this device may read first, exactly as the tasks are — a request filed
  // against a project a phone cannot see is not a request that phone is told
  // about, counted or otherwise. The exceptions are the doors, which are not
  // per project and whose own project lists are narrowed inside the row
  // (`sourceRow`), and the workflows, which are stored in Tade's home and
  // belong to no project: what narrows those is the `workflows` grant.
  const intake = mine(input.intake)
  const runs = input.runs.filter((run) => run.steps.some((step) => sees(reach, step.project)))
  const intakePage = pageOf(
    [...intake].sort((a, b) => b.at - a.at),
    budget.intake,
    (row) => row.item,
    cursors.intake ?? null,
  )
  const sourcePage = pageOf(
    [...input.sources].sort((a, b) => byText(a.source, b.source)),
    budget.sources,
    (row) => row.source,
    cursors.sources ?? null,
  )
  const runPage = pageOf(
    [...runs].sort((a, b) => byText(a.run, b.run)),
    budget.runs,
    (row) => row.run,
    cursors.runs ?? null,
  )
  // **Withheld rather than empty where the grant is off**, which is the shape
  // every other grant has: a phone is told *there are three workflows and you
  // may not read them from here*, never *there are no workflows* — and the
  // second of those is what a reader would conclude from an empty list.
  const workflowPage = has(reach, 'workflows')
    ? pageOf(
        [...input.workflows].sort((a, b) => byText(a.name, b.name)),
        budget.workflows,
        (row) => row.name,
        cursors.workflows ?? null,
      )
    : withheld<WorkflowIn>(input.workflows.length)
  const planPage = has(reach, 'spend')
    ? pageOf(plansKeyed(input.plans), budget.plans, (row) => row.id, cursors.plans ?? null)
    : withheld<KeyedPlan>(input.plans.length)

  // **The last lines rather than the first**, because a conversation is read
  // from the bottom: what a phone opening the screen needs is the exchange
  // that just happened. The cursor pages *backwards* through what is left, so
  // `after` names the oldest line this page carried.
  const allChat = input.talk === null ? [] : chatRows(input.talk.lines)
  const chatPage = has(reach, 'talk')
    ? pageOf([...allChat].reverse(), budget.chat, (row) => row.id, cursors.chat ?? null)
    : withheld<ChatRow>(allChat.length)

  const shownPerProject = new Map<string, number>()
  for (const task of taskPage.rows)
    shownPerProject.set(task.project, (shownPerProject.get(task.project) ?? 0) + 1)

  return {
    v: PROTOCOL_VERSION,
    fresh: freshnessOf(input, now, budget),
    you: {
      device: reach.device,
      reads: readsOf(reach),
      talk:
        input.talk === null
          ? null
          : {
              rev: input.talk.rev,
              busy: input.talk.busy,
              whose: SOME(input.talk.whose),
              since: input.talk.busy ? ISO_OR(input.talk.since ?? null) : null,
              mine: input.talk.mine,
              earlier: input.talk.earlier === true,
            },
    },
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
      chat: info(chatPage),
      intake: info(intakePage),
      sources: info(sourcePage),
      runs: info(runPage),
      workflows: info(workflowPage),
    },
    projects: projectPage.rows.map((project) =>
      projectRow(
        project,
        reach,
        budget,
        tasks,
        shownPerProject.get(project.name) ?? 0,
        input.checks,
      ),
    ),
    tasks: taskPage.rows.map((task) => taskRow(task, reach, budget)),
    queue: queuePage.rows.map((item) => queueRow(item, reach, budget)),
    findings: [...findingPage.rows]
      .sort((a, b) => byText(a.key, b.key))
      .map((found) => findingRow(found, budget)),
    notes: [...notePage.rows].sort((a, b) => byText(a.id, b.id)),
    plans: planPage.rows.map((one) => planRow(one, reach, budget)),
    // Back into the order they were said in: the budget chose from the end,
    // and a page that drew them backwards would be a second ordering of the
    // one thing whose order is its meaning.
    chat: withCalls(chatPage.rows, input.talk, has(reach, 'lanes')).sort((a, b) =>
      byText(a.id, b.id),
    ),
    // Back into id order for the wire, like every other collection: the
    // *choosing* order is newest-first, because cutting the newest request
    // would be absurd, and the order rows arrive in is what makes a delta a
    // shallow merge keyed by an id and nothing cleverer.
    intake: intakePage.rows
      .map((one) => intakeRow(one, reach, budget))
      .sort((a, b) => byText(a.item, b.item)),
    sources: sourcePage.rows.map((one) => sourceRow(one, reach)),
    runs: runPage.rows.map((one) => runRow(one, reach, budget)),
    workflows: workflowPage.rows.map((one) => workflowRow(one, reach, budget)),
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
  trees: SnapshotInput['checks'],
): ProjectRow {
  const mine = tasks.filter((task) => task.project === project.name)
  return {
    name: project.name,
    title: has(reach, 'titles') ? textOf(project.title, budget.text) : null,
    open: project.open,
    // The same rule the window builds it by at the act, out of the same row.
    rev: projectRev(projectFactsOf(project)),
    can: project.can.map((one) => ({ verb: one.verb, how: one.how })),
    cannot: project.cannot.map((one) => ({ verb: one.verb, why: one.why })),
    counts: {
      tasks: mine.length,
      shown,
      wantsYou: mine.filter((task) => wantsYou(task)).length,
      // Running, as the window counts it: an agent mid-turn and not gone quiet.
      working: mine.filter((task) => task.state === 'working' && !task.stalled).length,
      queued: mine.filter((task) => task.state === 'queued').length,
    },
    checks: project.open ? checkTreesOf(trees, project.name, reach) : null,
    watching: [...project.watching],
  }
}

/**
 * A project's trees of runs: its checkout first, then each worktree that has
 * any. Null where the checkout was not read — *not looked yet*, never *nothing
 * ran*, because the window hands every checkout over whenever it reads one.
 */
export function checkTreesOf(
  trees: readonly CheckTreeIn[] | null,
  project: string,
  reach: Reach,
): CheckTreeOut[] | null {
  const mine = (trees ?? []).filter((tree) => tree.project === project)
  if (!mine.some((tree) => tree.task === null)) return null
  return mine
    .map((tree) => ({ task: tree.task, checks: tracksOf(tree.runs, reach) }))
    .filter((tree) => tree.task === null || tree.checks.length > 0)
    .sort((a, b) => (a.task === null ? -1 : b.task === null ? 1 : byText(a.task, b.task)))
}

/** `passed` and `failed` say something; `timed out` is a fail; the rest say nothing either way. */
function answerOf(state: string): CheckRunOut['state'] {
  if (state === 'passed') return 'pass'
  return state === 'failed' || state === 'timed out' ? 'fail' : 'other'
}

/**
 * Every check in one record, in the order it first ran, with **every run the
 * record keeps**, oldest first — the strip scrolls sideways when it is long,
 * and nothing is counted as left out. A run that wrote no time keeps its place
 * with `at: null`; the streak is over the runs that say when.
 */
export function tracksOf(runs: readonly CheckRunIn[], reach: Reach): CheckTrackOut[] {
  const byCheck = new Map<string, CheckRunIn[]>()
  for (const run of runs) {
    const list = byCheck.get(run.check)
    if (list) list.push(run)
    else byCheck.set(run.check, [run])
  }
  return [...byCheck].map(([check, all]) => ({
    check,
    required: all[all.length - 1]?.required ?? false,
    runs: all.map((run) => ({
      at: run.at === null ? null : ISO(run.at),
      state: answerOf(run.state),
      ms: run.ms === null ? null : Math.max(0, Math.round(run.ms)),
    })),
    by: byOf(all[all.length - 1]?.by ?? null, reach),
    streak: streakOf(all.filter((run) => run.at !== null)),
  }))
}

/** Who asked, unless it is a task in a project this device may not read: a task's id is `<project>/<name>`. */
function byOf(by: string | null, reach: Reach): string | null {
  if (by === null || by === '') return null
  return !by.includes('/') || sees(reach, by.split('/')[0] ?? '') ? by : null
}

/**
 * The newest answer that said anything and the first run of the row that said
 * it, over every run kept — so *red since* is when it went red, not when the
 * oldest run on the strip happens to be.
 */
function streakOf(runs: readonly CheckRunIn[]): CheckTrackOut['streak'] {
  let state: 'pass' | 'fail' | null = null
  let since = 0
  let count = 0
  let at = runs.length - 1
  for (; at >= 0; at -= 1) {
    const said = answerOf(runs[at]?.state ?? '')
    if (said === 'other') continue
    if (state !== null && said !== state) break
    state = said
    count += 1
    since = runs[at]?.at ?? since
  }
  if (state === null) return null
  return { state, since: ISO(since), runs: count, atLeast: at < 0 }
}
