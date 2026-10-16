// The findings page's pure half: what the judge's findings add up to, in the
// order a person wants them — what waits on a verdict and for how long, per
// project, then what waits on an agent, then how each question has done.
//
// **A probability is not a verdict, and nothing here turns one into the
// other.** Whose move a finding is comes from whether the agent answered and
// whether somebody wrote a verdict (`findingMark`'s rule); how good a question
// is comes from verdicts alone. The probability is carried as the judge's
// reading of one change, drawn beside the question and never summed, ranked or
// counted into anything.

import { ageSaid } from '../figures.js'
import { findingMark } from '../glyphs.js'
import { pathOf, taskPath } from '../routes.js'

/**
 * How many verdicts a question needs before its precision is drawn as a rate.
 *
 * Jev's own `ENOUGH` (`core/src/calibration.ts`, which Jev reads), copied because a
 * browser cannot import a `.ts` file and held equal by
 * `test/findings-client.test.ts`. Under it the counts are said and the rate is
 * not: two verdicts out of two is not `100%` of anything.
 */
export const ENOUGH = 5

/** The four places a finding can be, in the order the page says them. */
export const WHOSE = {
  yours: { label: 'Wants your verdict', tone: 'wants' },
  agent: { label: 'Agent to answer', tone: 'working' },
  confirmed: { label: 'Confirmed', tone: 'failed' },
  wrong: { label: 'False positive', tone: 'done' },
}

/** One verdict bar's parts, as a question's legend says them. */
export const VERDICTS = {
  confirmed: { label: 'confirmed', tone: 'failed' },
  wrong: { label: 'false positive', tone: 'done' },
  open: { label: 'no verdict', tone: 'unknown' },
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Whose move a finding is: `yours` once the agent has answered and nobody has
 * read it, `agent` before that, and `confirmed` or `wrong` once somebody wrote
 * a verdict. Only the first is waiting on the person.
 */
export function whoseOf(finding) {
  if (finding.verdict !== null && finding.verdict !== undefined) {
    return finding.verdict.was === 'confirmed' ? 'confirmed' : 'wrong'
  }
  return finding.accounted ? 'yours' : 'agent'
}

/**
 * Since when it has waited on whoever it waits on: the agent's answer for a
 * finding waiting on a person, the reading for one waiting on the agent, and
 * the verdict for one that has its answer. Null where the moment will not read.
 */
export function sinceOf(finding) {
  const whose = whoseOf(finding)
  const at =
    whose === 'yours'
      ? (finding.account?.at ?? finding.at)
      : whose === 'agent'
        ? finding.at
        : finding.verdict.at
  return Number.isNaN(Date.parse(at)) ? null : at
}

/** The name a task goes by on this page: the part after its project. */
function nameOf(id) {
  const cut = id.indexOf('/')
  return cut < 0 ? id : id.slice(cut + 1)
}

/**
 * Where a finding points: the first task whose work the change was, a link to
 * its page while the store still has it, and how many more tasks shared it.
 */
function whereOf(finding, known) {
  const [first, ...rest] = finding.tasks ?? []
  if (first === undefined) return { task: null, name: null, href: null, others: 0 }
  return {
    task: first,
    name: nameOf(first),
    href: known(first) ? taskPath(first) : null,
    others: rest.length,
  }
}

/** The judge's probability, as written and as a share of a hundred for its meter. */
export function probabilityOf(finding) {
  const p = Number.isFinite(finding.probability) ? finding.probability : null
  if (p === null) return { said: '—', share: null }
  return { said: p.toFixed(2), share: Math.round(Math.max(0, Math.min(1, p)) * 100) }
}

/** What the agent said it did, as the pill under its words says it. */
export function didSaid(account) {
  if (account === null || account === undefined) return null
  return account.did === 'fixed' ? 'fixed it' : 'not real'
}

/**
 * One finding, as either kind of row draws it: the question, whose move it is,
 * where it points, the judge's probability, the agent's account and how long it
 * has waited, counted against the page's clock — which is the server's last word
 * while the stream is not live, so a dead page never counts up (`asOf`).
 */
export function findingOf(finding, asOf, known) {
  const whose = whoseOf(finding)
  const since = sinceOf(finding)
  const waited = since === null ? null : Math.max(0, asOf - Date.parse(since))
  const p = probabilityOf(finding)
  return {
    key: finding.key,
    question: finding.question,
    project: finding.project,
    projectHref: pathOf({ view: 'project', project: finding.project }),
    whose,
    mark: findingMark(finding),
    ...whereOf(finding, known),
    file: finding.file,
    moved: finding.stillThere === false,
    p: p.said,
    pShare: p.share,
    did: didSaid(finding.account),
    said: finding.account?.said ?? null,
    since,
    waited,
    waitedSaid: since === null ? '—' : ageSaid(since, asOf),
  }
}

/** Longest wait first, then by key so two of the same age keep their places. */
const longestFirst = (a, b) => (b.waited ?? -1) - (a.waited ?? -1) || byText(a.key, b.key)

/**
 * The findings that wait on a person, a group per project: the project whose
 * oldest has waited longest first, and in each the longest wait first.
 */
export function groupsOf(cards) {
  const by = new Map()
  for (const card of cards) {
    const group = by.get(card.project) ?? []
    group.push(card)
    by.set(card.project, group)
  }
  return [...by.entries()]
    .map(([project, list]) => {
      const sorted = [...list].sort(longestFirst)
      return {
        project,
        href: sorted[0].projectHref,
        n: sorted.length,
        oldest: sorted[0].waited,
        oldestSaid: sorted[0].waitedSaid,
        cards: sorted,
      }
    })
    .sort((a, b) => (b.oldest ?? -1) - (a.oldest ?? -1) || byText(a.project, b.project))
}

/**
 * How one question has done, out of verdicts alone (jev's `precision.ts`): a
 * finding with no verdict is counted as neither, and a rate is drawn only once
 * there are `ENOUGH` verdicts to draw it from.
 */
export function questionOf(question, rows) {
  const n = { yours: 0, agent: 0, confirmed: 0, wrong: 0 }
  for (const row of rows) n[row.whose] += 1
  const judged = n.confirmed + n.wrong
  const open = n.yours + n.agent
  const precision = judged === 0 ? null : n.confirmed / judged
  const enough = judged >= ENOUGH
  return {
    question,
    fired: rows.length,
    judged,
    confirmed: n.confirmed,
    wrong: n.wrong,
    open,
    yours: n.yours,
    precision,
    enough,
    figure: precisionSaid(n.confirmed, judged),
    under: precisionLine(n.confirmed, judged),
    parts: [
      { key: 'confirmed', ...VERDICTS.confirmed, n: n.confirmed },
      { key: 'wrong', ...VERDICTS.wrong, n: n.wrong },
      { key: 'open', ...VERDICTS.open, n: open },
    ],
  }
}

/** A question's figure: a rate with enough verdicts, the counts under that, `—` with none. */
export function precisionSaid(confirmed, judged) {
  if (judged === 0) return '—'
  if (judged < ENOUGH) return `${confirmed} of ${judged}`
  return `${Math.round((confirmed / judged) * 100)}%`
}

/** The word under a question's figure, saying which of the three it is. */
export function precisionLine(confirmed, judged) {
  if (judged === 0) return 'no verdict yet'
  if (judged < ENOUGH) return 'confirmed'
  return `${confirmed} of ${judged} confirmed`
}

/**
 * Every question asked here: the ones with something waiting on the person
 * first, then the ones that fired most, then by name.
 */
export function questionsOf(rows) {
  const by = new Map()
  for (const row of rows) {
    const list = by.get(row.question) ?? []
    list.push(row)
    by.set(row.question, list)
  }
  return [...by.entries()]
    .map(([question, list]) => questionOf(question, list))
    .sort((a, b) => b.yours - a.yours || b.fired - a.fired || byText(a.question, b.question))
}

/**
 * The whole page out of the projected rows: the counts and the oldest wait of
 * each kind for the lead, the groups waiting on a person, the rows waiting on
 * an agent, the ones with a verdict (newest first), and every question.
 * `known(id)` says whether a task is still in the store, so a link is drawn
 * only to a page that exists.
 */
export function findingsPage(findings, asOf, known = () => false) {
  const rows = findings.map((one) => findingOf(one, asOf, known))
  const of = (whose) => rows.filter((one) => one.whose === whose)
  const yours = of('yours')
  const agent = of('agent').sort(longestFirst)
  const read = [...of('confirmed'), ...of('wrong')].sort(
    (a, b) => (a.waited ?? -1) - (b.waited ?? -1) || byText(a.key, b.key),
  )
  const counts = {
    yours: yours.length,
    agent: agent.length,
    confirmed: of('confirmed').length,
    wrong: of('wrong').length,
  }
  const oldest = (list) => {
    const first = [...list].sort(longestFirst)[0]
    return first === undefined || first.waited === null ? null : first.waitedSaid
  }
  return {
    total: rows.length,
    counts,
    oldest: { yours: oldest(yours), agent: oldest(agent) },
    parts: Object.entries(WHOSE).map(([key, one]) => ({ key, ...one, n: counts[key] })),
    groups: groupsOf(yours),
    agent,
    read,
    questions: questionsOf(rows),
  }
}

/** The bar's word: how many want a verdict, or that nothing does — empty before there is a page. */
export function figureSaid(page) {
  if (page === null || page.total === 0) return { word: '', tone: null }
  if (page.counts.yours === 0) return { word: 'nothing waits on you', tone: null }
  const n = page.counts.yours
  return { word: `${n} ${n === 1 ? 'wants' : 'want'} a verdict`, tone: 't-wants' }
}

/** A line of the lead's tally: how long the oldest of that kind has waited, where it waits. */
export function tallyUnder(page, key) {
  if (key === 'yours' || key === 'agent') {
    const said = page.oldest[key]
    return page.counts[key] === 0 || said === null ? '' : `oldest ${said}`
  }
  return ''
}

/** What a row waiting on an agent, or one with a verdict, says under its question. */
export function rowLine(row) {
  const parts = [row.project]
  if (row.name !== null) parts.push(row.others > 0 ? `${row.name} +${row.others}` : row.name)
  parts.push(row.file)
  return parts.join(' · ')
}

/** The press that shows or folds the findings that already have their verdict. */
export function readSaid(n, open) {
  return open
    ? `Hide the ${plural(n, 'finding')} with a verdict`
    : `Show ${plural(n, 'finding')} with a verdict`
}

/** What a row with a verdict says beside it: the verdict, and how long ago it was written. */
export function verdictAside(row) {
  const word = row.whose === 'confirmed' ? 'confirmed' : 'false positive'
  return row.since === null ? word : `${word} ${row.waitedSaid} ago`
}

/**
 * What the page says about the findings it does not hold: a page of the
 * projection is capped, and every figure here is of the ones it was sent.
 */
export function omittedSaid(omitted, held) {
  if (omitted <= 0) return null
  return `${plural(omitted, 'more finding')} not sent to this device; every figure here is of the ${held} it holds`
}
