// Every word and every figure the Evaluations page draws, out of what the
// machine sent — pure, so `test/evaluations-client.test.ts` holds it without a
// browser.
//
// **Nothing here derives a rate.** Every count out of a count arrives with the
// machine's own words for it (`said`, core's `countSaid` and `precisionSaid`),
// so the page cannot say a percentage the machine would not: counts first, a
// rate only from five. What is missing is said as which kind of missing —
// *not granted*, *no judge here*, *not read yet* — and never as nought.

import { duration } from '../figures.js'

/** The tabs: one way of grouping the work each, and the judge itself. */
export const EVAL_TABS = [
  { id: 'harness', word: 'Harness' },
  { id: 'model', word: 'Model' },
  { id: 'persona', word: 'Persona' },
  { id: 'template', word: 'Template' },
  // The head-to-head version of the same question: one request, several
  // harnesses or models, read here and picked in the window.
  { id: 'races', word: 'Races' },
  { id: 'judge', word: 'Judge' },
]

/** The machine's words for where merges were read from. */
export function mergedSaid(answer) {
  return answer?.mergedFrom ? `merges from the ${answer.mergedFrom}` : ''
}

/** What one landed task cost, part by part: money, then a plan's list price. */
export function costSaid(cost) {
  if (cost === null || cost === undefined) return null
  return cost
    .map((part) => (part.kind === 'at list' ? `${part.said} at list` : part.said))
    .join(' · ')
}

/** What the judge raised about a row's changes, by what became of each. */
export function findingsSaid(found) {
  if (found === null || found === undefined) return null
  if (found.fired === 0) return 'no findings'
  return `${found.fired} ${found.fired === 1 ? 'finding' : 'findings'} · ${found.confirmed} confirmed · ${found.wrong} wrong · ${found.open} open`
}

/**
 * The lead: the whole of it at a glance, as stat tiles. Money only where this
 * device was granted it, and said as not granted where it was not.
 */
export function leadOf(answer) {
  const total = answer?.total ?? null
  const granted = answer?.granted ?? { spend: false, findings: false }
  return [
    {
      key: 'landed',
      label: 'Landed',
      value: total ? String(total.landed.count) : null,
      under: total ? `${total.landed.said} of ${total.tasks} agents` : '',
    },
    {
      key: 'push',
      label: 'First push green',
      value: total && total.firstPushGreen.of > 0 ? String(total.firstPushGreen.count) : null,
      under: total
        ? total.firstPushGreen.of === 0
          ? 'no push seen'
          : total.firstPushGreen.said
        : '',
    },
    {
      key: 'reds',
      label: 'Reds caught here',
      value: total && total.redsHere !== null ? String(total.redsHere) : null,
      under: total && total.redsHere === null ? 'nothing checked here' : 'before CI saw them',
    },
    {
      key: 'cost',
      label: 'Per landed agent',
      value: granted.spend ? costSaid(total?.cost ?? null) : null,
      under: granted.spend ? '' : 'not granted',
    },
    {
      key: 'done',
      label: 'To done',
      value: total && total.toDoneMs !== null ? duration(total.toDoneMs) : null,
      under: 'the middle of what finished',
    },
  ]
}

/**
 * The scorecards for one grouping, as ranked bars: how much landed, its words,
 * and every other figure on the line under it.
 */
export function cardsOf(answer, by) {
  const rows = answer?.by?.[by] ?? []
  return rows.map((row) => ({
    key: row.key === '' ? '(not recorded)' : row.key,
    label: row.label,
    value: row.landed.count,
    said: `${row.landed.said} landed`,
    under: underOf(row, answer.granted),
  }))
}

/** Everything about a row beside how much landed, each figure in its own words. */
export function underOf(row, granted) {
  const cost = granted?.spend ? costSaid(row.cost) : null
  return [
    `${row.tasks} ${row.tasks === 1 ? 'agent' : 'agents'}`,
    `${row.done.said} done`,
    row.firstPushGreen.of === 0 ? null : `first push green ${row.firstPushGreen.said}`,
    row.redsHere === null ? null : `${row.redsHere} red here`,
    cost === null || cost === '—' ? null : `${cost} per landed`,
    row.toDoneMs === null ? null : `${duration(row.toDoneMs)} to done`,
    granted?.findings ? findingsSaid(row.findings) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** The judge's tab: its precision overall, per question and per band. */
export function judgeOf(answer) {
  if (answer?.judge === 'not granted') return { state: 'not granted' }
  if (answer?.judge !== 'read' || !answer.calibration) return { state: 'none here' }
  const cal = answer.calibration
  return {
    state: 'read',
    said: `${cal.fired} ${cal.fired === 1 ? 'finding' : 'findings'} · ${cal.open} with no verdict · precision ${cal.said}`,
    questions: cal.questions.map((one) => ({
      key: one.question,
      label: one.question,
      value: one.fired,
      said: one.said,
      under: [`${one.fired} fired`, one.open > 0 ? `${one.open} open` : null, one.worth || null]
        .filter(Boolean)
        .join(' · '),
      tone: one.tone === 'costs' ? 'failed' : one.tone === 'earns' ? 'done' : 'quiet',
    })),
    bands: cal.bands.map((band) => ({
      key: String(band.from),
      label: `${band.from.toFixed(1)}–${band.to.toFixed(1)}`,
      value: band.fired,
      said: band.said,
      under: `${band.fired} fired${band.open > 0 ? ` · ${band.open} open` : ''}`,
    })),
  }
}

/**
 * The races: each with what was asked, what it has cost and who picked, and
 * its entrants in the order the facts put them — an order, never a verdict, so
 * nothing here is drawn as a winner until somebody picked one. What this
 * device was not granted is said as that.
 */
export function racesOf(answer) {
  return (answer?.races ?? []).map((race) => ({
    key: `${race.project}/${race.name}`,
    head: `${race.name} in ${race.project}`,
    said: race.said === null ? 'what was asked is not granted' : `asked: ${race.said}`,
    spent: race.spent === null ? 'cost not granted' : race.spent,
    decided: race.won
      ? `${short(race.won.task)} picked ${race.won.by === 'orchestrator' ? 'by the orchestrator, on your word' : 'by you'}`
      : 'nobody has picked — pick in the window, or ask the orchestrator',
    entrants: race.racers.map((one) => ({
      key: one.task,
      mark: one.won ? '✓' : one.closed ? '·' : String(one.place),
      name: short(one.task),
      under: [one.runsOn, ...one.says, one.usd, one.closed ? 'closed, branch kept' : null]
        .filter((part) => part !== null && part !== undefined)
        .join(' · '),
      tone: one.won ? 'done' : one.closed ? 'quiet' : '',
    })),
  }))
}

/** A task as a row names it: the half after its project. */
function short(task) {
  return task.split('/')[1] ?? task
}

/** A region's state, as `stateBoxIn` takes it. */
export function boxOf(kind, title, line) {
  return { kind, title, line }
}

/** What the page says where there is nothing to draw, by which nothing it is. */
export function emptyOf(answer, by) {
  if (answer === null) return null
  // Races are what the window holds now, not a fold over the journal: drawn
  // while the scorecards are still being read.
  if (by === 'races') {
    if ((answer.races ?? []).length > 0) return null
    return boxOf(
      'empty',
      'No race yet',
      'Ask the orchestrator to race one request on several harnesses or models.',
    )
  }
  if (!answer.read) {
    return boxOf('loading', 'Reading the journal', 'The scorecards come from every task it holds.')
  }
  if (by === 'judge') {
    const judge = judgeOf(answer)
    if (judge.state === 'not granted') {
      return boxOf(
        'empty',
        'Not granted to this device',
        'What the judge said is the findings grant, given at the machine.',
      )
    }
    if (judge.state === 'none here') {
      return boxOf(
        'empty',
        'No judge reads anything here',
        'Nothing was asked, so there is nothing to score.',
      )
    }
    return null
  }
  if ((answer.by?.[by] ?? []).length === 0) {
    return boxOf('empty', 'No work yet', 'A scorecard is made of tasks that were started.')
  }
  return null
}
