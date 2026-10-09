import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Config,
  checkBudget,
  checkPlan,
  type DryRun,
  dryRunOf,
  type EventFilter,
  fillTemplate,
  noSpend,
  type Plan,
  type PlanBusy,
  pricesFrom,
  projectDir,
  projectsIn,
  provenanceOf,
  readDraft,
  readPersonas,
  readPublished,
  spendFrom,
  startOfToday,
  type TadeEvent,
  workspaceFor,
} from '@tade/core'
import type { PlanMade } from './plans.ts'
import { readTaskFile } from './tasks.ts'
import type { Workbench } from './workbench.ts'

// Stamping a stored workflow out, and asking what it would do without doing it.
//
// Two doors, and the difference between them is the whole of the safety here:
// `dryRunTemplate` needs no window, writes nothing, starts nothing and reaches
// no driver — it is a question, and questions never need the window;
// `useTemplate` needs the workbench, because it makes tasks, and it makes them
// **parked**.
//
// **It launches through the plan path that already exists.** `tade.planTasks`
// → `makePlan` → `checkPlan` → `createTask`, exactly as the orchestrator's own
// `tade_plan` does, with the same refusals in the same order. There is no
// second scheduler, no second validator and no second way into the queue. The
// template's only contribution is the shape and the words.
//
// **Nothing starts.** A task with a `start` condition is queued work, and the
// window starts queued work by rule — so a template that made tasks and walked
// away would be a stored shape that starts agents. Every task it makes is
// parked, which is the hold a person lifts, one at a time or all at once, and
// which `queueStateOf` reads ahead of everything but a merge. The queue is
// still the executor; it just has nothing to do until somebody says so.
//
// **A template is not a transaction.** If a plan is refused, nothing is made —
// `checkPlan` refuses whole. If a task made from one later fails, the rest are
// held with the reason and a person answers: there is nothing to roll back,
// because the commits are real.

/** What reading a template needs, which is a home, a config and the journal. */
export interface TemplateDeps {
  home: string
  config: Config
  events(filter: EventFilter): Promise<readonly TadeEvent[]>
}

/**
 * What could not be read, said rather than swallowed.
 *
 * Every read below goes through this, and each one names what the answer is
 * missing as a result — because the alternative is a dry run that reports an
 * unreadable journal as an empty one, which reads as "nothing is running and
 * nothing has been spent". A figure nobody could read is never nought.
 */
export type Unread = (said: string) => void

/** Every task Tade has, in every project, folded out of the journal. */
export async function tasksFrom(deps: TemplateDeps, unread?: Unread): Promise<Set<string>> {
  // The same fold `makePlan` does, for the same reason: a dry run that
  // disagreed with the thing that would actually refuse would be worse than no
  // dry run at all.
  const created = await deps.events({ types: ['task_created', 'task_removed'] }).catch((err) => {
    unread?.(
      `Could not read the journal (${String(err?.message ?? err)}), so a wait on a task Tade already has would be refused as unknown rather than kept.`,
    )
    return []
  })
  const tasks = new Set<string>()
  for (const event of created) {
    if (!event.task) continue
    if (event.type === 'task_created') tasks.add(event.task)
    else tasks.delete(event.task)
  }
  return tasks
}

/**
 * Work the projects already have that a plan cannot see, read off the task
 * files rather than out of a live window.
 *
 * What a queued or working task says it will touch is in its own task file, so
 * this is answerable without the workbench — which is what lets a dry run from
 * a command line warn about the same collisions the window would. A task
 * nobody has started and nobody parked is queued work; a parked one is not
 * going anywhere, so it is not in anybody's way.
 */
export async function busyFrom(
  deps: TemplateDeps,
  projects: readonly string[],
  unread?: Unread,
): Promise<PlanBusy[]> {
  const done = new Set<string>()
  const finished = await deps.events({ types: ['task_done'] }).catch((err) => {
    unread?.(
      `Could not read the journal (${String(err?.message ?? err)}), so work that has already finished may be listed as being in the way.`,
    )
    return []
  })
  for (const event of finished) {
    if (event.task) done.add(event.task)
  }
  const busy: PlanBusy[] = []
  for (const project of projects) {
    const root = join(projectDir(deps.home, project), 'tasks')
    let folders: string[]
    try {
      folders = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      // A project Tade has not made a task in yet, and nothing is wrong.
      continue
    }
    for (const folder of folders.sort()) {
      const id = `${project}/${folder}`
      const file = await readTaskFile(deps.home, id)
      if (!file || file.parked) continue
      const touches = file.start?.touches ?? []
      if (touches.length === 0 || done.has(id)) continue
      busy.push({ task: id, said: file.start ? 'queued' : 'working', touches })
    }
  }
  return busy
}

/** What each project has spent today against what it said it may. */
async function budgetFrom(
  deps: TemplateDeps,
  projects: readonly string[],
  unread: Unread,
): Promise<{ project: string; said: string }[]> {
  // Not caught to an empty list: with no usage read, `checkBudget` answers
  // `ok` and the dry run would say "inside its budget for today" about a
  // journal nobody could open. The projects with a budget are dropped from the
  // list instead, and the reason is said above them.
  let usage: readonly TadeEvent[]
  try {
    usage = await deps.events({ types: ['usage'] })
  } catch (err) {
    unread(
      `Could not read the journal (${String((err as Error)?.message ?? err)}), so what has been spent today is unknown — not nought, and nothing here says a budget is clear.`,
    )
    return []
  }
  const prices = pricesFrom(deps.config.prices)
  const spend = spendFrom(usage, { since: startOfToday(Date.now()), prices })
  const out: { project: string; said: string }[] = []
  for (const project of projects) {
    const budget = deps.config.projects[project]?.budget
    if (!budget) continue
    const state = checkBudget(spend.byProject[project] ?? noSpend(), budget)
    out.push({
      project,
      said: state.reason
        ? `${state.reason}${state.verdict === 'over' ? ' — a start would be refused' : state.verdict === 'warn' ? ' — near its budget' : ''}`
        : 'inside its budget for today',
    })
  }
  return out
}

export interface TemplateRequest {
  template: string
  /** The published version; the newest when none is named. */
  version?: number
  inputs: Readonly<Record<string, string>>
}

/**
 * Whether a draft nobody has published may be read.
 *
 * Only ever true for a person at this machine asking what their own draft
 * would do — which is the thing they are told to do *before* publishing, so
 * refusing it would make the advice impossible to follow. Nothing that stamps
 * a template out passes this, and `useTemplate` does not take it at all: what
 * the orchestrator may use is what somebody here has already published.
 */
export type DraftsToo = { drafts: boolean }

/**
 * What a template and its inputs would make — and it makes none of it.
 *
 * A published version by default, which is the only thing the orchestrator
 * gets. `drafts: true` falls back to the draft, and the answer says it is one:
 * a draft has no content hash, so everything it prints is marked unpublished.
 */
export async function dryRunTemplate(
  deps: TemplateDeps,
  req: TemplateRequest & Partial<DraftsToo>,
  /**
   * Where each sign-in stands against its plan, which only the process
   * supervising the agents can read. **Null, honestly, when nothing could** —
   * a plan window reported as empty is a plan window reported as having room.
   */
  plans: readonly string[] | null = null,
): Promise<DryRun | { problem: string }> {
  // The draft first where drafts are allowed, and that way round on purpose:
  // the person asking is the one about to publish, and they were told to
  // dry-run it *before* publishing. Preferring the published one meant
  // `check` read their new draft and `dry-run` read last week's version
  // without saying so — the one answer that makes the advice harmful. With no
  // draft there, the published one is what they meant. A named version is
  // always a published one: a draft has no version anybody can ask for.
  const asked =
    req.drafts && req.version === undefined ? await readDraft(deps.home, req.template) : null
  const published =
    asked && !('problem' in asked)
      ? asked
      : await readPublished(deps.home, req.template, req.version)
  if ('problem' in published) return published
  const { personas } = await readPersonas(deps.home)
  const projects = Object.keys(deps.config.projects)
  const provenance = provenanceOf(published)
  const fill = fillTemplate(published.template, {
    inputs: req.inputs,
    projects,
    workspace: (project) => workspaceFor(deps.config, project),
    home: deps.home,
    provenance,
    personas,
  })
  const reaches = fill.ok ? projectsIn(fill.plan) : []
  // Said once however many reads hit the same trouble: three sentences about
  // one unreadable journal is noise that hides the one that matters.
  const missed: string[] = []
  const unread: Unread = (said) => {
    if (!missed.includes(said)) missed.push(said)
  }
  const check = fill.ok
    ? checkPlan(fill.plan, {
        workspace: (project) => workspaceFor(deps.config, project),
        tasks: await tasksFrom(deps, unread),
        busy: await busyFrom(deps, reaches, unread),
      })
    : null
  return dryRunOf({
    provenance,
    template: published.template,
    fill,
    check,
    config: deps.config,
    personas,
    limits: { budget: await budgetFrom(deps, reaches, unread), plans, unread: missed },
  })
}

export interface TemplateUsed {
  made: PlanMade
  /** What it was made from, as a sentence: the version and the content hash. */
  from: string
  template: string
  version: number
  hash: string
}

/**
 * Stamp a template out: the ordinary plan path, and every task parked.
 *
 * Written down before anything is made is not possible here — the tasks are
 * what the line is about — so the line goes in after, naming the snapshot's own
 * content hash. That is the only thing that remembers *which* snapshot: a
 * draft moves on, and without this a task made in March reads as having come
 * from whatever the file says today.
 */
export async function useTemplate(
  tade: Workbench,
  req: TemplateRequest & { by?: string },
): Promise<TemplateUsed> {
  return stampTemplate(tade, await fillFor(tade, req), req.by)
}

/** A published template, resolved and filled in: everything before anything is made. */
export interface TemplateFilled {
  template: string
  version: number
  hash: string
  builtIn: boolean
  plan: Plan
  warnings: readonly string[]
  /** What `stampTemplate` would make, by id, which is what an idempotent caller checks first. */
  names: readonly string[]
}

/**
 * Resolve a published template, fill it in, and say what it *would* make —
 * without making any of it.
 *
 * Apart from `useTemplate`, which is this plus the next function, the one
 * caller is intake: a delivery interrupted between making tasks and writing
 * down that it made them has to be able to recognise its own work rather than
 * make a second copy of it, and it cannot do that without the names first.
 * Splitting it here rather than working the names out again from the template
 * keeps one answer to "what does this template make".
 */
export async function fillFor(tade: Workbench, req: TemplateRequest): Promise<TemplateFilled> {
  const home = tade.home
  const published = await readPublished(home, req.template, req.version)
  if ('problem' in published) throw new Error(published.problem)
  const { personas } = await readPersonas(home)
  const provenance = provenanceOf(published)
  const fill = fillTemplate(published.template, {
    inputs: req.inputs,
    projects: Object.keys(tade.config.projects),
    workspace: (project) => workspaceFor(tade.config, project),
    home,
    provenance,
    personas,
  })
  if (!fill.ok) {
    throw new Error(`${req.template} was not used: ${fill.problems.join('; ')}`)
  }
  return {
    template: published.template.template,
    version: published.template.version,
    hash: published.hash,
    builtIn: published.builtIn,
    plan: fill.plan,
    warnings: fill.warnings,
    names: [...fill.from.keys()],
  }
}

/** Make what a filled template says, through the plan path, with every task parked. */
export async function stampTemplate(
  tade: Workbench,
  filled: TemplateFilled,
  asked?: string,
): Promise<TemplateUsed> {
  const deps: TemplateDeps = {
    home: tade.home,
    config: tade.config,
    events: (filter) => tade.log.read(filter),
  }
  const published = {
    template: { template: filled.template, version: filled.version },
    hash: filled.hash,
    builtIn: filled.builtIn,
  }
  const fill = { plan: filled.plan, warnings: [...filled.warnings] }
  const by = asked ?? 'you'
  const made = await tade.planTasks(fill.plan, by, await busyFrom(deps, projectsIn(fill.plan)))
  // Parked one at a time rather than in one act, because parking is told per
  // task and `parkTask` is the one door that writes it. A park that failed
  // would leave a task that starts by itself, so the throw is not swallowed.
  for (const task of made.made) await tade.parkTask(task.id, true)
  await tade.log.append({
    type: 'template_used',
    detail: {
      template: published.template.template,
      version: published.template.version,
      hash: published.hash,
      built_in: published.builtIn,
      tasks: made.made.map((task) => task.id),
      parked: true,
      by,
    },
  })
  return {
    made,
    from: `${published.template.template}@${published.template.version} (${published.hash})`,
    template: published.template.template,
    version: published.template.version,
    hash: published.hash,
  }
}

/** What using one came to, for whoever has to say it back. */
export function usedSays(used: TemplateUsed): string {
  const ids = used.made.made.map((task) => task.id)
  const lines = [
    `Made ${ids.length} task${ids.length === 1 ? '' : 's'} from ${used.from}, and started nothing: ${ids.join(', ')}.`,
    'Every one of them is parked. Pick one up to let the queue start it.',
  ]
  for (const warning of used.made.warnings) lines.push(`Watch out: ${warning}.`)
  return lines.join('\n')
}
