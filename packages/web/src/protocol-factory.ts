import {
  INBOX_STATES,
  INPUT_KINDS,
  INTAKE_MODES,
  LEAVES_CHECKS,
  LOOK_TROUBLES,
  SOURCE_STATES,
  TaskState,
} from '@tade/core'
import { z } from 'zod'
import { SaidSchema } from './said.ts'

// The four collections that make the away view a factory floor rather than a
// list of agents: what has been handed to this machine, the doors it came
// through, what a run of a workflow is doing, and the workflows themselves.
//
// **A second file and not a longer `protocol.ts`**, for the reason that file
// gives about itself: it is the allow-list somebody reads, and a reader who
// has to scroll past four collections to check the one they came for is a
// reader who skims. These four are one subject — outside work and the shapes
// it is stamped from — and `protocol.ts` composes them exactly as it composes
// the rest.
//
// Every object here is a `z.strictObject` and every schema is parsed in tests,
// which is the same guarantee `protocol.ts` makes and for the same reason: a
// field somebody spread in by accident is a failure rather than a passenger.
//
// ## The three kinds of string, and the one that is new
//
// `protocol.ts` has two — **metadata** Tade wrote, and **authored free text**
// the owner wrote. This file adds the third and it is the reason the grants
// `requests` and `material` exist:
//
// **Outside text** is what a stranger wrote in a system Tade does not control:
// a ticket's title, a Slack message's words, the handle of whoever filed it.
// It is not the owner's and it is not Tade's, so neither existing rule fits —
// it is not scrubbed (rewording somebody's request is the same lie as
// rewording a note) and it is not held to carrying no path (a stranger may
// write whatever they like). What stands instead is that **it travels only
// where the person at this machine granted it**, under two grants rather than
// one, is cut to a budget, is drawn as text and never as markup, and is drawn
// under `MATERIAL_LABEL` so a reader is told whose words they are.
//
// `fields.ts`'s `OUTSIDE` is the mechanical half: the paths that hold it, held
// equal to what the projection produces in both directions.

/**
 * What approving one request would start, and it starts none of it.
 *
 * **It describes the work that exists rather than simulating work that does
 * not** (`intakeWouldRun`): a proposal's tasks were made when the request was
 * accepted — parked, with their context files and their waits already written
 * — so the honest answer to *what happens if I press approve* is those tasks
 * read off their own files. A second fill of the template would have to guess
 * at the body again, and would answer a different question.
 *
 * `limits` carries what the projects have spent today, so it is behind the
 * `spend` grant; everything else here is Tade's own sentence about work that
 * already exists.
 */
export const WouldSchema = z.strictObject({
  starts: z.array(
    z.strictObject({
      task: z.string(),
      project: z.string(),
      workspace: z.enum(['checkout', 'worktree']),
      done: z.string(),
      produces: z.string().nullable(),
      /** Repository-relative, the way the task file spells them. */
      touches: z.array(z.string()),
      after: z.array(z.strictObject({ task: z.string(), why: SaidSchema.nullable() })),
      parked: z.boolean(),
    }),
  ),
  /** What the grant says **now**, and what this grants, which is nothing. */
  grant: z.array(z.string()),
  /** What bounds it, and what could not be read — never as nought. Behind `spend`. */
  limits: z.array(z.string()),
  /** Why nothing would start. */
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
})
export type Would = z.infer<typeof WouldSchema>

/**
 * One step of a stored workflow's shape: its column, and what it hangs off.
 *
 * `workflowPlaces`' own answer, which is the **preview a template can
 * honestly give**: nobody has asked for a run, so there are no inputs, and a
 * dry run filled with invented values would say a run would happen somewhere
 * it would not. What a reader learns from the shape is how many steps, in what
 * order, with what waits — which is the question the shape answers.
 *
 * `circular` is named rather than drawn at some depth: a cycle has no column,
 * `templateProblems` is what refuses it, and this says which steps it is
 * about.
 */
export const PlaceSchema = z.strictObject({
  at: z.int().nonnegative(),
  name: z.string(),
  depth: z.int().nonnegative(),
  /** The step it hangs off, by name, or null where it hangs off nothing. */
  parent: z.string().nullable(),
  why: z.array(z.strictObject({ on: z.string(), why: SaidSchema.nullable() })),
  circular: z.boolean(),
})
export type Place = z.infer<typeof PlaceSchema>

/** How many times carrying a request out may fail before Tade gives up. */
export const IntakeStateSchema = z.enum(INBOX_STATES)

/**
 * The published workflow a request was stamped from, and the version resolved
 * at the moment of accepting.
 *
 * **Two fields and never one.** A published version never changes, so the
 * version is what says which bytes ran — and a run that points at `3` goes on
 * pointing at `3` after `4` is published, which is the whole reason publishing
 * writes a snapshot instead of editing a file.
 */
export const StampSchema = z.strictObject({
  name: z.string(),
  version: z.int().nonnegative(),
})
export type Stamp = z.infer<typeof StampSchema>

/**
 * One act a row offers that stays at this machine, with the clause saying why.
 *
 * **One clause each, never a paragraph.** "Explain when a design requires
 * local confirmation" is a real obligation and the failure mode either side of
 * it is loud: a control that simply is not there leaves somebody tapping at a
 * screen, and a page of prose about authority is a page nobody reads twice. So
 * it is the shape `TaskRow.cannot` already has — the act, and one sentence —
 * and the long form is said once, where somebody is deciding, in Settings.
 */
export const LocallySchema = z.strictObject({ act: z.string(), why: z.string() })
export type Locally = z.infer<typeof LocallySchema>

/** What became of one task a request made. */
export const IntakeWorkSchema = z.strictObject({
  task: z.string(),
  parked: z.boolean(),
  started: z.boolean(),
  finished: z.boolean(),
  /** Why the queue is holding it, in Tade's own sentence. Null where it is not. */
  held: z.string().nullable(),
  /** `deriveState`'s own answer where anything could ask for one; null where nobody could. */
  state: TaskState.nullable(),
})
export type IntakeWork = z.infer<typeof IntakeWorkSchema>

/**
 * One request that was handed to this machine.
 *
 * Keyed by `item` — `<source>:<externalId>` — which is the thing itself across
 * every revision of it, and is what the journal keys by.
 */
export const IntakeRowSchema = z.strictObject({
  item: z.string(),
  source: z.string(),
  externalId: z.string(),
  project: z.string(),
  /**
   * `deriveState`'s equivalent for a request: seven states, not three
   * (`inboxStateOf`). **`proposed` and `started` are the two that must never
   * be drawn as one** — one is waiting for a person and the other is an agent
   * spending money — and the page's own glyphs are held to the domain's words.
   */
  state: IntakeStateSchema,
  /** Tade's own sentence about why it is in that state. Never a word of the request. */
  because: z.string(),
  /** The dotted config path of the grant that allowed it. Null where none did. */
  grant: z.string().nullable(),
  stamp: StampSchema.nullable(),
  /**
   * The newest revision seen, and the one the work was made for. **Two facts**,
   * because a request somebody edited after Tade made work for it is the thing
   * a person most needs to see, and one field could only say one of them.
   */
  revision: z.string(),
  taken: z.string(),
  /** Whether those two differ: the request has moved since the work was made. */
  moved: z.boolean(),
  /** The hash of the body the work was made from. How "the text has moved" is a comparison. */
  hash: z.string(),
  /** The source's own stable reference to the raw material. Never a path Tade took. */
  ref: z.string(),
  /** The watch it came through, and the schedule that watch runs as. */
  watch: z.string(),
  schedule: z.string(),
  mode: z.enum(INTAKE_MODES).nullable(),
  /** How many times carrying it out has failed, out of how many Tade tries. */
  attempts: z.int().nonnegative(),
  tries: z.int().nonnegative(),
  /** Which of Tade's own fixed sentences have gone back to the source. */
  said: z.array(z.string()),
  /**
   * The statuses that did not go, and why.
   *
   * A reply that failed is a person at the other end who was never told, and
   * the one thing that must not happen to it is going quiet. `problem` is a
   * connector's own sentence about somebody else's service, so it is the one
   * string here that is run through `withoutPaths` — like `fresh.warnings`,
   * and for the same reason: this package did not write it.
   */
  unsent: z.array(
    z.strictObject({
      saying: z.string(),
      attempts: z.int().nonnegative(),
      problem: z.string().nullable(),
    }),
  ),
  tasks: z.array(z.string()),
  work: z.array(IntakeWorkSchema),
  /** The run this request's work is, where a workflow made several tasks. */
  run: z.string().nullable(),
  at: z.string(),
  // --- what a device may do about it
  /**
   * The parked task approving this would be asked about, or null.
   *
   * **An existing verb's target and not a new verb.** Approving from away is
   * `intake` on that task (`verbs.ts`), which already re-asks the local grant
   * and the source at the moment of the act. Carrying the task id is what lets
   * the page offer the control it already has rather than needing a route of
   * its own — and a row with none is a row with nothing to approve, which the
   * page says instead of drawing a dead button.
   */
  approve: z.string().nullable(),
  /** The acts that stay at this machine, each with its one clause. */
  locally: z.array(LocallySchema),
  // --- outside text, each field behind its own grant
  /**
   * What the source itself calls it. **Outside text** (`requests`).
   *
   * Null where the device was not granted it, which is the same shape every
   * other withheld field has: a count and a state without it, the words with.
   */
  title: SaidSchema.nullable(),
  /** The handle the source gave, never read as authority. **Outside text** (`requests`). */
  who: SaidSchema.nullable(),
  /** The source's own page for it, where it has one and it is `https`. */
  url: z.string().nullable(),
  /**
   * The request itself, as Tade wrote it into the task's context file.
   * **Outside text** (`material`), and the only field on this projection that
   * carries a stranger's sentences.
   *
   * Null for three different reasons and the page says which: the device was
   * not granted it, Tade never wrote one down, or there is a body and it is
   * not on this frame. `materialSays` carries that answer.
   */
  material: SaidSchema.nullable(),
  /** Why there is no body here, in words. Null when there is one. */
  materialSays: z.string().nullable(),
  /** The one wording of what material means, carried with the body it labels. */
  materialLabel: z.string().nullable(),
  /**
   * What approving it would start. Null where nothing worked it out.
   *
   * Only ever for a request somebody is being asked to decide about: working
   * it out reads a task file per task, so a machine with forty answered
   * requests must not pay for forty of them on every fold.
   */
  would: WouldSchema.nullable(),
})
export type IntakeRow = z.infer<typeof IntakeRowSchema>

/**
 * One door outside work arrives through.
 *
 * **It exists because an empty inbox has five meanings** and four of them are
 * somebody at this machine's to fix (`intake-sources.ts`). A page that drew
 * them all as *nothing yet* says the factory is quiet while a connector has
 * been answering `429` since Tuesday.
 */
export const SourceRowSchema = z.strictObject({
  source: z.string(),
  state: z.enum(SOURCE_STATES),
  /** Tade's own sentence about why it is in that state. */
  because: z.string(),
  /** The dotted config path of its grant. Null where this device may not be told. */
  grant: z.string().nullable(),
  accept: z.boolean(),
  reply: z.boolean(),
  names: z.boolean(),
  mode: z.enum(INTAKE_MODES).nullable(),
  /** The published workflow its work is stamped from, or null for one task. */
  template: z.string().nullable(),
  /**
   * The projects it may make work in, **narrowed to the ones this device may
   * read**, with the rest counted.
   *
   * A grant lists project names, and a device granted one project of five must
   * not learn the other four's names from a door's row — which is the same
   * rule the rest of the projection follows, applied to a list that is not a
   * collection.
   */
  projects: z.array(z.string()),
  projectsElsewhere: z.int().nonnegative(),
  /** How many handles its grant lists. A count: a handle is a request's to show. */
  allowed: z.int().nonnegative(),
  watch: z.string().nullable(),
  /**
   * The schedule that runs that watch, or null where nothing does.
   *
   * **Two fields and not one**: a watch an extension offers and a schedule
   * somebody turned on are different facts, and a row with a watch and no
   * schedule is a door nothing looks through — which is what `unwatched`
   * means and what a surface reading only the watch's id would miss.
   */
  schedule: z.string().nullable(),
  every: z.string().nullable(),
  lookedAt: z.string().nullable(),
  workedAt: z.string().nullable(),
  found: z.int().nonnegative(),
  fresh: z.int().nonnegative(),
  left: z.int().nonnegative(),
  /** Which kind of trouble the last look ran into. Null where it worked, or where nothing said. */
  trouble: z.enum(LOOK_TROUBLES).nullable(),
  /** When a spent budget is clear again, as the source itself said. */
  until: z.string().nullable(),
  handed: z.int().nonnegative(),
})
export type SourceRow = z.infer<typeof SourceRowSchema>

/** One step of a run: a task, where it sits in the order, and what it is doing. */
export const RunStepSchema = z.strictObject({
  task: z.string(),
  project: z.string(),
  /** The task's own name, which is the step's name once a template stamped it. */
  name: z.string(),
  state: TaskState,
  /**
   * Which layer of the graph it is in: nought for a step that waits on
   * nothing, and one more than the deepest thing it waits on otherwise.
   *
   * **The whole of the DAG, and it is a number rather than a drawing.** A
   * layered graph is what the window draws (`plan-graph.ts`) and what a phone
   * has no room for; what a reader needs on 360 pixels is which steps can run
   * now, which wait, and on what. So the edges travel as `waits` and the depth
   * as this, and the page draws columns, an indented list, or neither,
   * depending on the room — rather than a second layout engine agreeing with
   * the first.
   */
  layer: z.int().nonnegative(),
  waits: z.array(z.strictObject({ task: z.string(), why: SaidSchema.nullable() })),
  /** Whether the journal says it is finished, and whether somebody set it aside. */
  finished: z.boolean(),
  parked: z.boolean(),
  /** How many agents have been started on it. **Two is a retry**, and that is the history. */
  runs: z.int().nonnegative(),
  /** Whether an agent is on it now, which is what makes it the active step. */
  active: z.boolean(),
  /** The rollup of the required checks at its head. `unknown` is first-class. */
  checks: z.enum(['pass', 'fail', 'unknown']),
  /** The review its branch is out for, where there is one. */
  review: z.enum(['draft', 'open', 'merged', 'closed']).nullable(),
  /** What it has cost, where the device was granted money. */
  usd: z.number().nullable(),
})
export type RunStep = z.infer<typeof RunStepSchema>

/**
 * One run of a workflow: every task that names the same effort, in order.
 *
 * **A run is an effort and nothing new** (`effortsIn`): the unit is one
 * ordinary task per repository, each with its own branch, checks, review and
 * done rule, and the grouping is the fold of the task files that name it. So
 * there is nothing kept, a removed task leaves the run correctly smaller, and
 * what the page draws as a graph is read out of the same `start.after` the
 * queue's own rule reads.
 */
export const RunRowSchema = z.strictObject({
  /** The effort's own slug, as the task files spell it. The stable id. */
  run: z.string(),
  projects: z.array(z.string()),
  steps: z.array(RunStepSchema),
  /** How many steps have finished, out of how many there are. Partial completion, said. */
  finished: z.int().nonnegative(),
  total: z.int().nonnegative(),
  /** How deep the graph is: one more than the deepest layer, or nought for none. */
  layers: z.int().nonnegative(),
  /** The request this run came from, where it came from one. */
  from: z.strictObject({ item: z.string(), source: z.string() }).nullable(),
  /** The published workflow it was stamped from. Never changes once a run points at it. */
  stamp: StampSchema.nullable(),
  /** How many times carrying the request out failed before this run existed. */
  retries: z.int().nonnegative(),
  /** The rollup of every step's checks: `fail` if any failed, `unknown` if any cannot say. */
  checks: z.enum(['pass', 'fail', 'unknown']),
  /** What the whole run has cost, where the device was granted money. */
  usd: z.number().nullable(),
})
export type RunRow = z.infer<typeof RunRowSchema>

/** One field of the designer's form, as `workflowFields` says it. */
export const WorkflowFieldSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  /** What it holds. **Authored free text**: the owner wrote every workflow. */
  value: SaidSchema.nullable(),
  kind: z.enum(['text', 'choice', 'check']),
  options: z.array(z.string()),
  /** Said under the one the keyboard is on, where the consequence is not in the name. */
  means: z.string().nullable(),
  /** Why it cannot be changed here, where it cannot. */
  off: z.string().nullable(),
})
export type WorkflowField = z.infer<typeof WorkflowFieldSchema>

/** One step of a stored workflow, as the list draws it. */
export const WorkflowStepSchema = z.strictObject({
  name: z.string(),
  persona: z.string().nullable(),
  model: z.string().nullable(),
  done: z.string().nullable(),
  produces: z.string().nullable(),
  leaves: z.enum(LEAVES_CHECKS),
  /** Repository-relative, the way the template spells them. */
  touches: z.array(z.string()),
  after: z.array(z.strictObject({ agent: z.string(), why: SaidSchema.nullable() })),
  /** What its agent is told. **Authored free text**, and the longest string here. */
  prompt: SaidSchema.nullable(),
  /** The form for this step: the same fields the window's own page walks. */
  fields: z.array(WorkflowFieldSchema),
})
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

/**
 * One stored workflow: its published versions, its draft, and the form.
 *
 * **The designer is a list, a form and a dry run, and never a canvas**, which
 * is `templates-edit.ts`'s decision carried onto a phone rather than a new
 * one: a template has three to five steps with one shape, a canvas is for a
 * graph you do not already know, and positions are noise in every diff. On 360
 * pixels it is not even a choice.
 *
 * **A published version is a snapshot and never changes** — `versions` is the
 * list of them and `draft` is the one thing an edit can reach. A run points at
 * `name@version` for ever, so what is published here cannot move under a run
 * that is going.
 */
export const WorkflowRowSchema = z.strictObject({
  name: z.string(),
  /** Whether Tade ships it, in which case its bytes are in Tade's own source. */
  builtIn: z.boolean(),
  /** Every published version, newest first. Empty for a draft nobody published. */
  versions: z.array(z.int().nonnegative()),
  /** The newest published version, or null for none. */
  published: z.int().nonnegative().nullable(),
  /** The draft's own version, which publishing refuses where it is behind. */
  draft: z.int().nonnegative().nullable(),
  /**
   * Whether the steps below are a draft's, a published snapshot's, or absent.
   *
   * **Said rather than inferred from `draft`.** The two are the same shape and
   * completely different things — one is a file nothing runs and the only
   * thing an edit can reach, the other is what a run points at and never
   * changes — and a row that did not say which would make `v3` mean two things
   * on one screen.
   */
  shows: z.enum(['draft', 'published', 'nothing']),
  /** The draft's content hash, which is also the revision an edit echoes back. */
  rev: z.string().nullable(),
  title: SaidSchema.nullable(),
  about: SaidSchema.nullable(),
  /** Which input names the repository, which becomes the sentence, which the suffix. */
  projectInput: z.string().nullable(),
  saidInput: z.string().nullable(),
  nameSuffix: z.string().nullable(),
  inputs: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.enum(INPUT_KINDS),
      required: z.boolean(),
      about: SaidSchema.nullable(),
    }),
  ),
  steps: z.array(WorkflowStepSchema),
  /** The form for the template itself, beside each step's own. */
  fields: z.array(WorkflowFieldSchema),
  /** What publishing would refuse, and what it would warn about. */
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The shape the steps resolve to: the columns, and what each one hangs off. */
  places: z.array(PlaceSchema),
  /** How many runs point at a published version of it. */
  runs: z.int().nonnegative(),
  /** Whether this device may save a field of its draft, and why not where it may not. */
  editable: z.boolean(),
  /** The acts that stay at this machine, each with its one clause. */
  locally: z.array(LocallySchema),
})
export type WorkflowRow = z.infer<typeof WorkflowRowSchema>
