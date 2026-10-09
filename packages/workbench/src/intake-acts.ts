import { readFile } from 'node:fs/promises'
import {
  type Config,
  choicesFor,
  type DoneRule,
  type InboxAct,
  type InboxFact,
  type InboxMaterial,
  type InboxRow,
  type InboxWork,
  type IntakeItem,
  inboxOf,
  inboxProvenance,
  intakeFrom,
  materialUnread,
  OUTSIDE_IS_MATERIAL,
  type TadeEvent,
  type TaskState,
  troubleStarting,
  whyNotAct,
  workspaceFor,
} from '@tade/core'
import { readJournal } from './events.ts'
import { intakeGrant, intakeSourceOf } from './intake.ts'
import { readTaskFile, taskContextPath } from './tasks.ts'
import { budgetFrom, busyFrom, type TemplateDeps, type Unread } from './templates.ts'
import type { Workbench } from './workbench.ts'

// What a person at this machine does about a request that arrived from
// outside: read the inbox, open one, approve it, refuse it, try it again.
//
// **These are the local mutation doors, and there are only these four.** The
// window calls them, the CLI calls them, and a web adapter would call them —
// which is why they take a `Workbench` and a request rather than a terminal, a
// panel or an HTTP body. Nothing here is reachable from off this machine
// today: no route, no handler, no port. That is the seam research.md asks for
// and the reservation DECISIONS.md allows, and it is a seam rather than a
// surface precisely because *configuring intake is never remote* — a phone may
// one day approve what a local grant already allowed; it may not create the
// grant.
//
// **Reading never needs the window.** `inboxFrom` takes a home and a journal,
// so `tade intake` answers from the files while a window is open — the
// existing rule that questions never need the workbench. Acting does need it,
// because acting writes, and `withWorkbench` is what says so.
//
// **Every act is refused by the same sentence the surface drew.** `whyNotAct`
// is core's, read here and read by whoever drew the button, so a button that
// offers what the door refuses cannot happen.

/** What reading the inbox needs: a home for the task files, and the journal. */
export interface InboxRead {
  home: string
  events: readonly TadeEvent[]
  /**
   * Each task's state where the caller could ask for one — only a window can,
   * because `deriveState` needs probes. Absent is `null` on the row, which is
   * a first-class answer and is drawn as one.
   */
  states?: ReadonlyMap<string, TaskState>
  /** Only this project's, where a surface is standing in one. */
  project?: string
}

/**
 * The inbox, newest first.
 *
 * The journal says what arrived and what the rule decided; the task files say
 * what became of the work. Both are read here and folded by core, so the CLI's
 * answer and the window's are the same rows derived the same way — which is
 * the thing that stops two surfaces disagreeing about whether somebody is
 * waiting on you.
 */
export async function inboxFrom(req: InboxRead): Promise<InboxRow[]> {
  const items = intakeFrom(req.events)
  const work = await workOf(req, items)
  return inboxOf(items, work, req.project ? { project: req.project } : undefined)
}

/** One row, or null where nothing by that item key has ever arrived. */
export async function inboxItem(req: InboxRead & { item: string }): Promise<InboxRow | null> {
  const rows = await inboxFrom({ ...req, project: undefined })
  return rows.find((row) => row.item === req.item || row.externalId === req.item) ?? null
}

/** What became of every task every delivery made. */
async function workOf(
  req: InboxRead,
  items: ReadonlyMap<string, IntakeItem>,
): Promise<InboxWork[]> {
  const names = new Set<string>()
  for (const one of items.values()) for (const task of one.tasks) names.add(task)
  const started = new Set<string>()
  const finished = new Set<string>()
  for (const event of req.events) {
    if (!event.task || !names.has(event.task)) continue
    if (event.type === 'run_started') started.add(event.task)
    if (event.type === 'task_done') finished.add(event.task)
  }
  const work: InboxWork[] = []
  for (const task of names) {
    const file = await readTaskFile(req.home, task).catch(() => null)
    // A task whose file is gone is not a task: it is left out, and the row says
    // the work it made is not there any more rather than drawing a proposal
    // nobody could ever approve.
    if (!file) continue
    work.push({
      task,
      parked: file.parked === true,
      started: started.has(task),
      finished: finished.has(task),
      // The queue's own sentence, read through the queue's own rule: a second
      // reading of `queue_held` would be a second answer to one question.
      held: troubleStarting(task, req.events, choicesFor(task, req.events).answeredAt),
      state: req.states?.get(task) ?? null,
    })
  }
  return work
}

/** One request opened: where it came from, and the request itself, labelled. */
export interface InboxOpen {
  row: InboxRow
  /** The safe provenance: facts about where it came from, and nothing it said. */
  facts: readonly InboxFact[]
  material: InboxMaterial
}

/**
 * One request in full, for the surface that opened a row.
 *
 * **Two answers, kept apart on purpose.** `facts` is provenance — this
 * machine's own record of what arrived and what allowed it — and `material` is
 * somebody else's words, with the heading that says so attached to it rather
 * than chosen by whoever draws it. A surface that merged the two would be one
 * layout change away from drawing a stranger's sentences as Tade's.
 *
 * **The body is read out of the context file Tade wrote and nowhere else.**
 * Tade keeps no second copy, and it never goes back to the source's own
 * reference for one: that would be Tade reading a path out of a journal line
 * that came from outside. A delivery that made no task therefore has no body
 * to show, and that is said (`problem`) rather than drawn as an empty request.
 */
export async function openIntakeRow(req: InboxRead & { item: string }): Promise<InboxOpen | null> {
  const row = await inboxItem(req)
  if (!row) return null
  return { row, facts: inboxProvenance(row), material: await materialOf(req.home, row) }
}

/** The request itself, as Tade wrote it down, or why there is nothing to read. */
export async function materialOf(home: string, row: InboxRow): Promise<InboxMaterial> {
  const task = row.tasks[0]
  if (!task) {
    return materialUnread(
      row,
      `nothing was made for ${row.externalId}, and Tade keeps no copy of a request outside the context file it writes: it is at ${row.ref || 'its source'}`,
    )
  }
  const where = taskContextPath(home, task)
  try {
    return {
      ref: row.ref,
      hash: row.hash,
      where,
      heading: OUTSIDE_IS_MATERIAL,
      body: await readFile(where, 'utf8'),
      problem: null,
    }
  } catch (err) {
    return materialUnread(
      row,
      `${where} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** What one act came to. */
export interface IntakeActed {
  row: InboxRow
  /** Tade's own sentence about what was done. Never a word of the request. */
  said: string
  /** Every task it changed. */
  tasks: readonly string[]
}

/** The one place an act's refusal is turned into a throw, with core's own sentence. */
async function rowFor(tade: Workbench, item: string, act: InboxAct): Promise<InboxRow> {
  const row = await inboxItem({ home: tade.home, events: await tade.log.read({}), item })
  if (!row) throw new Error(`nothing called ${item} has been handed to this machine`)
  const off = whyNotAct(row, act)
  if (off) throw new Error(off)
  return row
}

/**
 * Approve a proposal: the park a person's approval lifts, lifted.
 *
 * **Approving is not undoable and this does not pretend it is.** What it does
 * is take the hold off work that already exists — the task, its context file
 * and its branch were made when the request was accepted — so the queue starts
 * it by rule. `start` additionally writes the person's own "start this" for
 * the pieces that wait on nothing; everything behind one of those is the
 * queue's to start when what it waits on finishes.
 *
 * **The grant is read again here.** Not as a second authorisation — the start
 * asks the source and the grant again through `intakeStands`, which is the
 * moment that matters — but because approving under a grant somebody has since
 * turned off should say so at the press rather than hold silently a second
 * later.
 */
export async function approveIntake(
  tade: Workbench,
  req: {
    item: string
    start?: boolean
    by: 'you'
    /**
     * The config as it stands *now*, where the caller has a fresher answer
     * than the workbench does.
     *
     * The window does: a setting changed while it has been open is in its own
     * config and not in the one the workbench was opened with, and a grant is
     * permission at the moment of acting. The CLI does not — its workbench
     * opened a moment ago — so it passes nothing and this reads the
     * workbench's own.
     */
    config?: Config
  },
): Promise<IntakeActed> {
  const row = await rowFor(tade, req.item, req.start ? 'start' : 'approve')
  const source = intakeSourceOf(row.source)
  if (source) {
    const grant = intakeGrant(req.config ?? tade.config, source)
    if (!grant.on) throw new Error('surfaces.intake.enabled is off: nothing would start')
    if (!grant.accept) throw new Error(`${grant.path}.accept is off: nothing would start`)
    if (!grant.projects.includes(row.project)) {
      throw new Error(`${grant.path}.projects no longer lists ${row.project}: nothing would start`)
    }
  }
  const parked = row.work.filter((one) => one.parked).map((one) => one.task)
  for (const task of parked) await tade.parkTask(task, false)
  const now: string[] = []
  if (req.start) {
    for (const task of parked) {
      const file = await readTaskFile(tade.home, task).catch(() => null)
      if ((file?.start?.after ?? []).length > 0) continue
      await tade.changeQueued({ task, change: 'start', by: req.by })
      now.push(task)
    }
  }
  const started = now.length > 0 ? `; ${now.join(', ')} starts now` : ''
  return {
    row,
    tasks: parked,
    said: `${row.externalId} is approved: ${parked.join(', ')} ${parked.length === 1 ? 'is' : 'are'} queued${started}`,
  }
}

/**
 * Refuse a request: written down, nothing posted, and no agent stopped.
 *
 * **A refusal is a record and never a message.** It goes in the journal as
 * `by_hand` beside the four the rule writes, and nothing goes back to the
 * source — the same argument the rule's own refusals make, because a reply
 * tells whoever sent it that the machine is there and listening.
 *
 * **What has not started is parked; what is working is left alone and said
 * so.** Nothing outside this machine stops an agent, and neither does this: a
 * person who wants the agent stopped stops the agent, which is a different act
 * with a different button.
 */
export async function refuseIntake(
  tade: Workbench,
  req: { item: string; why?: string; by: 'you' },
): Promise<IntakeActed> {
  const row = await rowFor(tade, req.item, 'refuse')
  const because = (req.why ?? '').trim() || 'a person at this machine refused it'
  const running = new Set(tade.runs().map((run) => run.task))
  const parked: string[] = []
  const working: string[] = []
  for (const one of row.work) {
    if (running.has(one.task)) {
      working.push(one.task)
      continue
    }
    await tade.parkTask(one.task, true)
    await tade.holdQueued(one.task, because, { start: 'failed' })
    parked.push(one.task)
  }
  await tade.log.append({
    type: 'intake_refused',
    task: row.tasks[0] ?? null,
    detail: {
      item: row.item,
      source: row.source,
      external_id: row.externalId,
      revision: row.revision,
      requester: row.requester,
      project: row.project,
      grant: row.grant,
      hash: row.hash,
      ref: row.ref,
      watch: row.watch,
      schedule: row.schedule,
      why: 'by_hand',
      by: req.by,
      because,
      problem: because,
    },
  })
  const said = [
    `${row.externalId} is refused: ${because}`,
    ...(parked.length > 0 ? [`${parked.join(', ')} is parked and held`] : []),
    ...(working.length > 0
      ? [
          `${working.join(', ')} is already working and was not stopped: stopping an agent is its own act`,
        ]
      : []),
    'nothing was posted anywhere',
  ]
  return { row, tasks: [...parked], said: said.join('; ') }
}

/**
 * Try a delivery that failed again, now, because a person asked.
 *
 * **A person's retry is not bounded by the machine's three tries.** Tade stops
 * on its own after `INTAKE_ATTEMPTS` so a failing source is not hammered for
 * ever; a person pressing this has read why it failed and is answering it, and
 * refusing them because a counter is at three would strand the request Tade
 * was told not to lose.
 *
 * **It goes through the one delivery door and makes no second copy.**
 * `again` is handed in by whoever can reach the source — only a window runs
 * the extensions — and what it does is ask that source for this request and
 * put it through `takeIntake`, which recognises the work a failed attempt
 * already made (`whoseAlready`) rather than making another. Without one this
 * refuses and says why: a request can only be tried again by asking the thing
 * that sent it.
 */
export async function retryIntake(
  tade: Workbench,
  req: {
    item: string
    by: 'you'
    /** Ask the source for this one again and take it in. Tade's own sentence back. */
    again?: (row: InboxRow) => Promise<string>
  },
): Promise<IntakeActed> {
  const row = await rowFor(tade, req.item, 'retry')
  if (!req.again) {
    throw new Error(
      `trying ${row.externalId} again means asking ${row.source} for it again, and only an open window runs the watch that can: ask it there`,
    )
  }
  const said = await req.again(row)
  return { row, tasks: row.tasks, said }
}

/** The whole inbox for a surface that has a workbench open, with the journal read once. */
export async function inboxOfHome(
  home: string,
  only?: { project?: string; limit?: number },
): Promise<InboxRow[]> {
  const events = await readJournal(home, only?.limit ? { limit: only.limit } : {})
  return inboxFrom({ home, events, ...(only?.project ? { project: only.project } : {}) })
}

// --- what approving one would start, before anybody approves it

/** One task a proposal would start, as its own file says it. */
export interface WouldStart {
  task: string
  project: string
  workspace: 'checkout' | 'worktree'
  done: DoneRule
  produces: string | null
  touches: readonly string[]
  after: readonly { task: string; why: string }[]
  /** Still parked: what approving lifts. False where it is already picked up. */
  parked: boolean
}

/**
 * What approving one request would start, and it starts none of it.
 *
 * **It describes the work that exists rather than simulating work that does
 * not.** A proposal's tasks were made when the request was accepted — parked,
 * with their context files and their waits already written down — so the
 * honest answer to "what happens if I press approve" is *those* tasks read
 * back off their own files, not a second fill of the template that would have
 * to guess at the body again. A template dry run is the other question (what
 * would this template make) and `tade templates dry-run` is where it is asked.
 *
 * Three things are said beside the rows, each from the thing that already
 * answers it: what the grant says **now**, because a grant is permission at
 * the moment of acting; what work already going on touches the same files
 * (`busyFrom`, the same read a template dry run warns from); and what the
 * projects have spent today (`budgetFrom`). What nothing here can read is said
 * rather than drawn as room — a plan window is only readable by the process
 * supervising the agents.
 */
export interface IntakeWouldRun {
  row: InboxRow
  starts: readonly WouldStart[]
  /** What the grant says now, and what this grants, which is nothing. */
  grant: readonly string[]
  /** What bounds it, and what could not be read — never as nought. */
  limits: readonly string[]
  /** Why nothing would start. */
  problems: readonly string[]
  warnings: readonly string[]
}

export async function intakeWouldRun(
  deps: TemplateDeps,
  row: InboxRow,
  /** Where each sign-in stands against its plan. Null, honestly, when nothing could read it. */
  plans: readonly string[] | null = null,
): Promise<IntakeWouldRun> {
  const problems: string[] = []
  const off = whyNotAct(row, 'approve')
  if (off) problems.push(off)
  const starts: WouldStart[] = []
  for (const task of row.tasks) {
    const file = await readTaskFile(deps.home, task).catch(() => null)
    if (!file) {
      problems.push(`${task} was made for it and its task file is not there now`)
      continue
    }
    starts.push({
      task,
      project: file.project,
      workspace: file.workspace ?? workspaceFor(deps.config, file.project),
      done: file.done ?? 'said',
      produces: file.produces ?? null,
      touches: file.start?.touches ?? [],
      after: file.start?.after ?? [],
      parked: file.parked === true,
    })
  }
  const missed: string[] = []
  const unread: Unread = (said) => {
    if (!missed.includes(said)) missed.push(said)
  }
  const warnings: string[] = []
  const busy = await busyFrom(deps, [row.project], unread)
  for (const start of starts) {
    for (const other of busy) {
      if (other.task === start.task) continue
      const shared = start.touches.filter((path) => other.touches.includes(path))
      if (shared.length > 0) {
        warnings.push(
          `${start.task} and ${other.task}, which is ${other.said}, both change ${shared.join(', ')}: merging both may conflict`,
        )
      }
    }
  }
  const budget = await budgetFrom(deps, [row.project], unread)
  const limits = [
    ...budget.map((one) => `${one.project}: ${one.said}`),
    ...(plans === null
      ? [
          'Plan windows: cannot tell from here — only the window supervising the agents can read one, and unknown is not room.',
        ]
      : plans.length === 0
        ? ['Plan windows: none — every sign-in here is billed rather than on a plan.']
        : plans.map((one) => `Plan window: ${one}`)),
    ...missed,
  ]
  return {
    row,
    starts,
    grant: grantSays(row),
    limits,
    problems,
    warnings,
  }
}

/** What allowed this, and what it did not grant, in sentences rather than a tier. */
function grantSays(row: InboxRow): string[] {
  return [
    `Allowed by ${row.grant || 'nothing: it was refused'}${row.mode ? `, at ${row.mode}` : ''}.`,
    row.template
      ? `Stamped from ${row.template.name}@${row.template.version}, which was resolved when it was accepted and cannot change now.`
      : 'No template: one ordinary task.',
    'It grants nothing. The request is material in a context file, nothing in it can change a setting, and the grant is asked again — with the source — at the moment anything starts.',
  ]
}

/** What approving one would start, as lines to read. */
export function wouldRunSays(would: IntakeWouldRun): string[] {
  const row = would.row
  const lines = [
    `${row.source} ${row.externalId} → ${row.template ? `${row.template.name}@${row.template.version}` : 'one task'} in ${row.project}`,
    '',
  ]
  if (would.problems.length > 0) {
    lines.push('Nothing would start:')
    for (const problem of would.problems) lines.push(`  ${problem}`)
    lines.push('', 'Nothing was started.')
    return lines
  }
  const width = Math.max(0, ...would.starts.map((one) => one.task.length))
  for (const start of would.starts) {
    const bits = [
      start.workspace,
      `done: ${start.done}`,
      ...(start.produces ? [`produces ${start.produces}`] : []),
      ...(start.touches.length > 0 ? [`touches ${start.touches.join(', ')}`] : []),
      ...(start.parked ? [] : ['already picked up']),
    ]
    lines.push(`  ${start.task.padEnd(width)}  ${bits.join('  ')}`)
    for (const dep of start.after) {
      lines.push(`  ${' '.repeat(width)}  after ${dep.task} — ${dep.why}`)
    }
  }
  for (const warning of would.warnings) lines.push('', `  warning  ${warning}`)
  lines.push('', 'What this grants:')
  for (const one of would.grant) lines.push(`  ${one}`)
  lines.push('', 'What bounds it:')
  for (const one of would.limits) lines.push(`  ${one}`)
  lines.push('', 'Nothing was started.')
  return lines
}
