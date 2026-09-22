import { visibleWidth } from '@earendil-works/pi-tui'
import { duration, type Priced } from '@tade/core'
import type { Hit } from '../../hits.ts'
import { type AgentPane, glyph, MARK_TONES, markOf } from '../../model.ts'
import type { Skin } from '../../skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendView } from '../../spend.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap, pad, padTo, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import type { SpendPanel } from './state.ts'

// What the Spend panel looks like. The table is laid out from the room there
// is — a name is the one column that cannot be abbreviated without lying — and
// money that was priced is never totalled with money that was guessed.

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
  const width = Math.min(SPEND_WIDTH, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.spend
  const rows: { text: string; hits: Hit[] }[] = []

  const head = row().space()
  head.text(view?.hasCost ? money(view.usd) : '—', skin.you).space(2)
  head.text(tokenCount(view?.tokens ?? 0), skin.hint).space(2)
  // Every agent's time added together, which is why two working at once put
  // two hours on the clock in one. Bare, beside the money and the tokens: the
  // column below says what it is.
  const ran = view?.runtime
  head.text(duration(ran?.ms ?? 0), ran?.running ? skin.busy : skin.hint)
  head.right((r) => {
    for (const window of SPEND_WINDOWS) {
      r.tab(
        window.label,
        { kind: 'control', id: `window:${window.id}` },
        panel.window === window.id,
      )
    }
    r.space()
  })
  rows.push(head.build())
  rows.push(blank(inner))

  // Six facets is more than a narrow panel fits on one line, and a tab that
  // ran off the edge is a grouping nobody can reach. So they wrap, under the
  // word that introduces them.
  let by = row().space().text('by ', skin.hint)
  for (const option of SPEND_BY) {
    if (by.used + visibleWidth(option.label) + 4 > inner) {
      rows.push(by.build())
      by = row().space(4)
    }
    by.tab(option.label, { kind: 'control', id: `by:${option.id}` }, panel.by === option.id)
  }
  rows.push(by.build())
  rows.push(blank(inner))

  const { name, model, meter } = spendColumns(inner, panel.by)
  rows.push(
    row()
      .space(LEAD)
      .text(padTo(SPEND_HEADS[panel.by], name), skin.label)
      .space(SPEND_GAP)
      .text(model > 0 ? `${padTo('MODEL', model)}${' '.repeat(SPEND_GAP)}` : '', skin.label)
      .text('TOKENS'.padStart(TOKENS_W), skin.label)
      .space(SPEND_GAP)
      .text(padTo('SHARE', meter), skin.label)
      .space()
      .text('RUNTIME'.padStart(RUNTIME_W), skin.label)
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
    rows.push(row().space(3).text('Nothing in this window.', skin.hint).build())
  }
  // Counted in lines rather than in rows, because a row is one line or three:
  // the panel floats over the work, and every line it grows is a line of the
  // work underneath that somebody cannot see. Biggest first, so what stops is
  // the tail — and what it left out is said, never quietly dropped.
  let used = 0
  let unshown = 0
  for (const entry of entries) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    const said = nameLines(label, entry.note, name)
    if (used + said.length > SPEND_LINES) {
      unshown = entries.length - entries.indexOf(entry)
      break
    }
    const first = said[0] ?? { text: '', note: false }
    const cost = view?.hasCost ? `${pricedMark(entry.priced)}${money(entry.usd)}` : '—'
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(padTo(first.text, name))
        .space(SPEND_GAP)
        .text(model > 0 ? padTo(entry.model ? shortModel(entry.model) : '', model) : '', skin.hint)
        .space(model > 0 ? SPEND_GAP : 0)
        .text(tokenCount(entry.tokens, false).padStart(TOKENS_W))
        .space(SPEND_GAP)
        .meter(entry.tokens / total, meter)
        .space()
        .text(
          (entry.runtime && entry.runtime.ms > 0 ? duration(entry.runtime.ms) : '—').padStart(
            RUNTIME_W,
          ),
          entry.runtime?.running ? skin.busy : undefined,
        )
        // Money nobody priced is marked where it is read, not only in the
        // footer: a column of dollars that quietly mixes the two is the one
        // thing this page may never draw.
        .text(cost.padStart(COST_W), entry.priced === 'exact' ? undefined : skin.hint)
        .build(),
    )
    // The rest of a name too long for its column, and what the row is when its
    // name alone would be read as a thing that exists.
    for (const rest of said.slice(1)) {
      rows.push(
        row()
          .space(LEAD)
          .text(padTo(rest.text, name), rest.note ? skin.hint : undefined)
          .build(),
      )
    }
    used += said.length
  }
  if (unshown > 0) {
    rows.push(row().space(3).text(`+${unshown} more`, skin.hint).build())
  }

  // What a subscription has left, under what it cost: money and a plan are
  // different currencies with no rate between them, so this is its own list
  // and nothing here is added to anything above it. Always now, whichever
  // window the tabs are on — there is no such thing as last Tuesday's plan.
  rows.push(blank(inner))
  rows.push(row().space().text('PLAN', skin.label).build())
  const whose = 17
  const sentence = inner - whose - 2
  // What can be said comes first. A reason is worth reading, and worth
  // reading after the figures somebody opened this to see.
  const standings = [...(view?.plan ?? [])].sort(
    (a, b) => Number(b.windows.length > 0) - Number(a.windows.length > 0),
  )
  if (standings.length === 0) {
    rows.push(row().space(3).text('No plan reported.', skin.hint).build())
  }
  // The panel floats over the work, so the section is bounded — and what it
  // left out is said, because a list that stops without saying so reads as a
  // list of everything there is.
  const PLAN_LINES = 9
  let lines = 0
  let dropped = 0
  for (const standing of standings) {
    const drawn: { text: string; hits: Hit[] }[] = []
    if (standing.cannotTell === null) {
      let top = true
      for (const window of standing.windows) {
        const used = Math.round(window.used)
        const tone = used >= 90 ? skin.bad : used >= 75 ? skin.waiting : skin.done
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
          line.text(`said ${duration(standing.saidAgo)} ago`, skin.hint)
        }
        drawn.push(line.build())
        top = false
      }
    } else {
      // The harness's own sentence, whole: what a person reads is a sentence
      // somebody wrote, never a blank or a zero standing in for one.
      const said = wrapTo(`cannot tell — ${standing.cannotTell}`, sentence, 2)
      said.forEach((part, at) => {
        drawn.push(
          row()
            .space()
            .text(padTo(at === 0 ? standing.label : '', whose))
            .space()
            .text(part, skin.hint)
            .build(),
        )
      })
    }
    if (lines + drawn.length > PLAN_LINES) {
      dropped += 1
      continue
    }
    rows.push(...drawn)
    lines += drawn.length
  }
  if (dropped > 0) {
    rows.push(row().space(3).text(`+${dropped} more`, skin.hint).build())
  }

  // What the money bought, beside what it cost: the two numbers are only
  // worth anything together, and a morning that spent forty dollars on three
  // commits is a different morning from one that spent it on thirty.
  rows.push(blank(inner))
  rows.push(row().space().text('PRODUCED', skin.label).build())
  const made = view?.produced
  if (!made || made.commits === 0) {
    rows.push(row().space(3).text('Nothing committed.', skin.hint).build())
  } else {
    const nobody = made.commits - made.attributed
    const line = row().space()
    line.text(pad(`${made.commits} commit${made.commits === 1 ? '' : 's'}`, 13))
    line.text(`+${made.added}`, skin.done).space().text(`−${made.removed}`, skin.bad).space(2)
    line.text(`${made.files} file${made.files === 1 ? '' : 's'}`, skin.hint)
    // Unattributed is always an allowed answer: usually a person committing by
    // hand, sometimes an agent that was never told to write its trailer.
    if (nobody > 0) line.space(2).text(`${nobody} unattributed`, skin.hint)
    rows.push(line.build())
  }
  // Two, not the whole suite: the panel floats over the window and every row
  // it grows is a row of the work underneath that somebody cannot see. The
  // busiest two are the ones worth a glance; `tade spend` lists them all.
  for (const check of (view?.checks ?? []).slice(0, 2)) {
    const took = check.medianMs === null ? '' : `${(check.medianMs / 1000).toFixed(1)}s`
    rows.push(
      row()
        .space()
        .text(pad(check.check, 13))
        .text(pad(`${check.runs} run${check.runs === 1 ? '' : 's'}`, 9), skin.hint)
        .text(
          pad(check.failed > 0 ? `${check.failed} failed` : 'all green', 12),
          check.failed > 0 ? skin.bad : skin.done,
        )
        .text(took, skin.hint)
        .build(),
    )
  }

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
  for (const budget of budgets.slice(0, 5)) {
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
  // What kind of money and what kind of hours this page has been adding, as
  // marks rather than as paragraphs. Both caveats are real — a total that
  // silently mixes priced and guessed dollars is the one thing this page may
  // never draw, and `13d 3h` off a machine that has been on since breakfast
  // reads as a bug — but each is a few words here and a sentence in `tade
  // spend`, which is where somebody asks.
  const foot = spendFooter(view)
  if (foot) {
    rows.push(blank(inner))
    rows.push(
      row()
        .space()
        .text(cap(foot, inner - 1), skin.hint)
        .build(),
    )
  }

  return box('Spend', rows, width, skin, { corner: 'esc' })
}

/** As wide as the table wants, and never wider than the window it floats over. */
const SPEND_WIDTH = 84

/** A space, the state mark, and the space after it: where every name starts. */
const LEAD = 3
/** The clear column between one column and the next. Never zero: that was the bug. */
const SPEND_GAP = 2
const TOKENS_W = 6
const RUNTIME_W = 7
/** Room for the figure and the mark that says whether anybody priced it. */
const COST_W = 9

/** How many lines the table may take before it starts saying what it left out. */
const SPEND_LINES = 10

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
  const figures = LEAD + SPEND_GAP + TOKENS_W + SPEND_GAP + 1 + RUNTIME_W + COST_W
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
 * A name over the lines it needs, with what the row is underneath it.
 *
 * Two lines for the name, because twice a column holds every model id and task
 * name there is, and the last of them ellipsised — a name cut without saying
 * so is a name a person misreads rather than looks up. The note is its own
 * line in its own tone: `not recorded` is not an agent called that.
 */
export function nameLines(
  label: string,
  note: string | null,
  width: number,
): { text: string; note: boolean }[] {
  const lines = wrapTo(label, width, 2).map((text) => ({ text, note: false }))
  if (lines.length === 0) lines.push({ text: cap(label, width), note: false })
  if (note) lines.push({ text: cap(note, width), note: true })
  return lines
}

/** The one character that says this figure holds money nobody priced. */
function pricedMark(priced: Priced): string {
  return priced === 'estimate' || priced === 'mixed' ? '~' : ''
}

/**
 * The one line under the page: what of the money nobody priced, and what of
 * the hours was added across runs.
 *
 * A mark and a few words each, never the paragraph they used to be. Nothing is
 * lost by it — `tade spend` says both in full, in `runtimeSays`'s own words,
 * which is the only place either sentence now lives — and a caveat repeated in
 * four lines under every figure is one people stop reading. Empty where
 * neither is true: money everybody priced over a single run needs no footnote
 * at all.
 */
export function spendFooter(view: SpendView | null): string {
  const said: string[] = []
  if (!view || view.priced === 'none') said.push('a plan, not money')
  else if (view.priced === 'mixed') said.push(`~ ${money(view.usdEstimated)} estimated`)
  else if (view.priced === 'estimate') said.push('~ estimated')
  const ran = view?.runtime
  if (ran && ran.runs > 1) said.push(`${duration(ran.ms)} over ${ran.runs} runs`)
  return said.join('  ·  ')
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
