import type {
  InboxRow,
  InboxState,
  SourceStanding,
  TaskState,
  Template,
  WorkflowField,
  WorkflowPlace,
} from '@tade/core'
import { workflowFields, workflowPlaces } from '@tade/core'
import type {
  IntakeIn,
  Locally,
  RunIn,
  RunStepIn,
  SourceIn,
  WorkflowFieldIn,
  WorkflowIn,
  WouldIn,
} from '@tade/web'

// What the away view is handed about the factory floor, built out of what the
// window already holds.
//
// **Pure, like `away.ts`, and for the same reason**: the one place that
// decides what leaves the machine should be a function of its arguments. The
// bodies, the folds and the moment are all passed in; nothing here reads a
// file, a clock or the journal.
//
// **Nothing is spread.** `InboxRow` is already a path-free projection in the
// domain — the comment at the head of `intake-inbox.ts` says the body is in no
// type there — and it is *still* mapped field by field, because the next field
// somebody adds to it would otherwise arrive on a phone with nobody having
// decided it. That is the rule `away.ts` keeps for `Task` and the reason is
// not weaker here: an intake row carries a stranger's words, which is the one
// kind of value the projection has two grants for.

/**
 * The acts an inbox row offers that stay at this machine.
 *
 * **One clause each, and the list is a constant rather than a sentence.** The
 * obligation is to say when a design needs somebody at the keyboard without
 * turning the page into an essay, and the shape that does both is the one
 * `TaskRow.cannot` already has: the act, and one line. The whole argument is
 * said once, where somebody is deciding — `LOCAL_ONLY_ACTS`, on the control
 * in Settings.
 *
 * Three, and each for a different reason: one starts agents now, one answers
 * a person outside this machine, and one reaches a service with the owner's
 * credential.
 */
export const INTAKE_LOCALLY: readonly Locally[] = [
  {
    act: 'start',
    why: 'approving here leaves the work for the queue; starting agents at once is done at the machine',
  },
  { act: 'refuse', why: 'saying no to somebody else’s request is answered at the machine' },
  { act: 'retry', why: 'asking the source again reaches it with this machine’s own credential' },
]

/** The same, for a stored workflow. */
export const WORKFLOW_LOCALLY: readonly Locally[] = [
  {
    act: 'publish',
    why: 'publishing decides what every future run of it does, and a published version never changes',
  },
  { act: 'new', why: 'making a workflow, renaming one or turning one down is done at the machine' },
  { act: 'persona', why: 'a persona is what an agent is told, and is published at the machine' },
]

/** What the window knows about one request beyond its row. */
export interface IntakeBody {
  /** The body as Tade wrote it into the context file, heading and all. */
  body: string | null
  /** Why there is nothing to read, in words. May name a file, so it is elided on the wire. */
  problem: string | null
}

/** Which inbox states are somebody at this machine's to answer. */
const WAITING: readonly InboxState[] = ['proposed', 'held', 'failure']

/**
 * The requests, as the projection takes them.
 *
 * **The bodies are chosen rather than all carried**, and the choosing is the
 * part worth the words. A body is up to `budget.material` long and a machine
 * with forty requests would otherwise put a third of a megabyte on every
 * snapshot, for a phone that is reading one of them. So the ones that cross
 * are the requests somebody is being asked to decide about — waiting first,
 * then newest — and every other row says *its words are not on this page*
 * rather than drawing an empty request.
 *
 * `most` is the count, and it is the caller's: this file does not know what a
 * budget is.
 */
export function intakeIn(rows: readonly InboxRow[], facts: IntakeFacts): IntakeIn[] {
  const most = facts.most
  const carried = new Set(chosen(rows, most))
  return rows.map((row) =>
    one(row, facts, { held: facts.bodies.get(row.item) ?? null, carried: carried.has(row.item) }),
  )
}

/**
 * What the window knows about the requests beyond their rows.
 *
 * Three maps and a count, and each of the three is a fold the window already
 * has: the bodies it read when it folded the inbox, the titles out of the
 * `watch_found` lines, and which effort each task named.
 *
 * **The titles are in the journal and not on `InboxRow`**, which is correct
 * and is why they arrive separately: `intake-inbox.ts` keeps a stranger's
 * words out of its own type on purpose, and what a *watch* wrote down about
 * what it found is a different record. So the title is looked up by the
 * request's own item key rather than invented from its id — a row whose title
 * is `SHOP-1402` twice reads as a title nobody wrote, which it would be.
 */
export interface IntakeFacts {
  bodies: ReadonlyMap<string, IntakeBody>
  /**
   * What approving each request would start, by its item key.
   *
   * Only ever for the ones somebody is being asked to decide about: working
   * one out reads a task file per task, so a machine with forty answered
   * requests must not pay for forty of them on every fold.
   */
  would: ReadonlyMap<string, WouldIn>
  /** `<source>:<externalId>` → the title the watch found. Outside text. */
  titles: ReadonlyMap<string, string>
  /** Task id → the effort it names, so a request can point at its run. */
  efforts: ReadonlyMap<string, string>
  /** How many bodies may cross on one snapshot. The caller's budget. */
  most: number
}

/** Which requests' bodies cross: waiting first, then newest, up to `most`. */
function chosen(rows: readonly InboxRow[], most: number): string[] {
  const waiting = rows.filter((row) => WAITING.includes(row.state))
  const rest = rows.filter((row) => !WAITING.includes(row.state))
  return [...waiting, ...rest]
    .sort((a, b) => rank(a) - rank(b) || b.at - a.at)
    .slice(0, Math.max(0, most))
    .map((row) => row.item)
}

const rank = (row: InboxRow): number => (WAITING.includes(row.state) ? 0 : 1)

function one(
  row: InboxRow,
  facts: IntakeFacts,
  shown: { held: IntakeBody | null; carried: boolean },
): IntakeIn {
  const { carried } = shown
  const body = carried ? shown.held : null
  return {
    item: row.item,
    source: row.source,
    externalId: row.externalId,
    project: row.project,
    state: row.state,
    because: row.because,
    grant: row.grant,
    stamp:
      row.template === null ? null : { name: row.template.name, version: row.template.version },
    revision: row.revision,
    taken: row.taken,
    hash: row.hash,
    ref: row.ref,
    watch: row.watch,
    schedule: row.schedule,
    mode: row.mode,
    attempts: row.attempts,
    tries: row.tries,
    said: [...row.said],
    unsent: row.unsent.map((reply) => ({
      saying: reply.saying,
      attempts: reply.attempts,
      problem: reply.problem,
    })),
    tasks: [...row.tasks],
    work: row.work.map((task) => ({
      task: task.task,
      parked: task.parked,
      started: task.started,
      finished: task.finished,
      held: task.held,
      state: task.state,
    })),
    run: row.tasks.map((task) => facts.efforts.get(task) ?? '').find((name) => name !== '') ?? '',
    at: row.at,
    // **The parked task, and nothing about permission.** Approving from away
    // is the `intake` verb on this task, which re-asks the local grant and the
    // source at the moment of the act; what this says is only that there is
    // something to approve. A request whose work has all been picked up has
    // none, and the page says so out of `because` rather than offering a
    // control that would be refused.
    approve: approvable(row),
    locally: INTAKE_LOCALLY,
    title: facts.titles.get(row.item) ?? '',
    who: row.requester,
    url: row.url,
    material: body?.body ?? '',
    materialProblem: carried
      ? (body?.problem ?? (body === null ? 'nothing here has read it yet' : ''))
      : `its words are not on this page: ${facts.most} requests carry theirs, the ones waiting on somebody first`,
    would: facts.would.get(row.item) ?? null,
  }
}

/**
 * The one parked task approving this request would be asked about, or `''`.
 *
 * The first parked one, and not every one: `intake` is a verb about one task,
 * so a request whose template made three tasks is approved one at a time —
 * which is the honest shape rather than a control that silently means three
 * acts. A refused, noticed or given-up request has nothing to approve, and
 * that is `whyNotAct`'s answer, read here as an absence.
 */
function approvable(row: InboxRow): string {
  if (row.state !== 'proposed') return ''
  return row.work.find((task) => task.parked && !task.finished)?.task ?? ''
}

/**
 * The titles a watch found, by the request they are about.
 *
 * `watch_found` carries the finding's own key — `<source>:<externalId>:<revision>`
 * — and the title the source gave it. What a surface wants is the title of
 * *the request*, across every revision of it, so the key loses its revision
 * and the newest line wins: a ticket somebody renamed shows the name it has
 * now, which is the one a person would recognise.
 */
export function intakeTitles(
  found: readonly { key: string; title: string }[],
): Map<string, string> {
  const titles = new Map<string, string>()
  for (const one of found) {
    const parts = one.key.split(':')
    if (parts.length < 3) continue
    titles.set(parts.slice(0, 2).join(':'), one.title)
  }
  return titles
}

/** The doors, field by field. */
export function sourcesIn(rows: readonly SourceStanding[]): SourceIn[] {
  return rows.map((row) => ({
    source: row.source,
    state: row.state,
    because: row.because,
    grant: row.grant,
    accept: row.accept,
    reply: row.reply,
    names: row.names,
    mode: row.mode,
    template: row.template,
    projects: [...row.projects],
    allowed: row.allowed,
    watch: row.watch,
    schedule: row.schedule,
    every: row.every,
    lookedAt: row.lookedAt,
    workedAt: row.workedAt,
    found: row.found,
    fresh: row.fresh,
    left: row.left,
    trouble: row.trouble,
    until: row.until,
    handed: row.handed,
  }))
}

/** What one task of a run is, at its narrowest. The window already holds all of it. */
export interface RunTask {
  id: string
  project: string
  effort: string
  state: TaskState
  /** What its task file says it waits on, which is where the edges come from. */
  after: readonly { task: string; why: string }[]
  parked: boolean
  finished: boolean
  /** How many agents have been started on it. Two is a retry, and that is the history. */
  runs: number
  active: boolean
  checks: 'pass' | 'fail' | 'unknown'
  review: 'draft' | 'open' | 'merged' | 'closed' | null
  usd: number | null
}

/**
 * The runs, folded out of the task files that name each effort.
 *
 * **A run is an effort and nothing new** (`effortsIn`): the unit is one
 * ordinary task per repository, the grouping is the fold of the task files
 * naming it, and the edges are the `start.after` the queue's own rule already
 * reads. So nothing is kept, a removed task leaves the run correctly smaller,
 * and there is no second place for a run's shape to be wrong.
 *
 * The one thing computed here is the **layer**, which is what makes the graph
 * drawable on a phone: nought for a step that waits on nothing in this run,
 * and one more than the deepest thing it waits on otherwise. A wait on a task
 * outside the run is kept as an edge and does not deepen anything — it is a
 * dependency on work that is not part of this run, and counting it would push
 * a whole run down a column for a reason nothing on the screen explains.
 */
export function runsIn(
  tasks: readonly RunTask[],
  /** Which request each effort came from, and what it was stamped from. */
  from: ReadonlyMap<
    string,
    { item: string; source: string; stamp: RunIn['stamp']; retries: number }
  >,
): RunIn[] {
  const by = new Map<string, RunTask[]>()
  for (const task of tasks) {
    if (task.effort === '') continue
    by.set(task.effort, [...(by.get(task.effort) ?? []), task])
  }
  return [...by].map(([run, found]) => {
    const inOrder = [...found].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const layers = layersOf(inOrder)
    const projects: string[] = []
    for (const task of inOrder) if (!projects.includes(task.project)) projects.push(task.project)
    const came = from.get(run) ?? null
    return {
      run,
      projects,
      steps: inOrder.map((task) => step(task, layers.get(task.id) ?? 0)),
      from: came === null ? null : { item: came.item, source: came.source },
      stamp: came?.stamp ?? null,
      retries: came?.retries ?? 0,
    }
  })
}

function step(task: RunTask, layer: number): RunStepIn {
  return {
    task: task.id,
    project: task.project,
    name: task.id.slice(task.project.length + 1) || task.id,
    state: task.state,
    layer,
    waits: task.after.map((wait) => ({ task: wait.task, why: wait.why })),
    finished: task.finished,
    parked: task.parked,
    runs: task.runs,
    active: task.active,
    checks: task.checks,
    review: task.review,
    usd: task.usd,
  }
}

/**
 * How deep each step is, by the longest path of waits inside the run.
 *
 * Walked rather than sorted, with a visited set, because **a cycle must not
 * hang the window**: `checkPlan` refuses a plan with one, but these are task
 * files on disk that anybody can edit and a projection may not assume
 * otherwise. A step inside a cycle gets the depth of the path that reached it
 * and the drawing is odd, which is the right failure: the page shows something
 * wrong-looking rather than the window stopping.
 */
export function layersOf(tasks: readonly RunTask[]): Map<string, number> {
  const inRun = new Map(tasks.map((task) => [task.id, task]))
  const depth = new Map<string, number>()
  const walk = (id: string, seen: ReadonlySet<string>): number => {
    const already = depth.get(id)
    if (already !== undefined) return already
    const task = inRun.get(id)
    if (task === undefined || seen.has(id)) return 0
    const mine = new Set([...seen, id])
    let deepest = -1
    for (const wait of task.after) {
      if (!inRun.has(wait.task)) continue
      deepest = Math.max(deepest, walk(wait.task, mine))
    }
    const layer = deepest + 1
    depth.set(id, layer)
    return layer
  }
  for (const task of tasks) walk(task.id, new Set())
  return depth
}

/**
 * One stored workflow as the window holds it: its draft, its published
 * versions, and what the validator and the dry run said.
 *
 * Named rather than taking `Template` plus four loose values, so what the
 * away view is handed about a workflow is one list a reviewer reads — and so
 * the caller cannot hand over a template it has not validated, which is the
 * mistake that would put a draft on a phone with no sign that publishing
 * would refuse it.
 */
export interface WorkflowHeld {
  name: string
  builtIn: boolean
  /** Published versions, newest first. */
  versions: readonly number[]
  /**
   * The template whose steps are shown, or null where there is none to show.
   *
   * It is a draft or a published snapshot, and `shows` says which: the two
   * are the same shape and completely different things, and a row that did
   * not say which would make `v3` mean two things on one screen.
   */
  draft: Template | null
  shows: 'draft' | 'published' | 'nothing'
  /** The draft's content hash: the revision an edit echoes back. */
  rev: string
  problems: readonly string[]
  warnings: readonly string[]
  /** How many runs point at a published version of it. */
  runs: number
  /** Whether a draft of it could be saved from away at all. */
  editable: boolean
}

/**
 * The workflows, field by field, with the form the designer walks.
 *
 * **The form is the window's own**: `workflowFields` is the one function that
 * says what a workflow's fields are, what each one means and which cannot be
 * changed, and it is asked here for the template and for every step — so the
 * page a phone draws and the page the window draws are the same form, and
 * neither can offer a field the validator would refuse.
 *
 * A template with no draft carries no steps and no form, which is the honest
 * answer: there is nothing to edit, and what is published is a snapshot
 * nothing may change.
 */
export function workflowsIn(held: readonly WorkflowHeld[]): WorkflowIn[] {
  return held.map((one) => {
    const draft = one.draft
    return {
      name: one.name,
      builtIn: one.builtIn,
      versions: [...one.versions],
      draft: one.shows === 'draft' ? (draft?.version ?? null) : null,
      shows: one.shows,
      rev: one.rev,
      title: draft?.title ?? '',
      about: draft?.about ?? '',
      projectInput: draft?.project_input ?? '',
      saidInput: draft?.said_input ?? '',
      nameSuffix: draft?.name_suffix ?? '',
      inputs: Object.entries(draft?.inputs ?? {}).map(([name, input]) => ({
        name,
        kind: input.kind,
        required: input.required,
        about: input.about,
      })),
      steps: (draft?.agents ?? []).map((step, at) => ({
        name: step.name,
        persona: step.persona ?? step.from_persona ?? '',
        model: step.model ?? '',
        done: typeof step.done === 'string' ? step.done : (step.done?.worktree ?? ''),
        produces: step.produces ?? '',
        leaves: step.leaves_checks,
        touches: [...step.touches],
        after: step.after.map((wait) => ({ agent: wait.agent, why: wait.why })),
        prompt: step.prompt,
        fields: draft === null ? [] : fieldsIn(workflowFields(draft, { kind: 'step', at })),
      })),
      fields: draft === null ? [] : fieldsIn(workflowFields(draft, { kind: 'template' })),
      problems: [...one.problems],
      warnings: [...one.warnings],
      // The shape, out of the one function that works it out
      // (`workflowPlaces`): the same preview the window's own page draws, so
      // neither surface is a second layout of a different graph.
      places: draft === null ? [] : placesIn(workflowPlaces(draft)),
      runs: one.runs,
      editable: one.editable,
      locally: WORKFLOW_LOCALLY,
    }
  })
}

/** One form's fields, with `undefined` spelled as the empty string the wire uses. */
function fieldsIn(fields: readonly WorkflowField[]): WorkflowFieldIn[] {
  return fields.map((field) => ({
    id: field.id,
    label: field.label,
    value: field.value,
    kind: field.kind,
    options: [...(field.options ?? [])],
    means: field.means ?? '',
    off: field.off ?? '',
  }))
}

/** The shape, with `-1` for *hangs off nothing* spelled as the wire spells it. */
function placesIn(places: readonly WorkflowPlace[]): WorkflowIn['places'] {
  return places.map((place) => ({
    at: place.at,
    name: place.name,
    depth: place.depth,
    parent: places[place.parent]?.name ?? '',
    why: place.why.map((wait) => ({ on: wait.on, why: wait.why })),
    circular: place.circular,
  }))
}
