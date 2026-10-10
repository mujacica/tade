import {
  type Config,
  contentHash,
  draftYaml,
  INTAKE_SOURCES,
  type InboxRow,
  type IntakeSource,
  type Persona,
  readPublished,
  readTemplates,
  type Schedule,
  type SourceStanding,
  type SourceWatch,
  sourcesStanding,
  type Template,
  templateProblems,
  type Watched,
  watchedFrom,
} from '@tade/core'
import type { WatchOffer } from '@tade/extensions-core'
import { BUDGET, type IntakeIn, type SourceIn, type WorkflowIn, type WouldIn } from '@tade/web'
import { intakeGrant, intakeWouldRun, materialOf, type TemplateDeps } from '@tade/workbench'
import {
  type IntakeBody,
  intakeIn,
  intakeTitles,
  sourcesIn,
  type WorkflowHeld,
  workflowsIn,
} from '../away-factory.ts'
import type { FactoryHeld, RunFrom } from './web-beat.ts'

// The factory floor, folded once and handed to the away view.
//
// **A fold the window keeps, not work a request starts.** The rule the away
// view is held to is that no handler does any work and nothing is built for
// nobody: every read answers from what the window already has. The inbox is
// already that — a fold of the journal and the task files, refolded when a line
// that could change it is written — and this adds the three things a factory
// floor needs that the inbox fold did not have:
//
// 1. **The bodies.** `materialOf` reads the context file Tade wrote, once per
//    request, kept by the request *and its hash* — so a request somebody
//    edited is read again and one that has not moved is not. Tade keeps no
//    second copy of a stranger's words, so this is the only place they are.
// 2. **The doors.** A grant out of the config, the watch that looks with it out
//    of the extension host, and that watch's own looks out of the journal.
//    Together they are the difference between *nothing has been handed over*
//    and *this connector has been answering 429 since Tuesday*.
// 3. **The workflows and what approving would start.** The workflows are the
//    files plus `templateProblems` and `workflowPlaces`, both pure; what
//    approving would start is `intakeWouldRun`, which **describes the work that
//    exists** rather than simulating work that does not.
//
// **Two clocks, because the two things change on two clocks.** The inbox
// refolds on a journal line; a template changes when somebody edits a *file*,
// which writes no line at all. So the templates are read again at most every
// `TEMPLATES_EVERY` — rather than a watcher on a directory, which is a second
// lifetime to get wrong.

/** How often the templates are read again, at most. */
export const TEMPLATES_EVERY = 30_000

/**
 * The doors, folded out of the config, the watches and the journal.
 *
 * **Pure once it is handed those three**, which is what lets the nine states be
 * tested exhaustively: `sourceStandingOf` decides and this is only the
 * gathering. A source with no watch is `unwatched` rather than missing from the
 * list — a door nobody looks through is still a door, and its absence from a
 * list is exactly the silence this collection exists to break.
 */
export function doorsOf(parts: {
  config: Config
  events: readonly { type: string; detail: Record<string, unknown> }[]
  schedules: readonly (Schedule & { paused?: boolean })[]
  watches: readonly WatchOffer[] | null
}): SourceStanding[] {
  const watched = new Map<string, Watched>()
  return sourcesStanding(INTAKE_SOURCES, (source) => ({
    grant: intakeGrant(parts.config, source as IntakeSource),
    watch: watchFor(source, parts, watched),
  }))
}

/** The watch that looks with one source, and what it has done. */
function watchFor(
  source: string,
  parts: {
    events: readonly { type: string; detail: Record<string, unknown> }[]
    schedules: readonly (Schedule & { paused?: boolean })[]
    watches: readonly WatchOffer[] | null
  },
  watched: Map<string, Watched>,
): SourceWatch | null {
  // **The watch declares which source it is** (`WatchOffer.intake`), rather
  // than a name being matched: the thing that reads a source is what knows
  // which one, and guessing from an id would break the first time somebody
  // named one differently.
  const offer = (parts.watches ?? []).find((one) => one.intake === source) ?? null
  if (offer === null) return null
  const schedule =
    parts.schedules.find((one) => one.does.kind === 'watch' && one.does.watch === offer.id) ?? null
  if (schedule === null) {
    return { id: offer.id, schedule: '', every: offer.every, paused: false, watched: null }
  }
  const held = watched.get(schedule.id) ?? watchedFrom(parts.events as never, schedule.id)
  watched.set(schedule.id, held)
  return {
    id: offer.id,
    schedule: schedule.id,
    every: schedule.when.every ?? offer.every,
    paused: schedule.paused === true,
    watched: held,
  }
}

/** Every title a watch found, by the request it is about. */
export function titlesOf(
  events: readonly { type: string; detail: Record<string, unknown> }[],
): Map<string, string> {
  const found: { key: string; title: string }[] = []
  for (const event of events) {
    if (event.type !== 'watch_found') continue
    const key = event.detail.key
    const title = event.detail.title
    if (typeof key !== 'string' || typeof title !== 'string') continue
    found.push({ key, title })
  }
  return intakeTitles(found)
}

/**
 * The bodies, read once each and kept by the request and its hash.
 *
 * Keyed by both because the hash is the whole point of keeping one: a request
 * somebody edited after Tade made work for it has a new hash, so it is read
 * again, and one that has not moved is never read twice. A read that failed is
 * kept too — as its own sentence — because retrying a missing file on every
 * fold is a file read per request per journal line.
 */
export class Bodies {
  private readonly held = new Map<string, IntakeBody>()

  /** Read whatever is not held yet. Awaited off the drawing thread. */
  async fill(home: string, rows: readonly InboxRow[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.item}@${row.hash}`
      if (this.held.has(key)) continue
      const read = await materialOf(home, row).catch((err: unknown) => ({
        body: null,
        problem: `the request could not be read: ${String(err).slice(0, 200)}`,
      }))
      this.held.set(key, { body: read.body, problem: read.problem })
    }
    // Anything whose request is gone or has moved on: dropped, so the map does
    // not grow with every edit anybody ever makes to a ticket.
    const wanted = new Set(rows.map((row) => `${row.item}@${row.hash}`))
    for (const key of [...this.held.keys()]) if (!wanted.has(key)) this.held.delete(key)
  }

  /** What is held, by the request's own item key. */
  byItem(rows: readonly InboxRow[]): Map<string, IntakeBody> {
    const out = new Map<string, IntakeBody>()
    for (const row of rows) {
      const held = this.held.get(`${row.item}@${row.hash}`)
      if (held !== undefined) out.set(row.item, held)
    }
    return out
  }
}

/** Which requests are worth working out an answer for: the ones waiting on somebody. */
export const DECIDABLE: readonly InboxRow['state'][] = ['proposed', 'held']

/**
 * What approving each waiting request would start.
 *
 * **Only the ones somebody is being asked to decide about.** Working one out
 * reads a task file per task and folds the journal for what is busy, so doing
 * it for every answered request on every refold is work nobody asked for — and
 * for a request nobody can approve the answer is already on the row
 * (`because`, out of `whyNotAct`).
 *
 * `plans: null` is the honest answer and not a gap: only the process
 * supervising the agents can read a plan window, and this runs in it — but the
 * away view's own money is the `spend` grant's, and `limits` is where the
 * figures are, so the window's plan standing is left for the Spend screen
 * rather than folded into a sentence a device may not be allowed to read.
 */
export async function wouldOf(
  deps: TemplateDeps,
  rows: readonly InboxRow[],
): Promise<Map<string, WouldIn>> {
  const out = new Map<string, WouldIn>()
  for (const row of rows) {
    if (!DECIDABLE.includes(row.state)) continue
    const would = await intakeWouldRun(deps, row, null).catch((err: unknown) => ({
      starts: [],
      grant: [],
      limits: [],
      // Not swallowed: a preview that could not be worked out is a preview
      // nobody should read as *nothing would happen*.
      problems: [
        `what approving it would start could not be worked out: ${String(err).slice(0, 200)}`,
      ],
      warnings: [],
    }))
    out.set(row.item, {
      starts: would.starts.map((start) => ({
        task: start.task,
        project: start.project,
        workspace: start.workspace,
        done: start.done,
        produces: start.produces,
        touches: [...start.touches],
        after: start.after.map((wait) => ({ task: wait.task, why: wait.why ?? '' })),
        parked: start.parked,
      })),
      grant: [...would.grant],
      limits: [...would.limits],
      problems: [...would.problems],
      warnings: [...would.warnings],
    })
  }
  return out
}

/**
 * Every workflow there is, read off disk, with its draft validated.
 *
 * **No dry run of a template here**, and that is a decision rather than a gap:
 * a dry run needs the inputs somebody filled in, nobody has asked for a run
 * yet, and one filled with invented values would say a run would happen
 * somewhere it would not. What a template can honestly preview is its *shape*
 * — `workflowPlaces`, pure, taken in `workflowsIn` — and the dry run proper
 * belongs to a request, where the inputs are real.
 */
export async function workflowsRead(
  home: string,
  config: Config,
  runs: ReadonlyMap<string, number>,
  drafting: boolean,
): Promise<WorkflowHeld[]> {
  const { templates } = await readTemplates(home)
  const held: WorkflowHeld[] = []
  for (const one of templates) {
    // **Which template the steps are of is said rather than left to be
    // guessed.** A draft is a file nothing runs and is the one thing an edit
    // can reach; a published snapshot is what a run points at and never
    // changes. Where there is a draft the steps are its, and where there is
    // only a published version they are that version's — and `shows` is how a
    // reader is told which, because *v3* meaning two different things on one
    // screen is the one ambiguity this row must not have.
    const draft = one.draft
    const published =
      draft === null && one.versions.length > 0
        ? await readPublished(home, one.name).catch(() => null)
        : null
    const snapshot = published !== null && 'template' in published ? published.template : null
    const template = draft?.ok === true ? draft.template : snapshot
    const shows: WorkflowHeld['shows'] =
      draft?.ok === true ? 'draft' : template === null ? 'nothing' : 'published'
    held.push({
      name: one.name,
      builtIn: one.builtIn,
      versions: [...one.versions],
      draft: template,
      shows,
      // A revision only where there is something to save against: a published
      // snapshot has none here, so there is nothing for an edit to echo and
      // the control is absent rather than refused.
      rev: shows === 'draft' && template !== null ? contentHash(draftYaml(template)) : '',
      // A draft that will not parse is not a draft with no problems: what
      // `readTemplates` said about it is what a reader needs, rather than an
      // empty list that reads as *it would publish as it stands*.
      ...(draft !== null && !draft.ok
        ? { problems: [...draft.problems], warnings: [] }
        : checkedOf(template, config)),
      runs: runs.get(one.name) ?? 0,
      // A workflow Tade ships has its bytes in Tade's own source, so there is
      // no draft to save and `writeDraft` refuses one by name — said here as a
      // fact rather than discovered at the save.
      editable: drafting && shows === 'draft' && !one.builtIn,
    })
  }
  return held
}

/** What the validator said about one draft. */
function checkedOf(
  template: Template | null,
  _config: Config,
): { problems: string[]; warnings: string[] } {
  if (template === null) return { problems: [], warnings: [] }
  // The personas are **deliberately not read here**: `templateProblems` with
  // none says a step naming one cannot be resolved, which is a problem a
  // reader should see rather than a silence. Publishing folds the real ones in
  // and refuses the same way (`publishTemplate`), so what a phone is told is
  // never softer than what publishing would say.
  const personas: ReadonlyMap<string, Persona> = new Map()
  const checked = templateProblems(template, { personas })
  return { problems: [...checked.problems], warnings: [...checked.warnings] }
}

/**
 * Which request each run came from, and what it was stamped from.
 *
 * Out of the inbox rather than out of the task files, because the task files do
 * not say: an effort is a name several tasks share, and which *request* made
 * them is the journal's answer. A run nobody asked for from outside has no
 * entry, which is the honest shape — most runs are the owner's own.
 */
export function runsFromOf(
  rows: readonly InboxRow[],
  efforts: ReadonlyMap<string, string>,
): Map<string, RunFrom> {
  const out = new Map<string, RunFrom>()
  for (const row of rows) {
    const effort = row.tasks.map((task) => efforts.get(task) ?? '').find((name) => name !== '')
    if (effort === undefined || out.has(effort)) continue
    out.set(effort, {
      item: row.item,
      source: row.source,
      stamp: row.template === null ? null : { ...row.template },
      retries: row.attempts,
    })
  }
  return out
}

/** The whole fold, as the away view takes it. */
export function factoryHeld(parts: {
  rows: readonly InboxRow[]
  bodies: ReadonlyMap<string, IntakeBody>
  titles: ReadonlyMap<string, string>
  efforts: ReadonlyMap<string, string>
  would: ReadonlyMap<string, WouldIn>
  doors: readonly SourceStanding[]
  workflows: readonly WorkflowHeld[]
}): FactoryHeld {
  const intake: readonly IntakeIn[] = intakeIn(parts.rows, {
    bodies: parts.bodies,
    titles: parts.titles,
    efforts: parts.efforts,
    would: parts.would,
    most: BUDGET.materials,
  })
  const sources: readonly SourceIn[] = sourcesIn(parts.doors)
  const workflows: readonly WorkflowIn[] = workflowsIn(parts.workflows)
  return { intake, sources, workflows, runFrom: runsFromOf(parts.rows, parts.efforts) }
}
