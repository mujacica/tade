import type {
  InboxState,
  InputKind,
  IntakeMode,
  LookTrouble,
  SourceState,
  TaskState,
} from '@tade/core'
import { MATERIAL_LABEL } from '@tade/core'
import { withoutPaths } from './fields.ts'
import { type Budget, textOf } from './page.ts'
import type { Said } from './protocol.ts'
import type {
  IntakeRow,
  Locally,
  RunRow,
  RunStep,
  SourceRow,
  Stamp,
  WorkflowField,
  WorkflowRow,
  WorkflowStep,
  Would,
} from './protocol-factory.ts'
import { has, type Reach, sees } from './reach.ts'

// The factory floor, projected: what was handed to this machine, the doors it
// came through, what a run of a workflow is doing, and the workflows.
//
// **The same two halves `input.ts` and `snapshot.ts` are**, in one file
// because they are one subject and neither half is long: the hand-written
// input types that say exactly what the window may hand over, and the pure
// functions that narrow them to what one device may read.
//
// **Nothing here is a serialization of a domain type.** `InboxRow` and
// `SourceStanding` are already path-free by construction, and it would be
// tempting to put one of them on the wire — but `Template` is a parsed file
// with every prompt in it, `Effort` is a fold over `Task`s that carry
// worktrees and pids, and the field somebody adds to any of the four next
// month would arrive on a phone with nobody having decided it. So the input
// types below are written out field by field, exactly as `TaskIn` is, and the
// window's own side (`packages/app/src/away-factory.ts`) does the mapping.
//
// Pure: inputs and a reach in, rows out. No clock reads — every moment is a
// number handed in — no `node:`, nothing to await.

const ISO = (at: number): string => new Date(at).toISOString()
const ISO_OR = (at: number | null): string | null => (at === null ? null : ISO(at))
/** An empty string is `unknown` and goes out as `null`: one spelling on the wire. */
const SOME = (text: string): string | null => (text === '' ? null : text)

/**
 * What became of one task a request made, as the window has it.
 *
 * `state` is `deriveState`'s and is **null where nothing could ask for one**,
 * which is a first-class answer: a surface that invented a state here would be
 * a second answer to a question `deriveState` already answers.
 */
export interface IntakeWorkIn {
  task: string
  parked: boolean
  started: boolean
  finished: boolean
  held: string | null
  state: TaskState | null
}

/**
 * One request handed to this machine, as the window hands it over.
 *
 * Every string is one of three things and the type says which: Tade's own
 * **metadata**, the source's own **ids**, or **outside text** — and the three
 * outside ones are last, together, so a reader can see the whole of what a
 * stranger wrote in one place.
 */
export interface IntakeIn {
  /** `<source>:<externalId>`. */
  item: string
  source: string
  externalId: string
  project: string
  state: InboxState
  /** Tade's own sentence. Never a word of the request. */
  because: string
  /** The dotted config path of the grant that allowed it. `''` for none. */
  grant: string
  stamp: Stamp | null
  revision: string
  taken: string
  hash: string
  ref: string
  watch: string
  schedule: string
  mode: IntakeMode | null
  attempts: number
  tries: number
  /** Tade's own fixed sentences that went back to the source. */
  said: readonly string[]
  /** The statuses that did not go. `problem` is a connector's sentence about a service. */
  unsent: readonly { saying: string; attempts: number; problem: string | null }[]
  tasks: readonly string[]
  work: readonly IntakeWorkIn[]
  /** The effort its tasks name, where a workflow made several. `''` for none. */
  run: string
  at: number
  /**
   * The parked task approving this would be asked about, or `''`.
   *
   * The window's answer and not this file's: whether a task is parked, came
   * from outside and is not finished is `ableOn`'s question, asked once, and a
   * second reading of it here could offer what the verb refuses.
   */
  approve: string
  /** The acts that stay at this machine, each with its one clause. */
  locally: readonly Locally[]
  // --- outside text. Three fields, and each needs a grant.
  /** What the source calls it. */
  title: string
  /** The handle the source gave, never read as authority. `''` where none said. */
  who: string
  /** The source's own page for it. `''` for a door with no pages. */
  url: string
  /** The body as Tade wrote it into the context file, heading and all. `''` for none. */
  material: string
  /** Why there is no body, where there is none. Tade's own sentence. */
  materialProblem: string
  /** What approving it would start, where anything worked it out. */
  would: WouldIn | null
}

/** What approving one request would start, as `intakeWouldRun` answers it. */
export interface WouldIn {
  starts: readonly {
    task: string
    project: string
    workspace: 'checkout' | 'worktree'
    done: string
    produces: string | null
    touches: readonly string[]
    after: readonly { task: string; why: string }[]
    parked: boolean
  }[]
  grant: readonly string[]
  /** Money is in these sentences, so they travel behind the `spend` grant. */
  limits: readonly string[]
  problems: readonly string[]
  warnings: readonly string[]
}

/** One door outside work arrives through, as the window folded it. */
export interface SourceIn {
  source: string
  state: SourceState
  because: string
  grant: string
  accept: boolean
  reply: boolean
  names: boolean
  mode: IntakeMode | null
  template: string
  projects: readonly string[]
  allowed: number
  watch: string
  schedule: string
  every: string
  lookedAt: number | null
  workedAt: number | null
  found: number
  fresh: number
  left: number
  trouble: LookTrouble | null
  until: number | null
  handed: number
}

/** One step of a run, as the window folded it out of the task files. */
export interface RunStepIn {
  task: string
  project: string
  name: string
  state: TaskState
  layer: number
  waits: readonly { task: string; why: string }[]
  finished: boolean
  parked: boolean
  /** How many agents have been started on it. Two is a retry. */
  runs: number
  active: boolean
  checks: 'pass' | 'fail' | 'unknown'
  review: 'draft' | 'open' | 'merged' | 'closed' | null
  usd: number | null
}

/** One run of a workflow: the fold of the task files naming one effort. */
export interface RunIn {
  run: string
  projects: readonly string[]
  steps: readonly RunStepIn[]
  from: { item: string; source: string } | null
  stamp: Stamp | null
  retries: number
}

/** One field of the designer's form, as `workflowFields` says it. */
export interface WorkflowFieldIn {
  id: string
  label: string
  value: string
  kind: 'text' | 'choice' | 'check'
  options: readonly string[]
  means: string
  off: string
}

/** One step of a stored workflow. */
export interface WorkflowStepIn {
  name: string
  persona: string
  model: string
  done: string
  produces: string
  leaves: 'green' | 'red'
  touches: readonly string[]
  after: readonly { agent: string; why: string }[]
  prompt: string
  fields: readonly WorkflowFieldIn[]
}

/** One stored workflow, as the window folded it. */
export interface WorkflowIn {
  name: string
  builtIn: boolean
  versions: readonly number[]
  draft: number | null
  /** Whether the steps below are a draft's, a published snapshot's, or absent. */
  shows: 'draft' | 'published' | 'nothing'
  /** The draft's content hash: the revision an edit echoes back. `''` for no draft. */
  rev: string
  title: string
  about: string
  projectInput: string
  saidInput: string
  nameSuffix: string
  inputs: readonly { name: string; kind: InputKind; required: boolean; about: string }[]
  steps: readonly WorkflowStepIn[]
  fields: readonly WorkflowFieldIn[]
  problems: readonly string[]
  warnings: readonly string[]
  /** The shape the steps resolve to, as `workflowPlaces` answers it. */
  places: readonly {
    at: number
    name: string
    depth: number
    /** The step it hangs off, by name; `''` for one that hangs off nothing. */
    parent: string
    why: readonly { on: string; why: string }[]
    circular: boolean
  }[]
  runs: number
  /** Whether a draft of it could be saved from away at all, and why not. */
  editable: boolean
  locally: readonly Locally[]
}

// --- the projection

/**
 * One request, as this device may read it.
 *
 * The three grants are asked separately and the page is told which answer it
 * is looking at: a body that is null because nobody granted it and one that is
 * null because Tade never wrote one down are different facts, and a page that
 * drew both as *nothing to read* tells somebody a request is empty.
 */
export function intakeRow(one: IntakeIn, reach: Reach, budget: Budget): IntakeRow {
  const words = has(reach, 'requests')
  const body = has(reach, 'material')
  return {
    item: one.item,
    source: one.source,
    externalId: one.externalId,
    project: one.project,
    state: one.state,
    because: one.because,
    grant: SOME(one.grant),
    stamp: one.stamp === null ? null : { name: one.stamp.name, version: one.stamp.version },
    revision: one.revision,
    taken: one.taken,
    // Said as a boolean as well as as two strings, because *the request has
    // moved since the work was made* is the one thing on this row a person
    // acts on immediately, and comparing two opaque ids is not something to
    // ask of a reader on a phone.
    moved: one.taken !== '' && one.taken !== one.revision,
    hash: one.hash,
    ref: one.ref,
    watch: one.watch,
    schedule: one.schedule,
    mode: one.mode,
    attempts: one.attempts,
    tries: one.tries,
    said: [...one.said],
    unsent: one.unsent.map((reply) => ({
      saying: reply.saying,
      attempts: reply.attempts,
      // A connector's own sentence about somebody else's service: the one
      // string on this row that this package did not write, so the claim
      // *the away view adds no path of its own* is kept at the boundary that
      // makes it, exactly as it is for `fresh.warnings`.
      problem: reply.problem === null ? null : withoutPaths(reply.problem),
    })),
    tasks: [...one.tasks],
    work: one.work.map((task) => ({
      task: task.task,
      parked: task.parked,
      started: task.started,
      finished: task.finished,
      held: task.held,
      state: task.state,
    })),
    run: SOME(one.run),
    at: ISO(one.at),
    approve: SOME(one.approve),
    locally: one.locally.map((act) => ({ act: act.act, why: act.why })),
    title: words ? textOf(one.title, budget.text) : null,
    who: words ? textOf(one.who, budget.text) : null,
    // An `https` url and nothing else, which is the client's rule
    // (`safeHref`) asked on this side too: a `javascript:` href that reached
    // the page would be refused there, and a row that carried one would be a
    // row whose safety depended on one function in a browser.
    url: words && https(one.url) ? one.url : null,
    material: body ? textOf(one.material, budget.material) : null,
    materialSays: body ? SOME(one.materialProblem) : notGranted(one),
    // **The heading travels with the body and is not the page's to choose.**
    // A drawing that put its own word above a stranger's sentences would be
    // one word away from putting none there, and this is the repository's one
    // wording of what material means — the same sentence the agent working on
    // it reads in its context file.
    materialLabel: body && one.material !== '' ? MATERIAL_LABEL : null,
    would: one.would === null ? null : wouldOf(one.would, budget, has(reach, 'spend')),
  }
}

/**
 * What approving would start, with its money behind the money grant.
 *
 * `limits` is where `intakeWouldRun` says what a project has spent today
 * against what it may, which is money in a sentence — so a device without
 * `spend` reads the rows and the grant and is told the figures are not its to
 * see, rather than reading a budget sentence with a dollar amount in it.
 */
export function wouldOf(would: WouldIn, budget: Budget, money: boolean): Would {
  return {
    starts: would.starts.map((start) => ({
      task: start.task,
      project: start.project,
      workspace: start.workspace,
      done: start.done,
      produces: start.produces,
      touches: [...start.touches],
      after: start.after.map((wait) => ({
        task: wait.task,
        why: textOf(wait.why, budget.text),
      })),
      parked: start.parked,
    })),
    grant: [...would.grant],
    limits: money ? [...would.limits] : [],
    problems: [...would.problems],
    warnings: [...would.warnings],
  }
}

/** Why there is no body, for a device that was not granted one. */
function notGranted(one: IntakeIn): string {
  return `this device was not granted the words of a request; ${one.source} ${one.externalId} has them`
}

/** Whether a url may go on the wire at all. Parsed, never pattern-matched. */
function https(url: string): boolean {
  if (url === '') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One door, with its project list narrowed to what this device may read.
 *
 * The narrowing is the part worth the words: a grant lists project names, and
 * a device granted one project of five must not learn the other four's names
 * from a door's row. The rest are counted, which is the shape every other
 * withheld thing here has.
 */
export function sourceRow(one: SourceIn, reach: Reach): SourceRow {
  const mine = one.projects.filter((project) => sees(reach, project))
  return {
    source: one.source,
    state: one.state,
    because: one.because,
    grant: SOME(one.grant),
    accept: one.accept,
    reply: one.reply,
    names: one.names,
    mode: one.mode,
    template: SOME(one.template),
    projects: mine,
    projectsElsewhere: one.projects.length - mine.length,
    allowed: one.allowed,
    watch: SOME(one.watch),
    schedule: SOME(one.schedule),
    every: SOME(one.every),
    lookedAt: ISO_OR(one.lookedAt),
    workedAt: ISO_OR(one.workedAt),
    found: one.found,
    fresh: one.fresh,
    left: one.left,
    trouble: one.trouble,
    until: ISO_OR(one.until),
    handed: one.handed,
  }
}

/**
 * One run, with the rollups that make it readable at a glance.
 *
 * The three rollups are computed here rather than carried, because each is a
 * fold over the steps this device can see and all three have a rule that must
 * not be guessed: **`unknown` beats `pass`** for checks (a check nobody ran is
 * not a check that passed), money is null without the grant rather than
 * nought, and `finished` counts what the journal says rather than what a state
 * happens to be.
 */
export function runRow(one: RunIn, reach: Reach, budget: Budget): RunRow {
  const steps = one.steps.filter((step) => sees(reach, step.project))
  const money = has(reach, 'spend')
  const rows = steps.map((step) => runStep(step, { money, why: has(reach, 'intent'), budget }))
  const usd = money ? rows.reduce((total, step) => total + (step.usd ?? 0), 0) : null
  return {
    run: one.run,
    projects: one.projects.filter((project) => sees(reach, project)),
    steps: rows,
    finished: rows.filter((step) => step.finished).length,
    total: rows.length,
    layers: rows.reduce((deepest, step) => Math.max(deepest, step.layer + 1), 0),
    from: one.from === null ? null : { item: one.from.item, source: one.from.source },
    stamp: one.stamp === null ? null : { name: one.stamp.name, version: one.stamp.version },
    retries: one.retries,
    checks: rollup(rows),
    usd,
  }
}

function runStep(step: RunStepIn, how: { money: boolean; why: boolean; budget: Budget }): RunStep {
  return {
    task: step.task,
    project: step.project,
    name: step.name,
    state: step.state,
    layer: step.layer,
    waits: step.waits.map((wait) => ({
      task: wait.task,
      // The reason somebody gave for a wait is their own words, so it rides on
      // the same grant the queue's own `waitsOn` reason rides on — one answer
      // to one question, rather than a second rule for the same sentence seen
      // through a different collection.
      why: how.why ? textOf(wait.why, how.budget.text) : null,
    })),
    finished: step.finished,
    parked: step.parked,
    runs: step.runs,
    active: step.active,
    checks: step.checks,
    review: step.review,
    // Nought where a step reported nothing and null where this device may not
    // be told: `hasCost` tells those apart on a task row, and a run's steps
    // are a rollup, so the honest shape here is the grant deciding the field.
    usd: how.money ? (step.usd ?? 0) : null,
  }
}

/**
 * Every step's checks as one answer.
 *
 * `fail` if any failed, then `unknown` if any cannot say, and `pass` only when
 * every one of them passed. **`unknown` beats `pass`** and that ordering is
 * the whole rule: a run of four steps where three passed and nothing has
 * looked at the fourth is not a green run, and drawing it green is the one
 * mistake this rollup exists to prevent. A run with no steps is `unknown`,
 * because nothing has said anything about it.
 */
export function rollup(
  steps: readonly { checks: 'pass' | 'fail' | 'unknown' }[],
): RunRow['checks'] {
  if (steps.some((step) => step.checks === 'fail')) return 'fail'
  if (steps.length === 0 || steps.some((step) => step.checks === 'unknown')) return 'unknown'
  return 'pass'
}

/**
 * One stored workflow, as this device may read it.
 *
 * **The whole of the content is behind one grant** (`workflows`), because a
 * step's prompt is the owner's own words about how they want work done and
 * there is no useful half of it: a list of step names with the prompts
 * withheld is a designer nobody can design with. So without the grant the row
 * is the name, the versions, and the counts — which still answers *is this
 * published, and what is running on it*.
 */
export function workflowRow(one: WorkflowIn, reach: Reach, budget: Budget): WorkflowRow {
  const read = has(reach, 'workflows')
  const said = (text: string): Said | null => (read ? textOf(text, budget.text) : null)
  return {
    name: one.name,
    builtIn: one.builtIn,
    versions: [...one.versions],
    published: one.versions[0] ?? null,
    draft: one.draft,
    shows: one.shows,
    rev: SOME(one.rev),
    title: said(one.title),
    about: said(one.about),
    projectInput: read ? SOME(one.projectInput) : null,
    saidInput: read ? SOME(one.saidInput) : null,
    nameSuffix: read ? SOME(one.nameSuffix) : null,
    inputs: read
      ? one.inputs.map((input) => ({
          name: input.name,
          kind: input.kind,
          required: input.required,
          about: textOf(input.about, budget.text),
        }))
      : [],
    steps: read ? one.steps.map((step) => workflowStep(step, budget)) : [],
    fields: read ? one.fields.map((field) => workflowField(field, budget)) : [],
    // Tade's own sentences about what publishing would refuse. Metadata, so
    // they go out whether or not the content does: *this draft will not
    // publish* is a name-and-count fact about a workflow.
    problems: [...one.problems],
    warnings: [...one.warnings],
    // The shape, and it is metadata: a step's name and its column are Tade's
    // own words about the owner's own file, so they go out with the counts.
    // The reason beside a wait is the owner's and rides on the grant.
    places: one.places.map((place) => ({
      at: place.at,
      name: place.name,
      depth: place.depth,
      parent: place.parent === '' ? null : place.parent,
      why: place.why.map((wait) => ({
        on: wait.on,
        why: read ? textOf(wait.why, budget.text) : null,
      })),
      circular: place.circular,
    })),
    runs: one.runs,
    editable: one.editable,
    locally: one.locally.map((act) => ({ act: act.act, why: act.why })),
  }
}

function workflowStep(step: WorkflowStepIn, budget: Budget): WorkflowStep {
  return {
    name: step.name,
    persona: SOME(step.persona),
    model: SOME(step.model),
    done: SOME(step.done),
    produces: SOME(step.produces),
    leaves: step.leaves,
    touches: [...step.touches],
    after: step.after.map((wait) => ({
      agent: wait.agent,
      why: textOf(wait.why, budget.text),
    })),
    prompt: textOf(step.prompt, budget.material),
    fields: step.fields.map((field) => workflowField(field, budget)),
  }
}

function workflowField(field: WorkflowFieldIn, budget: Budget): WorkflowField {
  return {
    id: field.id,
    label: field.label,
    value: textOf(field.value, budget.material),
    kind: field.kind,
    options: [...field.options],
    means: SOME(field.means),
    off: SOME(field.off),
  }
}
