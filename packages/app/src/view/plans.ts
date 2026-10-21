import { printable } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, sameTarget, type Target } from '../hits.ts'
import type { AppState } from '../model.ts'
import { drawPlan, drawWhy, type PlanBox, type PlanTone, type PlanWhy } from '../plan-graph.ts'
import {
  CHECK_WORDS,
  groupsOf,
  nowOf,
  overallOf,
  type PlanRow,
  type PlanStep,
  partGlyph,
  partOf,
  partsOf,
  partTone,
  partWord,
  planSays,
  STANDING_PART,
  STANDINGS,
  shortNamesOf,
  stagesOf,
  standingOf,
  stepSays,
  waitsOf,
} from '../plans.ts'
import type { Skin } from '../skin.ts'
import { blank, type Drawn, type Pointer, Row, stack } from '../ui.ts'
import { planPaint, planPicture } from './plan.ts'
import { paged } from './rows.ts'
import { dollars, shortened, wrapWords } from './text.ts'

// The Plans screen, where an agent's screen would be: every plan — what wants
// you first, then what is moving and how far along, then what is done — and,
// opened, one plan's own graph.
//
// The window's answer to the away view's Plans page (`runs.js`), out of the
// same folds (`plans.ts`, `wire/plans.ts`): every step in a row of marks with
// the parts counted under it, a card per plan still going — its whole graph
// drawn by `plan-graph.ts`, finished and running steps with the waiting ones,
// and what is happening in it now — and a quiet row per finished one. Opened,
// a plan is its facts, what in it wants you, its graph and every wait's
// reason, and its stages with every step and what each waits on.
//
// The graphs are scrolled sideways together, as one plan's picture is
// (`planPicture`), and the page up and down (`paged`): a plan is drawn in the
// room it needs, never folded into a list of names.

function paintOf(skin: Skin, tone: PlanTone): (text: string) => string {
  return planPaint(skin)[tone]
}

type Line = { text: string; hits: Hit[] }

/** The Plans screen: every plan, or the one `state.plans.effort` names. */
export function renderPlans(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const plans = frame.plans ?? null
  const effort = state.plans?.effort ?? null
  const one = effort === null ? null : (plans?.find((plan) => plan.run === effort) ?? null)
  const header = new Row(width, skin, pointer).space()
  if (effort === null) {
    header.text('plans', skin.you).space(2)
    if (plans !== null && plans.length > 0) {
      const all = overallOf(plans)
      header.text(
        [
          `${all.plans} ${all.plans === 1 ? 'plan' : 'plans'}`,
          ...(all.needs > 0 ? [`${all.needs} ${all.needs === 1 ? 'needs' : 'need'} you`] : []),
          ...(all.going > 0 ? [`${all.going} under way`] : []),
          ...(all.finished > 0 ? [`${all.finished} finished`] : []),
        ].join(' · '),
        skin.hint,
      )
    }
  } else {
    header.button('‹ plans', { kind: 'action', name: 'plans' }).space(2)
    header.text(printable(effort), skin.you).space(2)
    if (one !== null) {
      header.text(
        `${one.finished}/${one.total} steps finished · ${STANDINGS[standingOf(one)].word}`,
        skin.hint,
      )
    }
  }
  const top = [header.build(), { text: skin.chrome('─'.repeat(width)), hits: [] }]
  const page = (room: number): Line[] => {
    if (plans === null) return [blank(room), said(room, skin, pointer, 'looking…')]
    if (effort === null) return listPage(state, frame, plans, room, skin, pointer)
    if (one === null)
      return [
        blank(room),
        said(room, skin, pointer, 'No plan by that name: none of its task files is left.'),
      ]
    return planPage(state, frame, one, room, skin, pointer)
  }
  const room = Math.max(0, height - top.length)
  const shown = stack([...top, ...paged(page, room, width, 'page', state, skin)].slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}

function said(width: number, skin: Skin, pointer: Pointer, text: string): Line {
  return new Row(width, skin, pointer).space(2).text(text, skin.hint).build()
}

/** A heading on the page, and how many are under it. */
function heading(width: number, skin: Skin, pointer: Pointer, label: string, n?: number): Line {
  const r = new Row(width, skin, pointer).space(2).text(label, skin.label)
  if (n !== undefined) r.space(2).text(String(n), skin.hint)
  return r.build()
}

/**
 * Every step as a row of marks — finished first, as progress reads — and the
 * parts counted under it: the page's ring, in a terminal's cells.
 */
function progress(
  steps: readonly PlanStep[],
  done: number,
  width: number,
  skin: Skin,
  pointer: Pointer,
  now: number,
): Line[] {
  const parts = partsOf(steps)
  const room = Math.max(1, width - 16)
  const marks: { glyph: string; tone: PlanTone }[] = []
  for (const part of parts) {
    for (let i = 0; i < part.n; i++) {
      marks.push({ glyph: partGlyph(part.key, now), tone: partTone(part.key) })
    }
  }
  const r = new Row(width, skin, pointer).space(2)
  // More steps than columns are said as a figure, never cut silently.
  for (const mark of marks.slice(0, room)) r.text(mark.glyph, paintOf(skin, mark.tone))
  if (marks.length > room) r.text('…', skin.hint)
  r.space(2).text(`${done}/${steps.length}`, skin.you).text(' steps finished', skin.hint)
  const counts = new Row(width, skin, pointer).space(2)
  parts.forEach((part, i) => {
    if (i > 0) counts.text(' · ', skin.hint)
    counts.text(
      `${part.n} ${part.label}`,
      part.n > 0 ? paintOf(skin, partTone(part.key)) : skin.hint,
    )
  })
  return [r.build(), counts.build()]
}

/** The plan's whole graph: a box per step, finished, running or waiting, and an arrow per wait. */
function graphOf(
  state: AppState,
  plan: PlanRow,
  width: number,
  skin: Skin,
  pointer: Pointer,
  now: number,
  why: boolean,
): Line[] {
  if (plan.steps.length === 0) return []
  const names = shortNamesOf(plan.steps)
  const boxes: PlanBox[] = plan.steps.map((step) => {
    const part = partOf(step)
    return {
      task: step.task,
      mark: partGlyph(part, now),
      name: printable(names.get(step.task) ?? step.name),
      right: step.usd !== null && step.usd > 0 ? dollars(step.usd) : '',
      note: `${printable(step.project)} · ${partWord(part)}`,
      tone: partTone(part),
    }
  })
  const waits: PlanWhy[] = plan.steps.flatMap((step) =>
    step.waits.map((wait) => ({ from: wait.task, to: step.task, why: wait.why })),
  )
  const drawing = drawPlan(boxes, waits, Math.max(0, width - 4), (column) => `STAGE ${column + 1}`)
  const inside = waits.filter(
    (wait) => boxes.some((box) => box.task === wait.from) && wait.from !== wait.to,
  )
  return planPicture(state, skin, pointer, width, [
    { rows: drawing.rows },
    ...(why && inside.length > 0
      ? [{ label: 'WHY THIS ORDER', rows: drawWhy(boxes, inside, Math.max(8, width - 4)) }]
      : []),
  ])
}

/** Where a plan is and what it came from, in one quiet line. */
function metaOf(plan: PlanRow): string {
  const bits = [plan.projects.map((one) => printable(one)).join(' · ') || 'no project']
  const rest = planSays(plan)
  if (rest !== '') bits.push(printable(rest))
  if (plan.usd !== null && plan.usd > 0) bits.push(dollars(plan.usd))
  return bits.join(' · ')
}

/** Every plan, in its group. */
function listPage(
  state: AppState,
  frame: Frame,
  plans: readonly PlanRow[],
  width: number,
  skin: Skin,
  pointer: Pointer,
): Line[] {
  const now = frame.now ?? 0
  const rows: Line[] = [blank(width)]
  if (plans.length === 0) {
    rows.push(said(width, skin, pointer, 'No plans yet.'))
    rows.push(
      said(width, skin, pointer, 'A workflow, or the orchestrator planning one, starts one.'),
    )
    return rows
  }
  const all = overallOf(plans)
  rows.push(
    ...progress(
      plans.flatMap((plan) => plan.steps),
      all.done,
      width,
      skin,
      pointer,
      now,
    ),
  )
  for (const group of groupsOf(plans)) {
    if (group.plans.length === 0) continue
    rows.push(blank(width), heading(width, skin, pointer, group.heading, group.plans.length))
    const cards = group.key === 'needs' || group.key === 'going'
    for (const plan of group.plans) {
      rows.push(blank(width), planLine(plan, width, skin, pointer, now))
      rows.push(...wrapped(metaOf(plan), width, 4, skin, pointer, plan.checks === 'fail'))
      if (!cards) continue
      rows.push(blank(width), ...graphOf(state, plan, width, skin, pointer, now, false))
      const said = nowOf(plan)
      for (const line of said.lines) {
        const target: Target = { kind: 'task', task: line.task }
        rows.push(
          new Row(width, skin, pointer)
            .space(4)
            .text(partGlyph(line.part, now), paintOf(skin, partTone(line.part)))
            .space()
            .text(
              shortened(printable(line.name), Math.max(8, width - 24)),
              linkPaint(skin, pointer, target),
              target,
            )
            .space(2)
            .text(line.said, skin.hint)
            .build(),
        )
      }
      if (said.more > 0)
        rows.push(
          new Row(width, skin, pointer).space(4).text(`${said.more} more open`, skin.hint).build(),
        )
    }
  }
  return rows
}

/** A plan's name, its mark and how far along it is, pressed to open it. */
function planLine(plan: PlanRow, width: number, skin: Skin, pointer: Pointer, now: number): Line {
  const part = STANDING_PART[standingOf(plan)]
  const target: Target = { kind: 'action', name: `plan:${plan.run}` }
  const tally = `${plan.finished}/${plan.total}`
  return new Row(width, skin, pointer)
    .space(2)
    .text(partGlyph(part, now), paintOf(skin, partTone(part)))
    .space()
    .text(
      shortened(printable(plan.run), Math.max(8, width - 14)),
      linkPaint(skin, pointer, target, skin.you),
      target,
    )
    .right((r) => r.text(tally, skin.hint).space(2))
    .build()
}

/** Text that opens something: lit under the pointer, as a link is. */
function linkPaint(
  skin: Skin,
  pointer: Pointer,
  target: Target,
  rest: (text: string) => string = (text) => text,
): (text: string) => string {
  return sameTarget(pointer.hover, target) ? skin.link : rest
}

/** A quiet line wrapped to the room, `✕ checks red` on its end where the checks are red. */
function wrapped(
  text: string,
  width: number,
  indent: number,
  skin: Skin,
  pointer: Pointer,
  red = false,
): Line[] {
  const lines = wrapWords(red ? `${text} · ✕ checks red` : text, Math.max(8, width - indent - 2))
  return lines.map((line) => {
    const r = new Row(width, skin, pointer).space(indent)
    const at = red ? line.indexOf('✕ checks red') : -1
    if (at < 0) return r.text(line, skin.hint).build()
    return r.text(line.slice(0, at), skin.hint).text('✕ checks red', skin.bad).build()
  })
}

/** One plan: its facts, what wants you, its graph and why, and every stage. */
function planPage(
  state: AppState,
  frame: Frame,
  plan: PlanRow,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Line[] {
  const now = frame.now ?? 0
  const rows: Line[] = [blank(width)]
  rows.push(...progress(plan.steps, plan.finished, width, skin, pointer, now))
  rows.push(blank(width))
  const fact = (label: string, value: string, paint: (text: string) => string = skin.hint) =>
    rows.push(
      new Row(width, skin, pointer)
        .space(2)
        .text(label.padEnd(10), skin.label)
        .text(shortened(value, Math.max(8, width - 14)), paint)
        .build(),
    )
  fact(
    'checks',
    CHECK_WORDS[plan.checks],
    plan.checks === 'fail' ? skin.bad : plan.checks === 'pass' ? skin.done : skin.hint,
  )
  fact('cost', plan.usd === null ? '—' : dollars(plan.usd))
  fact(
    'workflow',
    plan.stamp === null
      ? 'none: ordinary tasks'
      : printable(`${plan.stamp.name}@${plan.stamp.version}`),
  )
  fact(
    plan.projects.length === 1 ? 'project' : 'projects',
    plan.projects.map((one) => printable(one)).join(', ') || '—',
  )
  if (plan.retries > 0)
    fact('delivery', `${plan.retries} ${plan.retries === 1 ? 'retry' : 'retries'} before the plan`)
  if (plan.from !== null) fact('request', printable(`${plan.from.item} from ${plan.from.source}`))

  const names = shortNamesOf(plan.steps)
  const loud = plan.steps.filter((step) => {
    const part = partOf(step)
    return part === 'wants' || part === 'failed'
  })
  if (loud.length > 0) {
    rows.push(blank(width), heading(width, skin, pointer, 'NEEDS YOU', loud.length))
    for (const step of loud)
      rows.push(...stepRows(step, plan, names, width, skin, pointer, now, false))
  }
  if (plan.steps.length > 0) {
    rows.push(blank(width), heading(width, skin, pointer, 'THE GRAPH'))
    rows.push(...graphOf(state, plan, width, skin, pointer, now, true))
  }
  const stages = stagesOf(plan)
  if (stages.length > 0) {
    rows.push(blank(width), heading(width, skin, pointer, 'STAGE BY STAGE', stages.length))
    for (const stage of stages) {
      const finished = stage.done === stage.steps.length
      rows.push(
        blank(width),
        new Row(width, skin, pointer)
          .space(2)
          .text(finished ? '✓' : String(stage.layer + 1), finished ? skin.done : skin.you)
          .space()
          .text(stage.name, skin.you)
          .space(2)
          .text(shortened(printable(stage.said), Math.max(8, width - 30)), skin.hint)
          .right((r) => r.text(`${stage.done}/${stage.steps.length}`, skin.hint).space(2))
          .build(),
      )
      for (const step of stage.steps)
        rows.push(...stepRows(step, plan, names, width, skin, pointer, now, true))
    }
  }
  return rows
}

/** One step: its mark and name, pressed to go to its agent, where it works, its checks and review, and its waits. */
function stepRows(
  step: PlanStep,
  plan: PlanRow,
  names: ReadonlyMap<string, string>,
  width: number,
  skin: Skin,
  pointer: Pointer,
  now: number,
  waits: boolean,
): Line[] {
  const part = partOf(step)
  const target: Target = { kind: 'task', task: step.task }
  const cost = step.usd !== null && step.usd > 0 ? dollars(step.usd) : ''
  const rows: Line[] = [
    new Row(width, skin, pointer)
      .space(4)
      .text(partGlyph(part, now), paintOf(skin, partTone(part)))
      .space()
      .text(
        shortened(printable(names.get(step.task) ?? step.name), Math.max(8, width - 30)),
        linkPaint(skin, pointer, target),
        target,
      )
      .space(2)
      .text(printable(step.project), skin.hint)
      .right((r) => (cost === '' ? r : r.text(cost, skin.hint).space(2)))
      .build(),
  ]
  rows.push(...wrapped(`${partWord(part)} · ${stepSays(step)}`, width, 6, skin, pointer))
  if (!waits) return rows
  for (const wait of waitsOf(step, plan)) {
    const mark = wait.finished ? 'finished' : wait.part
    const why = printable(wait.why).trim() || 'no reason given'
    rows.push(
      new Row(width, skin, pointer)
        .space(6)
        .text(partGlyph(mark, now), paintOf(skin, partTone(mark)))
        .space()
        .text(
          shortened(
            `after ${printable(wait.name)}, ${wait.finished ? 'finished' : wait.part === 'unseen' ? 'not in this plan' : partWord(wait.part)}`,
            Math.max(8, width - 10),
          ),
          skin.hint,
        )
        .build(),
    )
    for (const line of wrapWords(why, Math.max(8, width - 10))) {
      rows.push(new Row(width, skin, pointer).space(8).text(line, skin.faded).build())
    }
  }
  return rows
}
