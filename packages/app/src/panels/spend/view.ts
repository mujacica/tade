import { visibleWidth } from '@earendil-works/pi-tui'
import {
  duration,
  type OnPlan,
  type Priced,
  planPressure,
  type Runtime,
  workedOf,
} from '@tade/core'
import { type AgentPane, glyph, MARK_TONES, markOf } from '../../model.ts'
import type { Skin } from '../../skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy } from '../../spend.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap, pad, padTo, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, tabRow } from '../frame.ts'
import type { SpendPanel } from './state.ts'

// What the Spend panel looks like. The table is laid out from the room there
// is — a name is the one column that cannot be abbreviated without lying — a
// bill, a harness's guess and a rate off a published page each carry their own
// mark, and nothing on this page is a sentence.

/**
 * The Spend panel: what it cost, what is left of each plan, what it bought.
 *
 * The table is laid out from the room there is rather than from numbers
 * somebody typed once. A name is the widest thing on the page and the only one
 * that cannot be abbreviated without lying — `openrouter/anthropic/claude-…`
 * and `anthropic/claude-…` are two different bills — so the name column takes
 * whatever the fixed columns leave, wraps onto a second line when that is not
 * enough, and ellipsises only past that. Everything that is cut is cut with
 * `cap`, which says so, and every column has a clear gap before the next:
 * text that stops dead reads as text that ran into its neighbour, which is
 * exactly how two unreadable rows got reported.
 *
 * `MODEL` appears in the Agent view alone. Beside a model, a harness, a
 * sign-in or a provider it either repeats the name column or averages over
 * rows that ran on many models — and in both cases it is spending the width
 * the name needs to say nothing.
 */
export function spend(panel: SpendPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: SPEND_WIDTH })
  // The table keeps a column for its bar, so nothing reflows when a window
  // with fewer agents in it stops having more rows than fit.
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.spend
  // What stays put: the totals and the tabs that change them, then the column
  // heads. Everything under those scrolls, so nothing is cut at a number and
  // said as `+7 more` — a list that stops without saying where it stopped is
  // the shape this page was three times over.
  const head: Line[] = []
  const rows: Line[] = []

  const top = row().space()
  // The mark rides on the figure itself, here as on every row: a total that
  // holds money nobody priced says so where it is read, not in a footnote —
  // and the word the mark is short for goes beside it, so a figure that adds a
  // bill, a harness's guess and a rate off a published page can never do it in
  // silence.
  top.text(view ? cost(view.priced, view.usd) : '—', skin.you)
  const madeOf = view && view.priced !== 'none' ? MADE_OF[view.priced] : ''
  if (madeOf) top.space().text(madeOf, skin.hint)
  top.space(2)
  top.text(tokenCount(view?.tokens ?? 0), skin.hint).space(2)
  // Both times, each said in its own word: how long a model was working, and
  // how long the agents were open. Two figures and no sentence — the page says
  // which is which the way the columns under it do — and `over 3 runs` beside
  // them, because a time that is not elapsed time is unreadable without it.
  const ran = view?.runtime
  top.text(runtimeHead(ran), ran?.running ? skin.busy : skin.hint)
  head.push(top.build())

  // The ranges, then the groupings: two rows of tabs with the word that
  // introduces each, which is the only shape that holds five ranges and six
  // groupings at every width. Both wrap under their own word rather than
  // running off the edge, because a tab past the edge is one nobody can reach.
  //
  // The ranges were a right-aligned row up beside the figures while there were
  // three of them. Five is more than the line the figures are on has room for,
  // and a range nobody can see is a range nobody knows the page has.
  head.push(...tabRow(row, skin, 'for', SPEND_WINDOWS, panel.window, 'window', inner))
  head.push(...tabRow(row, skin, 'by', SPEND_BY, panel.by, 'by', inner))
  head.push(blank(inner))

  const { name, model, meter } = spendColumns(inner, panel.by)
  head.push(
    row()
      .space(LEAD)
      .text(padTo(SPEND_HEADS[panel.by], name), skin.label)
      .space(SPEND_GAP)
      .text(model > 0 ? `${padTo('MODEL', model)}${' '.repeat(SPEND_GAP)}` : '', skin.label)
      .text('TOKENS'.padStart(TOKENS_W), skin.label)
      .space(SPEND_GAP)
      .text(padTo('SHARE', meter), skin.label)
      .space()
      .text('WORKING'.padStart(WORKING_W), skin.label)
      .space()
      .text('OPEN'.padStart(OPEN_W), skin.label)
      .text('COST'.padStart(COST_W), skin.label)
      .build(),
  )
  const total = Math.max(1, view?.tokens ?? 0)
  // The orchestrator first, as its own line: it is the one cost that is not
  // any task's, and the one people forget is running.
  const entries = [...(view?.rows ?? [])].sort(
    (a, b) => Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator'),
  )
  if (entries.length === 0) {
    // Which range found nothing, not just that something did: with five of
    // them, an empty table that says only `Nothing` is the answer to whichever
    // one the reader happens to think they are on.
    const over = SPEND_WINDOWS.find((one) => one.id === panel.window)?.over ?? 'here'
    rows.push(row().space(3).text(`Nothing ${over}.`, skin.hint).build())
  }
  for (const entry of entries) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    const said = nameLines(label, name)
    const first = said[0] ?? ''
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(padTo(first, name))
        .space(SPEND_GAP)
        .text(model > 0 ? padTo(entry.model ? shortModel(entry.model) : '', model) : '', skin.hint)
        .space(model > 0 ? SPEND_GAP : 0)
        .text(tokenCount(entry.tokens, false).padStart(TOKENS_W))
        .space(SPEND_GAP)
        .meter(entry.tokens / total, meter)
        .space()
        .text(working(entry.runtime).padStart(WORKING_W), skin.hint)
        .space()
        .text(
          (entry.runtime && entry.runtime.ms > 0 ? duration(entry.runtime.ms) : '—').padStart(
            OPEN_W,
          ),
          entry.runtime?.running ? skin.busy : undefined,
        )
        // What it cost, or what it would have cost where a plan paid — each
        // marked and toned where it is read (`costCell`), because a column of
        // dollars that quietly mixes three claims is the one thing this page
        // may never draw.
        .text(costCell(entry).padStart(COST_W), costTone(entry, skin))
        .build(),
    )
    // The rest of a name too long for its column.
    for (const rest of said.slice(1)) {
      rows.push(row().space(LEAD).text(padTo(rest, name)).build())
    }
  }

  // What a subscription has left, under what it cost: money and a plan are
  // different currencies with no rate between them, so this is its own list
  // and nothing here is added to anything above it. Always now, whichever
  // window the tabs are on — there is no such thing as last Tuesday's plan.
  rows.push(blank(inner))
  rows.push(row().space().text('PLAN', skin.label).build())
  const whose = 17
  // What can be said comes first. A reason is worth reading, and worth
  // reading after the figures somebody opened this to see.
  const standings = [...(view?.plan ?? [])].sort(
    (a, b) => Number(b.windows.length > 0) - Number(a.windows.length > 0),
  )
  if (standings.length === 0) {
    rows.push(row().space(3).text('No plan reported.', skin.hint).build())
  }
  for (const standing of standings) {
    const drawn: Line[] = []
    // What its turns in the window above would have cost at list price, on the
    // sign-in's own first line: a figure of the same kind `ccusage` gives, and
    // a plan pays a flat fee, so nobody is billed it. It sits in this list and
    // never in the COST column, because that column is money.
    const listed = atList(standing)
    if (standing.cannotTell === null) {
      let top = true
      for (const window of standing.windows) {
        const used = Math.round(window.used)
        // One rule for when a plan is worrying, in core, because the strip and
        // what the orchestrator is told read the same two numbers.
        const pressure = planPressure(used)
        const tone =
          pressure === 'tight' ? skin.bad : pressure === 'warm' ? skin.waiting : skin.done
        const left = window.resetsIn
        const line = row()
          .space()
          .text(padTo(top ? standing.label : '', whose))
          .space()
          .text(pad(window.label, 4), skin.hint)
          .meter(Math.min(1, used / 100), 10, tone)
          .space()
          .text(`${used}%`.padStart(4), tone)
          .space(2)
          .text(
            padTo(left === null ? 'no reset given' : `resets in ${duration(left)}`, 17),
            skin.hint,
          )
        // When the harness last said it. The figure is only ever as fresh as
        // the last agent that ran, and a share that has not moved in an hour
        // is an hour-old share rather than one that stopped growing.
        if (top && standing.saidAgo !== null) {
          line.text(pad(`said ${duration(standing.saidAgo)} ago`, 16), skin.hint)
        }
        if (top && listed) line.text(listed, skin.hint)
        drawn.push(line.build())
        top = false
      }
    } else {
      // Two words, not the harness's paragraph. That a plan has nothing to
      // show is the fact; *why* — it prices each turn instead, it has not
      // been told yet — is a sentence read once and then read every time the
      // page is opened, and it is still on the harness (`why.limits`).
      // And the estimate even here: a harness that has not yet said how full
      // its plan is has still run the turns, and what they would have cost is
      // answerable when the share is not.
      drawn.push(
        row()
          .space()
          .text(padTo(standing.label, whose))
          .space()
          // Padded to where the bars' own `said … ago` ends, so a figure on this
          // row and a figure on one that could tell stand in one column.
          .text(padTo('cannot tell', 54), skin.hint)
          .text(listed, skin.hint)
          .build(),
      )
    }
    rows.push(...drawn)
  }

  // What the money bought and how the checks have been going are an agent's
  // own record, and they are already on its ACTIONS page — the commits it
  // wrote with what each changed, and every check with what it printed. Two
  // summary lines of the same thing here were a second, shorter answer to a
  // question answered better one screen away, on a page that is about money.
  rows.push(blank(inner))
  rows.push(row().space().text('BUDGETS', skin.label).build())
  // Only projects with something to say: a budget, or money spent without one.
  const budgets = (view?.budgets ?? []).filter(
    (budget) => budget.budget || budget.usd > 0 || budget.tokens > 0,
  )
  if (budgets.length === 0) rows.push(row().space(3).text('No budgets set.', skin.hint).build())
  // Laid out from the room there is, like the table above it: `set one` is a
  // link, and a link cut in half — `no budget — s` — is one nobody can press
  // and nobody can read.
  const bar = inner >= 62 ? 12 : inner >= 50 ? 8 : 6
  const verdictW = Math.max(bar + 6, visibleWidth('no budget — set one'))
  const whoseBudget = Math.min(14, Math.max(8, Math.floor(inner / 5)))
  const spentW = Math.min(28, Math.max(8, inner - 1 - whoseBudget - SPEND_GAP - verdictW))
  for (const budget of budgets) {
    const line = row().space().text(padTo(budget.project, whoseBudget)).space(SPEND_GAP)
    const limit = budget.budget?.usd_per_day
    const spent = limit
      ? `${money(budget.usd)} of ${money(limit)} a day`
      : budget.budget?.tokens_per_day
        ? `${tokenCount(budget.tokens, false)} of ${tokenCount(budget.budget.tokens_per_day, false)} a day`
        : money(budget.usd)
    line.text(padTo(spent, spentW))
    if (budget.share !== null) {
      const tone =
        budget.verdict === 'over' ? skin.bad : budget.verdict === 'warn' ? skin.waiting : skin.done
      line
        .meter(Math.min(1, budget.share), bar, tone)
        .space()
        .text(`${Math.round(budget.share * 100)}%`, skin.hint)
    } else {
      line
        .text('no budget — ', skin.hint)
        .text('set one', skin.link, { kind: 'action', name: 'budgets' })
    }
    rows.push(line.build())
  }

  // The table is the window's own scroll area, so the wheel, the bar and the
  // arrows are the one move the rest of Tade makes. The totals and the tabs
  // that change them stay put above it, and Done stays put below.
  const drawn = column(
    {
      head,
      body: { lines: rows, width: inner, scroll: panel.scroll },
      foot: [
        blank(inner),
        new Row(inner, skin, ctx.pointer)
          .space()
          .text(cap('↑↓ reads · ←→ ranges · tab groups', inner - 12), skin.hint)
          .right((r) => r.button('Done', { kind: 'control', id: 'close' }, 'primary').space())
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box('Spend', drawn.rows, width, skin, { corner: 'esc' })
}

/**
 * As wide as the table wants, and never wider than the window it floats over.
 *
 * It wants seven more than it did, because it now says how long a model was
 * working beside how long its agent was open — two questions that were being
 * answered with one figure. Taken out of the columns instead, the table paid
 * for it twice over: the share meter is decoration and gives ground first, but
 * after that it comes out of the name, and a name is the one column here that
 * cannot be abbreviated without lying.
 */
export const SPEND_WIDTH = 91

/** A space, the state mark, and the space after it: where every name starts. */
const LEAD = 3
/** The clear column between one column and the next. Never zero: that was the bug. */
const SPEND_GAP = 2
const TOKENS_W = 6
/**
 * Two times and not one, because they answer two questions and reading either
 * as the other is what sent somebody looking for this page. `OPEN` is how long
 * the agent was there, which is what one sitting finished in its lane until
 * somebody closes the window burns; `WORKING` is how long a model was actually
 * working, which is the one that pairs with the money two columns along.
 *
 * Wide enough for the mark: `≥9h 40m` is what a figure made of some runs that
 * could say and some that could not looks like, and a floor drawn as though it
 * were a total is the one thing these columns may not do.
 */
const WORKING_W = 7
const OPEN_W = 6
/** Room for the figure and the mark that says who priced it. */
const COST_W = 9

/** What the first column is, in the words of the facet it is grouped by. */
const SPEND_HEADS: Readonly<Record<SpendBy, string>> = {
  agent: 'AGENT',
  project: 'PROJECT',
  model: 'MODEL',
  harness: 'HARNESS',
  account: 'SIGN-IN',
  provider: 'PROVIDER',
}

/**
 * How the table's width is divided, given the room there is.
 *
 * The fixed columns are figures and take what a figure takes. Everything left
 * over is the name's, except the share meter, which is decoration and gives
 * ground first — it is the one column that says nothing a number beside it
 * does not already say.
 */
export function spendColumns(
  inner: number,
  by: SpendBy,
): { name: number; model: number; meter: number } {
  const figures = LEAD + SPEND_GAP + TOKENS_W + SPEND_GAP + 1 + WORKING_W + 1 + OPEN_W + COST_W
  let room = inner - figures
  // The model column is worth its width in the Agent view — and only while
  // there is still a name left beside it. A panel narrow enough that both
  // cannot be read is a panel where the name wins: it is the only column here
  // whose value is the whole of it.
  let model = 0
  if (by === 'agent') {
    const want = inner >= 82 ? 18 : inner >= 66 ? 14 : 10
    if (room - want - SPEND_GAP >= MIN_NAME + 6) {
      model = want
      room -= want + SPEND_GAP
    }
  }
  // The meter gives ground first and disappears last: it is the one column
  // that says nothing the number beside it does not already say.
  const meter = room >= 40 ? 10 : room >= 30 ? 8 : room >= 22 ? 6 : 0
  return { name: Math.max(4, room - meter), model, meter }
}

/** Below this a name is not a name, so the column beside it gives way instead. */
const MIN_NAME = 10

/**
 * A name over the lines it needs.
 *
 * Two lines, because twice a column holds every model id and task name there
 * is, and the last of them ellipsised — a name cut without saying so is a name
 * a person misreads rather than looks up.
 */
export function nameLines(label: string, width: number): string[] {
  const lines = wrapTo(label, width, 2)
  return lines.length === 0 ? [cap(label, width)] : lines
}

/**
 * The pair of times at the top of the page, each with the word that says which
 * it is, and how many runs they are made of. No prose: `working` and `open`
 * are the same two words the columns under them are headed with, so the page
 * says which is which once.
 *
 * `open` is always a figure — a run has a start and an end, or it is still
 * going. `working` is not: every run of a journal written before Tade recorded
 * when a turn begins has turns with ends and no beginnings, and what those
 * spent working is unanswerable rather than nought. So it is said as unknown,
 * and never as the `0s` it would otherwise add up to.
 *
 * `over 3 runs` is what makes either of them readable: twenty agents over an
 * afternoon each ran for the whole of their own afternoon, so `13d 3h` off a
 * machine on since breakfast reads as a bug and is not one. It goes with the
 * figures it qualifies and is never dropped to save a column.
 */
export function runtimeHead(ran: Runtime | undefined): string {
  if (!ran) return `${duration(0)} open`
  const runs = ran.runs > 1 ? ` · over ${ran.runs} runs` : ''
  const open = `${duration(ran.ms)} open${runs}`
  switch (workedOf(ran)) {
    case 'recorded':
      return `${duration(ran.workingMs)} working · ${open}`
    // A floor, because some of the runs in it could say and some could not.
    // Marked where it is read, the way estimated money is: a caveat true under
    // every row is a mark, never a footnote.
    case 'partly':
      return `≥${duration(ran.workingMs)} working · ${open}`
    default:
      return `working unknown · ${open}`
  }
}

/**
 * How long a model worked, in a cell: the figure, a floor where only some of
 * the runs behind it could say, and `—` where there is nothing to say at all.
 *
 * `—` is what this page already draws for money nobody reported, and it means
 * the same thing here — nothing to show — whether that is because the run took
 * no turns or because it began before Tade wrote turn beginnings down. Which
 * of the two it is, is the head's to say, and it says it.
 */
function working(ran: Runtime | null): string {
  if (!ran || workedOf(ran) === 'unrecorded' || ran.workingMs <= 0) return '—'
  return `${workedOf(ran) === 'partly' ? '≥' : ''}${duration(ran.workingMs)}`
}

/**
 * What a total is made of, in the word its mark is short for.
 *
 * Under the figure rather than beside it: the head has no columns to spare,
 * and a word one line lower is read every time. A bill needs no word — a
 * figure with no mark on it is the plain answer to what something cost.
 */
const MADE_OF: Readonly<Record<Priced, string>> = {
  exact: 'billed',
  estimate: 'estimated',
  listed: 'list prices',
  mixed: 'mixed',
  none: '',
}

/**
 * What a plan's turns would have cost at the published rate, and the word that
 * says it is not a bill. Empty where there is nothing to say.
 *
 * `at list` is the whole of the explanation, and it is the word `MADE_OF`
 * already uses for a rate taken off a provider's page — the difference being
 * that there somebody is billed and here nobody is, which is why this figure
 * appears only where the page is not money: under the total, beside the plan's
 * own bars. A floor (`≥`) where some of a plan's turns ran on a model no rate
 * knows, which is the mark the working column uses for the same reason.
 */
function atList(of: { usdOnPlan: number; onPlan: OnPlan }): string {
  if (of.onPlan === 'none') return ''
  return `${of.onPlan === 'partly' ? '≥' : ''}${MARK.listed}${money(of.usdOnPlan)} at list`
}

/**
 * A figure of money, and the one character that says who worked it out.
 *
 * Three kinds and three marks, because they are three different claims: no
 * mark is what somebody was charged, `~` is the harness's own guess at it, and
 * `≈` is Tade's, off the published rate for the model in `prices.ts`. A column
 * that mixed them without saying is the one thing this page may never draw.
 *
 * `—` where no money was reported and none could be worked out, never `$0.00`:
 * a plan pays a flat fee and has no price per turn, and drawing that as
 * nothing spent reads as free. What it used up is the plan's windows, in their
 * own list below.
 */
function cost(priced: Priced, usd: number): string {
  if (priced === 'none') return '—'
  return `${MARK[priced]}${money(usd)}`
}

/**
 * What one row's COST cell says: the money, or — where there is none and a
 * plan paid for the work — what those turns would have cost at list price.
 *
 * Money first and always, because money is what the column is for. The second
 * figure is the one this page used to draw as `—` on rows where an agent had
 * worked all morning, with the total of it on a caveat line above the table
 * that nobody could attribute to an agent by eye. It is the same arithmetic
 * `usdListed` is, off the same table of rates, so it carries the same `≈`; the
 * difference is that nobody is billed it, which is what `costTone` says and
 * what keeps it out of every total on this page.
 *
 * `≥` where some of those turns ran on a model no rate knows — a floor drawn
 * as a floor, the way the working column already does it.
 */
function costCell(row: { priced: Priced; usd: number; usdOnPlan: number; onPlan: OnPlan }): string {
  if (row.priced !== 'none') return cost(row.priced, row.usd)
  if (row.onPlan === 'none') return '—'
  return `${row.onPlan === 'partly' ? '≥' : ''}${MARK.listed}${money(row.usdOnPlan)}`
}

/**
 * How loudly a cost is said: a bill plainly, a figure somebody worked out
 * quietly, and one nobody is charged quieter still.
 *
 * Three steps for three claims, because the mark alone cannot separate the
 * last two — `≈` is Tade's arithmetic either way, and whether there is a bill
 * behind it is the whole difference. The plain skin keeps the marks and loses
 * the steps, which is why the figure is never the only thing that says which
 * it is: the PLAN list below names every sign-in a plan pays for.
 */
function costTone(
  row: { priced: Priced; usdOnPlan: number; onPlan: OnPlan },
  skin: Skin,
): ((text: string) => string) | undefined {
  if (row.priced === 'exact') return undefined
  if (row.priced === 'none' && row.onPlan !== 'none') return skin.chrome
  return skin.hint
}

const MARK: Readonly<Record<Priced, string>> = {
  exact: '',
  estimate: '~',
  listed: '≈',
  mixed: '~',
  none: '',
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  return skin[MARK_TONES[markOf(pane)]]
}

function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function tokenCount(count: number, unit = true): string {
  const suffix = unit ? ' tokens' : ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M${suffix}`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k${suffix}`
  return `${count}${suffix}`
}

function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}
