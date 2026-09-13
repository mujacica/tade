import type { Hit } from './hits.ts'
import { type AgentPane, glyph } from './model.ts'
import { branchPreview, type NewTaskPanel, type Panel, type SpendPanel } from './panels.ts'
import type { Skin } from './skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendView } from './spend.ts'
import { blank, box, type Drawn, type Pointer, Row } from './ui.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.

export interface PanelContext {
  width: number
  height: number
  skin: Skin
  pointer: Pointer
  /** Wilco's home, as you would type it: where worktrees are made. */
  home: string
  route: { harness: string; model: string | null; provider: string | null } | null
  /** Where the money went, for the window and grouping the Spend panel is on. */
  spend: SpendView | null
  /** The tasks, for giving each spend row its state. */
  panes: readonly AgentPane[]
  /** The project you are in: its tasks are named short. */
  project: string | null
}

export function drawPanel(panel: Panel, ctx: PanelContext): Drawn {
  switch (panel.kind) {
    case 'new-task':
      return newTask(panel, ctx)
    case 'spend':
      return spend(panel, ctx)
  }
}

function spend(panel: SpendPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(74, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.spend
  const rows: { text: string; hits: Hit[] }[] = []

  const head = row().space()
  head.text(view?.hasCost ? money(view.usd) : '—', skin.you).space(2)
  head.text(tokenCount(view?.tokens ?? 0), skin.hint)
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

  const by = row().space().text('by ', skin.hint)
  for (const option of SPEND_BY) {
    by.tab(option.label, { kind: 'control', id: `by:${option.id}` }, panel.by === option.id)
  }
  rows.push(by.build())
  rows.push(blank(inner))

  const name = 18
  const model = 16
  const bar = 12
  rows.push(
    row()
      .space()
      .text(
        `${pad('WHO', name + 2)}${pad(panel.by === 'model' ? '' : 'MODEL', model)} ${'TOKENS'.padStart(6)}  ${pad('SHARE', bar)}${'COST'.padStart(8)}`,
        skin.label,
      )
      .build(),
  )
  const total = Math.max(1, view?.tokens ?? 0)
  // The orchestrator first, as its own line: it is the one cost that is not
  // any task's, and the one people forget is running.
  const entries = [...(view?.rows ?? [])].sort(
    (a, b) => Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator'),
  )
  if (entries.length === 0) {
    rows.push(row().space(3).text('Nothing spent in this window.', skin.hint).build())
  }
  for (const entry of entries.slice(0, 8)) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(pad(label, name))
        .text(pad(entry.model ? shortModel(entry.model) : '', model), skin.hint)
        .space()
        .text(tokenCount(entry.tokens, false).padStart(6))
        .space(2)
        .meter(entry.tokens / total, bar)
        .text((view?.hasCost ? money(entry.usd) : '—').padStart(8))
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
  for (const budget of budgets.slice(0, 5)) {
    const line = row().space().text(pad(budget.project, 11))
    const limit = budget.budget?.usd_per_day
    const spent = limit
      ? `${money(budget.usd)} of ${money(limit)} a day`
      : budget.budget?.tokens_per_day
        ? `${tokenCount(budget.tokens, false)} of ${tokenCount(budget.budget.tokens_per_day, false)} a day`
        : money(budget.usd)
    line.text(pad(spent, 25))
    if (budget.share !== null) {
      const tone =
        budget.verdict === 'over' ? skin.bad : budget.verdict === 'warn' ? skin.waiting : skin.done
      line
        .meter(Math.min(1, budget.share), 12, tone)
        .space()
        .text(`${Math.round(budget.share * 100)}%`, skin.hint)
    } else {
      line
        .text('no budget — ', skin.hint)
        .text('set one', skin.link, { kind: 'action', name: 'settings' })
    }
    rows.push(line.build())
  }
  rows.push(blank(inner))
  rows.push(row().space().text('Prices as pi reports them.', skin.hint).build())

  return box('Spend', rows, width, skin, { corner: 'esc' })
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  if (pane.waiting || pane.state === 'blocked') return skin.waiting
  if (pane.state === 'failed') return skin.bad
  if (pane.state === 'review') return skin.done
  if (pane.state === 'working') return skin.busy
  return skin.hint
}

function pad(text: string, width: number): string {
  const cut = [...text].slice(0, width).join('')
  return cut + ' '.repeat(Math.max(0, width - cut.length))
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

/** The control that has the keyboard looks the way it would under the pointer. */
function pointerFor(ctx: PanelContext, focused: string | null): Pointer {
  if (ctx.pointer.hover || !focused) return ctx.pointer
  return { ...ctx.pointer, hover: { kind: 'control', id: focused } }
}

function newTask(panel: NewTaskPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(76, ctx.width - 4)
  const inner = width - 2
  const pointer = pointerFor(
    ctx,
    panel.field === 'cancel' || panel.field === 'go' ? panel.field : null,
  )
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []

  const projects = row().space().text('Project  ', skin.hint)
  for (const project of panel.projects) {
    projects.tab(project, { kind: 'control', id: `project:${project}` }, project === panel.project)
  }
  if (panel.field === 'project') projects.text('  ← →', skin.hint)
  rows.push(projects.build())
  rows.push(blank(inner))

  rows.push(row().space().text('What needs doing?', skin.you).build())
  rows.push(
    row()
      .space()
      .field(panel.intent, inner - 2, {
        caret: panel.field === 'intent',
        hint: panel.intent === '' && panel.field !== 'intent',
        target: { kind: 'control', id: 'intent' },
      })
      .build(),
  )

  const said = panel.intent.trim()
  const slug = said ? branchPreview(said) : null
  rows.push(
    row()
      .space()
      .text('branch   ', skin.hint)
      .text(slug ?? '—', slug ? (t) => t : skin.hint)
      .build(),
  )
  rows.push(
    row()
      .space()
      .text('worktree ', skin.hint)
      .text(
        slug && panel.project
          ? `${ctx.home}/worktrees/${panel.project}-${slug.slice('wilco/'.length)}`
          : '—',
        skin.hint,
      )
      .build(),
  )
  rows.push(blank(inner))

  const route = ctx.route
  const agent = row().space().text('Agent    ', skin.hint)
  agent.field(`${route?.harness ?? 'pi'} · ${route?.model ?? 'its default model'}`, 40, {
    arrow: true,
    target: { kind: 'control', id: 'model' },
  })
  agent.right((r) => {
    r.check(panel.start, 'start now', { kind: 'control', id: 'start' }).space()
  })
  rows.push(agent.build())

  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )

  rows.push(
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Starting…' : 'Start task ⏎',
            { kind: 'control', id: 'go' },
            panel.busy ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )

  return box('New task', rows, width, skin, { corner: 'esc' })
}
