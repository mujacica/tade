import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Hit } from '../../hits.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import { type ModelPanel, modelChoices, priceCells } from './state.ts'

// What the model panel looks like. What a key does to it is beside this in
// `state.ts`.

/** One price column: room for `$12.50` or `varies`, and the gap before it. */
const PRICE_CELL = 8
const PRICE_COLUMNS = PRICE_CELL * 3

/**
 * Choosing a model: typing narrows by provider, id or name, the one in use is
 * marked, what each costs is in columns you can run your eye down, and a fixed
 * height so the list does not jump while it narrows.
 *
 * Every model on it is one the harness it is for can run, and the list says
 * whose it is. A harness that could not say has no list, and then the panel
 * says its sentence instead of showing somebody else's models — one chosen
 * from another harness's catalog is a name that fails at the next launch.
 */
export function models(panel: ModelPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(120, ctx.width - 4)
  const inner = width - 2
  const choices = modelChoices(ctx.models, panel.query)
  // As tall as the window allows: a long list is scrolled, never cut short.
  const room = Math.max(4, Math.min(40, ctx.height - 12))
  // Columns that stay put while you type: the model, as wide as the longest in
  // the catalog allows; what it costs; then its name, where there is room.
  const lead = 4
  const idWidth = Math.min(
    40,
    Math.max(16, ...ctx.models.map((model) => visibleWidth(model.id) - model.provider.length - 1)),
  )
  const priced = inner >= lead + idWidth + PRICE_COLUMNS && ctx.models.some((one) => one.price)
  const nameRoom = inner - lead - idWidth - (priced ? PRICE_COLUMNS : 0) - 3
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(panel.query, inner - 2, {
        caret: true,
        ...(panel.query ? {} : { ghost: 'type to narrow: opus, kimi, openrouter…' }),
      })
      .build(),
    new Row(inner, skin)
      .space()
      .text(`${ctx.modelTarget} is on `, skin.hint)
      .text(ctx.currentModel ?? 'its default model', skin.busy)
      .text(ctx.modelsFrom ? `, in ${ctx.modelsFrom.harness}` : '', skin.hint)
      .build(),
    blank(inner),
  ]
  if (priced) {
    // What the price columns are, over them.
    const head = new Row(inner, skin).space(lead + idWidth)
    for (const label of ['in', 'out', 'cached']) head.text(label.padStart(PRICE_CELL), skin.label)
    if (nameRoom >= 14) head.space(3).text('$ per 1M tokens', skin.hint)
    rows.push(head.build())
  }
  const start = Math.max(0, Math.min(panel.index - room + 1, choices.length - room))
  choices.slice(start, start + room).forEach((choice, offset) => {
    const at = start + offset
    const on = at === panel.index
    const current =
      ctx.currentModel !== null &&
      (choice.id === ctx.currentModel || choice.id.endsWith(`/${ctx.currentModel}`))
    const r = new Row(inner, skin)
      .marker(on)
      .space()
      .text(current ? '● ' : '  ', skin.done)
    const id = choice.id.slice(choice.provider.length + 1)
    const shownId = visibleWidth(id) > idWidth ? truncateToWidth(id, idWidth, '…') : id
    r.text(shownId, on ? skin.you : skin.busy).space(idWidth - visibleWidth(shownId))
    if (priced) {
      const [input, output, cached] = priceCells(choice)
      const tone = input === 'free' ? skin.done : input === 'varies' ? skin.hint : (t: string) => t
      for (const cell of [input, output, cached]) r.text(cell.padStart(PRICE_CELL), tone)
    }
    if (nameRoom >= 8) {
      const said = `${choice.name} · ${choice.provider}`
      r.space(3).text(
        visibleWidth(said) > nameRoom ? truncateToWidth(said, nameRoom, '…') : said,
        skin.hint,
      )
    }
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'control', id: `row:${at}` } }],
    })
  })
  if (choices.length === 0) {
    // Nothing to choose between is two different things: nothing this harness
    // runs matches what was typed, or the harness could not say what it runs
    // at all — and then it is the harness's own sentence, never a fallback to
    // another harness's list.
    const why = ctx.models.length === 0 ? (ctx.modelsFrom?.why ?? null) : null
    rows.push(
      new Row(inner, skin)
        .space()
        .text(
          why
            ? `${ctx.modelsFrom?.harness} ${why}`
            : `No model like that among the ones ${ctx.modelsFrom?.harness ?? 'this harness'} runs.`,
          why ? skin.waiting : skin.hint,
        )
        .build(),
    )
  }
  for (let gap = room - Math.min(room, Math.max(1, choices.length)); gap > 0; gap--)
    rows.push(blank(inner))
  rows.push(
    panel.error
      ? new Row(inner, skin).space().text(`▲ ${panel.error}`, skin.waiting).build()
      : blank(inner),
  )
  rows.push(
    new Row(inner, skin, ctx.pointer)
      .space()
      .text(
        panel.busy
          ? 'Switching…'
          : `↑↓ choose · enter switches · ${choices.length} of ${ctx.models.length}${ctx.modelsFrom ? ` in ${ctx.modelsFrom.harness}` : ''}`,
        skin.hint,
      )
      .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
      .build(),
  )
  return box(`Model for ${ctx.modelTarget}`, rows, width, skin, { corner: 'esc' })
}
