import type { TaskState } from '@tade/core'
import { markGlyph } from './model.ts'
import type { PlanTone } from './plan-graph.ts'

// The plans, folded for the window's Plans screen: how a plan's steps divide,
// where a plan stands, which group it is drawn in, and what is happening in it
// now.
//
// **A plan is an effort and nothing new** (`effortsIn`): one ordinary task per
// repository, grouped by the fold of the task files that name it, the edges
// the `start.after` the queue's own rule reads. The rows come out of the same
// folds the away view's Plans page reads (`runsIn` over `runTasks`, then the
// rollups `runRow` makes — `wire/plans.ts`), and the rules here are that
// page's own (`web/src/assets/pages/runs-shape.js`), copied because a browser
// cannot import a `.ts` file and held equal by `test/plans.test.ts`. So a
// phone and the window never disagree about which plan wants you.
//
// **Nothing here decides a state.** A step's state is `deriveState`'s and the
// journal's; every fold here starts from it and only counts, orders or picks.
// Pure: rows in, numbers and words out.

/** One step of a plan: one task, as `runTasks` reads it. */
export interface PlanStep {
  task: string
  project: string
  name: string
  state: TaskState
  /** How deep it is in the plan: nought waits on nothing in it (`layersOf`). */
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

/** One plan, with the rollups that make it readable at a glance (`runRow`'s). */
export interface PlanRow {
  run: string
  projects: readonly string[]
  steps: readonly PlanStep[]
  finished: number
  total: number
  from: { item: string; source: string } | null
  stamp: { name: string; version: number } | null
  /** Deliveries retried before the plan existed. */
  retries: number
  checks: 'pass' | 'fail' | 'unknown'
  usd: number | null
}

/** The parts a plan's steps fall into, in the order progress reads. */
export type Part = 'finished' | 'review' | 'working' | 'wants' | 'failed' | 'waiting' | 'parked'

/**
 * The parts, with their word. `always` parts are counted at nought — *nothing
 * failed* is a fact — and the rest appear only where a step is in them.
 */
export const PARTS: readonly { key: Part; label: string; always: boolean }[] = [
  { key: 'finished', label: 'finished', always: true },
  { key: 'review', label: 'in review', always: false },
  { key: 'working', label: 'working', always: true },
  { key: 'wants', label: 'wants you', always: true },
  { key: 'failed', label: 'failed', always: true },
  { key: 'waiting', label: 'waiting', always: true },
  { key: 'parked', label: 'parked', always: false },
]

/** A state's part, as the page's `taskMark` words it: `queued` and anything else is waiting. */
const PART_OF_STATE: Partial<Record<string, Part>> = {
  working: 'working',
  blocked: 'wants',
  failed: 'failed',
  review: 'review',
  merged: 'review',
  parked: 'parked',
}

/**
 * Which part one step is in: finished when the journal says so, working while
 * an agent is on it, and otherwise its state's.
 */
export function partOf(step: PlanStep): Part {
  if (step.finished) return 'finished'
  if (step.active) return 'working'
  return PART_OF_STATE[step.state] ?? 'waiting'
}

/** A part's word. */
export function partWord(part: Part): string {
  return PARTS.find((one) => one.key === part)?.label ?? part
}

/** How many steps are in each part, a part nobody is in left out unless it is `always`. */
export function partsOf(steps: readonly PlanStep[]): { key: Part; label: string; n: number }[] {
  const counts = new Map<Part, number>(PARTS.map((one) => [one.key, 0]))
  for (const step of steps) {
    const part = partOf(step)
    counts.set(part, (counts.get(part) ?? 0) + 1)
  }
  return PARTS.filter((one) => one.always || (counts.get(one.key) ?? 0) > 0).map((one) => ({
    key: one.key,
    label: one.label,
    n: counts.get(one.key) ?? 0,
  }))
}

/** Where a plan stands, loudest first, and which group that puts it in. */
export type Standing = 'wants' | 'failed' | 'working' | 'review' | 'waiting' | 'finished' | 'unseen'

export const STANDINGS: Readonly<Record<Standing, { word: string; group: Group }>> = {
  wants: { word: 'wants you', group: 'needs' },
  failed: { word: 'a step failed', group: 'needs' },
  working: { word: 'working', group: 'going' },
  review: { word: 'in review', group: 'going' },
  waiting: { word: 'waiting', group: 'going' },
  finished: { word: 'finished', group: 'finished' },
  unseen: { word: 'no steps left', group: 'unseen' },
}

/**
 * What a plan is wearing: a step that wants somebody, then one that failed,
 * then one at work; finished only when every step is. A plan with no step
 * says *that*, never *finished* — nought of nought is not done.
 */
export function standingOf(plan: PlanRow): Standing {
  if (plan.steps.length === 0) return 'unseen'
  const parts = new Set(plan.steps.map(partOf))
  for (const loud of ['wants', 'failed', 'working'] as const) if (parts.has(loud)) return loud
  if (plan.total > 0 && plan.finished === plan.total) return 'finished'
  const open = plan.steps.filter((step) => !step.finished).map(partOf)
  if (open.length > 0 && open.every((one) => one === 'review')) return 'review'
  return 'waiting'
}

export type Group = 'needs' | 'going' | 'finished' | 'unseen'

/** The groups, in the order they are drawn. A group with nothing in it is not drawn. */
export const GROUPS: readonly { key: Group; heading: string }[] = [
  { key: 'needs', heading: 'NEEDS YOU' },
  { key: 'going', heading: 'UNDER WAY' },
  { key: 'finished', heading: 'FINISHED' },
  { key: 'unseen', heading: 'NOTHING LEFT' },
]

/**
 * The plans in the order the page lists them — what is not finished first,
 * then by name — and each in its group, that order kept inside a group.
 */
export function groupsOf(
  plans: readonly PlanRow[],
): { key: Group; heading: string; plans: PlanRow[] }[] {
  const into = new Map<Group, PlanRow[]>(GROUPS.map((one) => [one.key, []]))
  for (const plan of listed(plans)) into.get(STANDINGS[standingOf(plan)].group)?.push(plan)
  return GROUPS.map((one) => ({ ...one, plans: into.get(one.key) ?? [] }))
}

/** What is not finished first, then by name: the store's own order (`runsOf`). */
export function listed(plans: readonly PlanRow[]): PlanRow[] {
  const done = (plan: PlanRow) => (plan.total > 0 && plan.finished === plan.total ? 1 : 0)
  return [...plans].sort(
    (a, b) => done(a) - done(b) || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0),
  )
}

/** The numbers the screen leads with, over every plan: how they stand, and every step. */
export function overallOf(plans: readonly PlanRow[]): {
  plans: number
  needs: number
  going: number
  finished: number
  unseen: number
  steps: number
  done: number
  parts: { key: Part; label: string; n: number }[]
} {
  const standing = plans.map(standingOf)
  const count = (group: Group) => standing.filter((one) => STANDINGS[one].group === group).length
  const steps = plans.flatMap((plan) => plan.steps)
  return {
    plans: plans.length,
    needs: count('needs'),
    going: count('going'),
    finished: count('finished'),
    unseen: count('unseen'),
    steps: steps.length,
    done: steps.filter((step) => step.finished).length,
    parts: partsOf(steps),
  }
}

const LOUDNESS: readonly Part[] = ['wants', 'failed', 'working']

/**
 * What a plan's steps are doing, loudest first: every step that wants
 * somebody, has failed or is at work — and, where nothing is, the steps
 * waiting and how many they wait on. At most `room`, and how many more are
 * open. A wait counts only what is not finished yet; a step whose waits are
 * all finished is `queued`, the queue's word, never *ready*.
 */
export function nowOf(
  plan: PlanRow,
  room = 3,
): {
  lines: { task: string; name: string; project: string; part: Part; said: string }[]
  more: number
} {
  const loud = plan.steps
    .filter((step) => LOUDNESS.includes(partOf(step)))
    .sort((a, b) => LOUDNESS.indexOf(partOf(a)) - LOUDNESS.indexOf(partOf(b)))
  const lines =
    loud.length > 0
      ? loud
      : plan.steps.filter((step) => partOf(step) === 'waiting').sort((a, b) => a.layer - b.layer)
  const names = shortNamesOf(plan.steps)
  const shown = lines.slice(0, room).map((step) => ({
    task: step.task,
    name: names.get(step.task) ?? step.name,
    project: step.project,
    part: partOf(step),
    said: clauseOf(step, plan),
  }))
  const open = plan.steps.filter((step) => !step.finished).length
  return { lines: shown, more: Math.max(0, open - shown.length) }
}

function clauseOf(step: PlanStep, plan: PlanRow): string {
  const part = partOf(step)
  if (part === 'wants') return 'wants you'
  if (part === 'failed') return 'failed'
  if (part === 'working') return 'working'
  const open = waitsOf(step, plan).filter((one) => !one.finished).length
  return open === 0 ? 'queued' : `waits on ${open}`
}

/**
 * What one step waits on, each with whether it has finished — by name where it
 * is in the plan and by its task id where it is not, because a wait on work
 * outside the plan is still a wait.
 */
export function waitsOf(
  step: PlanStep,
  plan: PlanRow,
): {
  task: string
  name: string
  finished: boolean
  seen: boolean
  part: Part | 'unseen'
  why: string
}[] {
  const byTask = new Map(plan.steps.map((one) => [one.task, one]))
  const names = shortNamesOf(plan.steps)
  return step.waits.map((wait) => {
    const on = byTask.get(wait.task)
    return {
      task: wait.task,
      name: names.get(wait.task) ?? wait.task,
      finished: on?.finished ?? false,
      seen: on !== undefined,
      part: on === undefined ? 'unseen' : partOf(on),
      why: wait.why,
    }
  })
}

const CUTS = ['-', '_', '/', '.', ' ']

/**
 * Each step's name without the front every step shares — `checkout-v2-schema`
 * is `schema` — cut at a word's end, and only where every step keeps a name.
 */
export function shortNamesOf(steps: readonly PlanStep[]): Map<string, string> {
  const out = new Map(steps.map((step) => [step.task, step.name]))
  const first = steps[0]
  if (steps.length < 2 || first === undefined) return out
  let shared = first.name
  for (const step of steps) {
    while (!step.name.startsWith(shared)) shared = shared.slice(0, -1)
  }
  const cut = Math.max(...CUTS.map((one) => shared.lastIndexOf(one)))
  if (cut <= 0) return out
  const front = shared.slice(0, cut + 1)
  if (steps.some((step) => step.name.length <= front.length)) return out
  for (const step of steps) out.set(step.task, step.name.slice(front.length))
  return out
}

/**
 * A plan's steps by layer, each layer with how many of its steps finished and
 * what it waits on. Numbered from the steps' own `layer`.
 */
export function stagesOf(plan: PlanRow): {
  layer: number
  name: string
  said: string
  steps: PlanStep[]
  done: number
}[] {
  const layers = [...new Set(plan.steps.map((step) => step.layer))].sort((a, b) => a - b)
  return layers.map((layer) => {
    const steps = plan.steps.filter((step) => step.layer === layer)
    return {
      layer,
      name: `Stage ${layer + 1}`,
      said: layer === 0 ? 'can go first' : stageWaits(steps, plan),
      steps,
      done: steps.filter((step) => step.finished).length,
    }
  })
}

function stageWaits(steps: readonly PlanStep[], plan: PlanRow): string {
  const layerOf = new Map(plan.steps.map((step) => [step.task, step.layer]))
  const waits = steps.flatMap((step) => step.waits.map((wait) => wait.task))
  const before = new Set(
    waits.map((task) => layerOf.get(task)).filter((one): one is number => one !== undefined),
  )
  const unseen = [...new Set(waits.filter((task) => !layerOf.has(task)))].sort()
  const stages = [...before].sort((a, b) => a - b).map((one) => `stage ${one + 1}`)
  const all = [...stages, ...unseen]
  return all.length === 0 ? 'can go first' : `after ${joinedWords(all)}`
}

function joinedWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** A check rollup's word, as the page says it. */
export const CHECK_WORDS: Readonly<Record<PlanRow['checks'], string>> = {
  pass: 'green',
  fail: 'red',
  unknown: 'not run here',
}

/**
 * One step in a line: its checks, its review, and how many agents have been on
 * it — the retry history, a count of `run_started` lines and no counter.
 */
export function stepSays(step: PlanStep): string {
  const bits = [`checks ${CHECK_WORDS[step.checks]}`]
  if (step.review !== null) bits.push(`review ${step.review}`)
  if (step.runs > 1) bits.push(`${step.runs} agents have been on it`)
  if (step.parked) bits.push('set aside')
  return bits.join(' · ')
}

/**
 * One plan in a line: what is happening, retries, the workflow it came from.
 * Its cost is the caller's, which knows how a figure is drawn.
 */
export function planSays(plan: PlanRow): string {
  const active = plan.steps.filter((step) => step.active)
  const waiting = plan.steps.filter((step) => !step.finished && !step.active)
  const bits: string[] = []
  if (active.length > 0) bits.push(`${active.map((step) => step.name).join(', ')} working`)
  else if (waiting.length > 0) bits.push(`${waiting.length} waiting`)
  else if (plan.total > 0) bits.push('every step finished')
  if (plan.retries > 0)
    bits.push(`${plan.retries} delivery ${plan.retries === 1 ? 'retry' : 'retries'}`)
  if (plan.stamp !== null) bits.push(`${plan.stamp.name}@${plan.stamp.version}`)
  return bits.join(' · ')
}

/** How each part is marked: the window's own glyphs (`markGlyph`), so a step reads as its agent does. */
export function partGlyph(part: Part | 'unseen', now: number): string {
  switch (part) {
    case 'finished':
    case 'review':
      return markGlyph('done')
    case 'working':
      return markGlyph('working', now)
    case 'wants':
      return markGlyph('needs-you')
    case 'failed':
      return markGlyph('failed')
    case 'parked':
      return markGlyph('parked')
    case 'waiting':
      return markGlyph('queued')
    default:
      return '○'
  }
}

/** How each part is painted, named by what it is: `MARK_TONES`' words. */
export function partTone(part: Part | 'unseen'): PlanTone {
  switch (part) {
    case 'finished':
    case 'review':
      return 'done'
    case 'working':
      return 'busy'
    case 'wants':
      return 'waiting'
    case 'failed':
      return 'bad'
    case 'parked':
      return 'faded'
    default:
      return 'hint'
  }
}

/** A plan's own mark: the part its standing is loudest about. */
export const STANDING_PART: Readonly<Record<Standing, Part | 'unseen'>> = {
  wants: 'wants',
  failed: 'failed',
  working: 'working',
  review: 'review',
  waiting: 'waiting',
  finished: 'finished',
  unseen: 'unseen',
}
