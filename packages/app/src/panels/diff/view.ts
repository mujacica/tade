import { printable } from '@tade/core'
import { fileText } from '../../highlight.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { TAB } from '../../viewer.ts'
import { COMMENTED, commentBar, toLabel } from '../comment.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize } from '../frame.ts'
import { type DiffPanel, keptOn } from './state.ts'

// How the patch reader looks: git's answer for one file, the line the keyboard
// is on marked down the side, a dot beside every line a comment is kept on,
// and under it the comment box or what the marked line's comment says. What a
// key does is beside this in `state.ts`.

export function diff(panel: DiffPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 96 })
  // The diff keeps a column for its bar: it is the one panel where how far
  // through a file you are is most of what you want to know.
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const path = panel.files[panel.file] ?? ''
  const name = panel.task.split('/').at(-1) ?? panel.task
  const rows: Line[] = []
  const parsed = ctx.diff
  const here = ctx.comments?.here ?? []

  if (!parsed) {
    rows.push(row().space().text('reading the diff…', skin.hint).build())
  } else if (parsed.binary) {
    rows.push(row().space().text('Binary — no lines to show.', skin.hint).build())
  } else if (parsed.lines.length === 0) {
    rows.push(row().space().text('No differences from its base.', skin.hint).build())
  } else {
    const numberWidth = String(
      Math.max(...parsed.lines.map((line) => line.new ?? line.old ?? 0)),
    ).length
    // A changed file's lines are its author's, an agent's as often as not:
    // drawn as text, a tab as wide as the viewer draws one.
    const said = (text: string) => fileText(text).replaceAll('\t', TAB)
    parsed.lines.forEach((line, at) => {
      const r = row().space()
      if (line.kind === 'hunk') {
        r.text(said(line.text), skin.hint)
        rows.push(r.build())
        return
      }
      const on = panel.at === at
      const number = String((line.kind === 'remove' ? line.old : line.new) ?? '').padStart(
        numberWidth,
      )
      // The mark column: where the keyboard is, else whether a comment is
      // kept here — the same column, so lighting one moves nothing.
      const mark = on ? '▶' : keptOn(line, here) ? COMMENTED : ' '
      r.text(mark, on || mark === COMMENTED ? skin.signal : skin.hint)
        .text(number, skin.hint)
        .space()
      const sign = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '
      const tone =
        line.kind === 'add' ? skin.done : line.kind === 'remove' ? skin.bad : (t: string) => t
      r.text(`${sign}${said(line.text)}`, tone)
      const built = r.build()
      // The whole line is something to press: it is where a comment goes.
      rows.push({
        text: on ? skin.selected(built.text) : built.text,
        hits: [
          ...built.hits,
          { row: 0, from: 0, to: inner - 1, target: { kind: 'control', id: `line:${at}` } },
        ],
      })
    })
  }
  const drafted = ctx.comments?.total ?? 0
  const kept = keptOn(panel.at === null ? undefined : parsed?.lines[panel.at], here)
  const said = panel.composing
    ? commentBar(panel.composing, `On line ${panel.composing.line}`, inner, ctx)
    : kept
      ? row()
          .space()
          .text(`${COMMENTED} to ${toLabel(kept.to, ctx.commentTo ?? [])}: `, skin.signal)
          .text(kept.words.replaceAll('\n', ' ⏎ '), skin.you)
          .build()
      : blank(inner)
  // The keys in whatever room the buttons and the file stepper leave: which
  // line you are on and that `c` writes on it are what this row says first.
  const stepper = ` ${panel.file + 1}/${panel.files.length} `
  const buttons =
    1 +
    (drafted > 0 ? `Send ${drafted}`.length + 5 : 0) +
    'Open in editor'.length +
    5 +
    'Ask the agent about this'.length +
    4
  const room = inner - buttons - (panel.files.length > 1 ? stepper.length + 4 : 0) - 2
  const keys = KEYS.find((one) => one.length <= room) ?? ''
  const drawn = column(
    {
      body: {
        lines: rows,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following && panel.at !== null ? { from: panel.at, to: panel.at } : null,
      },
      foot: [
        said,
        sendFirst(row().space(), drafted)
          .button('Open in editor', { kind: 'control', id: 'editor' })
          .space()
          .button('Ask the agent about this', { kind: 'control', id: 'ask' })
          .right((r) => {
            if (panel.files.length > 1) {
              r.text('‹', skin.signal, { kind: 'control', id: 'prev-file' })
                .text(stepper, skin.hint)
                .text('›', skin.signal, { kind: 'control', id: 'next-file' })
                .space(2)
            }
            if (keys) r.text(keys, skin.hint).space()
          })
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  const counts =
    parsed && !parsed.binary
      ? `${skin.done(`+${parsed.added}`)} ${skin.bad(`−${parsed.removed}`)} `
      : ''
  return box(`${printable(path)} · ${name}`, drawn.rows, width, skin, { corner: `${counts}esc` })
}

/** What the foot says of the keys, longest first: the first that fits is drawn. */
const KEYS = ['↑↓ line · c comment · ←→ file', '↑↓ line · c comment', 'c comment']

/**
 * Send, where there is something to send, and first on the row: it is what
 * the comments are waiting for. Not drawn with nothing kept, because a button
 * with nothing to act on is a button somebody presses to find out.
 */
function sendFirst(row: Row, drafted: number): Row {
  if (drafted === 0) return row
  return row.button(`Send ${drafted}`, { kind: 'control', id: 'send' }, 'go').space()
}
