import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { KEY_BINDINGS } from '@tade/core'
import type { Hit } from '../../hits.ts'
import { keyCaps } from '../../keys.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap, fitTo, pad } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import {
  type BranchPanel,
  branchChoices,
  type CloseDonePanel,
  type ConfirmPanel,
  type ConfirmRemovePanel,
  type DiffPanel,
  type FindPanel,
  noteFacts,
  type PromptPanel,
  type QuitPanel,
  type ReloadPanel,
} from './state.ts'

// How each of the one-question panels looks. What a key does to one is beside
// this in `state.ts`.

export function keysSheet(ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(92, ctx.width - 4)
  const inner = width - 2
  const label = (text: string) =>
    new Row(inner, skin, ctx.pointer).space().text(pad(text, 26), skin.label)
  // What a key does, in whatever room its caps leave: capped a column short
  // of the edge, so a long one ends in an ellipsis instead of running into
  // the border of the box it is in.
  const means = (row: Row, text: string) =>
    row.text(cap(text, Math.max(0, inner - row.used - 1)), skin.hint).build()
  const talk = ctx.talkKey
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    means(
      label('Push to talk').keys(keyCaps(talk)).space(2),
      ctx.releases && ctx.talkMode === 'hold' ? 'hold' : 'press, press again',
    ),
  ]
  // Every other key the window keeps, as it is set now.
  for (const binding of KEY_BINDINGS) {
    const bound = ctx.bindings[binding.key] ?? binding.fallback
    rows.push(means(label(binding.title).keys(keyCaps(bound)).space(2), binding.means))
  }
  rows.push(
    blank(inner),
    means(
      label('On the orchestrator line')
        .keys(['↑'])
        .keys(['↓'])
        .space()
        .keys(['ctrl', 'r'])
        .space(2),
      'what you said before',
    ),
    // Two keys people reach for at the same moment and mean opposite things
    // by, so each says what it leaves alone.
    means(
      label('Stop the orchestrator').keys(['esc']).space(2),
      'stops the turn it is on · what you typed stays',
    ),
    means(
      label('Discard what you typed').keys(['ctrl', 'c']).space(2),
      'the line and the pictures with it',
    ),
    means(label('Quit').keys(['ctrl', 'c']).space(2), 'once there is nothing left to discard'),
    means(
      label('In a panel')
        .keys(['enter'])
        .space()
        .keys(['esc'])
        .space()
        .keys(['↑'])
        .keys(['↓'])
        .space(2),
      'the wheel scrolls it',
    ),
    means(
      label('In a file you are reading')
        .keys(['ctrl', 'f'])
        .keys(['ctrl', 'g'])
        .keys(['ctrl', 's'])
        .space(2),
      'find · line · save',
    ),
    blank(inner),
    new Row(inner, skin)
      .space()
      .text("Everything else goes to the agent or terminal you're typing at.", skin.hint)
      .build(),
    new Row(inner, skin, ctx.pointer)
      .right((r) => r.button('Change shortcuts…', { kind: 'control', id: 'change-keys' }).space())
      .build(),
  )
  return box('Shortcuts', rows, width, skin, { corner: 'esc' })
}

export function quit(panel: QuitPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(62, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const running = ctx.running
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row()
      .space()
      .text(
        `${running} agent${running === 1 ? ' is' : 's are'} running inside this window.`,
        skin.you,
      )
      .build(),
    blank(inner),
    row()
      .space()
      .text('Closing stops them under ')
      .text('pty', skin.busy)
      .text('; they reopen where they were.')
      .build(),
    row()
      .space()
      .text('Settings › Agents › Where agents run', skin.link, { kind: 'control', id: 'where' })
      .build(),
    blank(inner),
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button('Stop agents and close', { kind: 'control', id: 'quit' }, 'attention')
          .space(),
      )
      .build(),
  ]
  return box('Close Tade?', rows, width, skin, { corner: 'esc' })
}

export function reload(panel: ReloadPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(62, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const running = ctx.running
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row()
      .space()
      .text(
        `${running} agent${running === 1 ? ' is' : 's are'} running inside this window.`,
        skin.you,
      )
      .build(),
    blank(inner),
    row()
      .space()
      .text('Reload stops them under ')
      .text('pty', skin.busy)
      .text('; they reopen where they were.')
      .build(),
    blank(inner),
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button('Reload anyway', { kind: 'control', id: 'reload' }, 'attention')
          .space(),
      )
      .build(),
  ]
  return box('Reload Tade?', rows, width, skin, { corner: 'esc' })
}

/** One line asked for: a note, with whether it is about everything, or a branch name. */
export function prompt(panel: PromptPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(72, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]
  // A note opens on what it is before it opens on the field: the headline it
  // was given, what it is about, and who said it when. The words under the
  // field are the note itself, whole — this page is where it is read.
  if (panel.note) {
    const at = Date.parse(panel.note.at)
    const facts = noteFacts(panel.note, Number.isNaN(at) ? panel.note.at : ctx.date(at))
    if (panel.note.summary) {
      for (const line of wrapTextWithAnsi(panel.note.summary, inner - 2).slice(0, 2)) {
        rows.push(row().space().text(line, skin.you).build())
      }
    }
    rows.push(row().space().text(facts.about, skin.hint).build())
    rows.push(row().space().text(facts.said, skin.hint).build())
    rows.push(blank(inner))
  }
  // Which note a headline is being written for: its own words, quietly, since
  // the page it was asked from is gone while this is answered.
  if (panel.purpose === 'note-headline') {
    const said = (panel.target ?? '').split('\u0000').slice(1).join('\u0000')
    if (said) {
      rows.push(
        row()
          .space()
          .text(fitTo(said, inner - 2), skin.hint)
          .build(),
      )
      rows.push(blank(inner))
    }
  }
  rows.push(
    row().space().text(panel.label, skin.label).build(),
    row()
      .space()
      .field(panel.text, inner - 2, { caret: true })
      .build(),
  )
  // A field shows the end of what is typed; a note is read whole, under it.
  const aNote = panel.purpose === 'note' || panel.purpose === 'edit-note'
  if (aNote && visibleWidth(panel.text) > inner - 5) {
    for (const line of wrapTextWithAnsi(panel.text, inner - 3).slice(0, 8)) {
      rows.push(row().space(2).text(line, skin.hint).build())
    }
  }
  if (panel.purpose === 'note') {
    rows.push(blank(inner))
    rows.push(
      row()
        .space()
        .radio(!panel.everywhere, `About ${ctx.project ?? 'this project'}`, {
          kind: 'control',
          id: 'everywhere',
        })
        .space(3)
        .radio(panel.everywhere, 'About everything', { kind: 'control', id: 'everywhere' })
        .build(),
    )
    rows.push(row().space().text('Kept word for word.', skin.hint).build())
  }
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  const buttons = row()
  // Taking it back sits apart from saving it, at the other end of the row:
  // nothing can recover a note, so its press is never the one beside ⏎.
  if (panel.note) {
    buttons
      .space()
      .button('Forget', { kind: 'control', id: 'forget' }, 'danger')
      .space()
      .button('Copy', { kind: 'control', id: 'copy' })
      .space()
      // The one place a headline is written for a note that was taken before
      // anybody wrote one, or given a worse one than it deserved.
      .button(panel.note.summary ? 'Headline…' : 'Add a headline…', {
        kind: 'control',
        id: 'headline',
      })
  }
  rows.push(
    buttons
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Saving…' : aNote ? 'Save note ⏎' : 'Save ⏎',
            { kind: 'control', id: 'save' },
            panel.busy ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )
  return box(panel.title, rows, width, skin, { corner: 'esc' })
}

/** The project's branches, narrowed by typing, with a new one offered for a name nobody has. */
export function branches(panel: BranchPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(72, ctx.width - 4)
  const inner = width - 2
  const choices = branchChoices(ctx.branches, panel.query)
  const room = Math.max(4, Math.min(40, ctx.height - 12))
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(panel.query, inner - 2, { caret: true })
      .build(),
    new Row(inner, skin)
      .space()
      .text(`on ${ctx.checkout ?? 'no branch'} now`, skin.hint)
      .build(),
    blank(inner),
  ]
  const start = Math.max(0, Math.min(panel.index - room + 1, choices.length - room))
  choices.slice(start, start + room).forEach((choice, offset) => {
    const at = start + offset
    const on = at === panel.index
    const r = new Row(inner, skin).marker(on).space()
    if (choice.create) {
      r.text('+ ', skin.signal)
        .text('Create ', on ? skin.you : (t: string) => t)
        .text(choice.name, skin.busy)
    } else {
      r.text(choice.row?.current ? '● ' : '  ', skin.done).text(
        choice.name,
        on ? skin.you : skin.busy,
      )
      const when = choice.row?.when ?? ''
      r.right((g) => g.text(choice.row?.current ? 'current' : when, skin.hint).space())
    }
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'control', id: `row:${at}` } }],
    })
  })
  if (choices.length === 0)
    rows.push(new Row(inner, skin).space().text('No branch like that.', skin.hint).build())
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
        panel.busy ? 'Switching…' : '↑↓ choose · enter switches · a new name creates it',
        skin.hint,
      )
      .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
      .build(),
  )
  return box('Switch branch', rows, width, skin, { corner: 'esc' })
}

/** Finding in a terminal: the box, how many, and older and newer. */
export function find(panel: FindPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(58, ctx.width - 4)
  const inner = width - 2
  const count = ctx.found
  const said =
    panel.query === ''
      ? ''
      : count === 0
        ? 'none'
        : `${Math.min(panel.index + 1, count)} of ${count}`
  const row = new Row(inner, skin, ctx.pointer)
    .space()
    .field(panel.query, inner - 22, { caret: true })
    .space()
    .text(said.padEnd(9), count === 0 && panel.query ? skin.waiting : skin.hint)
    .button('↑', { kind: 'control', id: 'older' }, count > 1 ? 'rest' : 'off')
    .button('↓', { kind: 'control', id: 'newer' }, count > 1 ? 'rest' : 'off')
  return box(`Find in ${ctx.terminalName}`, [row.build()], width, skin, { corner: 'esc' })
}

/** Throwing a file's uncommitted changes away, asked first. */
export function confirm(panel: ConfirmPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row().space().text(panel.path, skin.you).build(),
    blank(inner),
    row().space().text('Back to the last commit — a new file is deleted.').build(),
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
    row()
      .right((r) =>
        r
          .button('Keep them', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Discarding…' : 'Discard',
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  ]
  return box('Discard changes?', rows, width, skin, { corner: 'esc' })
}

export function confirmRemove(panel: ConfirmRemovePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const name = panel.task.split('/').at(-1) ?? panel.task
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]

  const unmerged = ctx.changes.length > 0 || (ctx.ahead ?? 0) > 0
  if (unmerged) {
    rows.push(row().space().text("Its worktree has work that isn't merged:").build())
    for (const change of ctx.changes.slice(0, 6)) {
      const tone =
        change.mark === 'A' || change.mark === '?'
          ? skin.done
          : change.mark === 'D'
            ? skin.bad
            : skin.waiting
      rows.push(row().space(3).text(change.mark, tone).space().text(change.path).build())
    }
    if (ctx.changes.length > 6)
      rows.push(
        row()
          .space(5)
          .text(`and ${ctx.changes.length - 6} more`, skin.hint)
          .build(),
      )
    if ((ctx.ahead ?? 0) > 0 && ctx.branch) {
      const commits = `${ctx.ahead} commit${ctx.ahead === 1 ? '' : 's'}`
      rows.push(
        row()
          .space(3)
          .text(
            `${commits} on ${ctx.branch} that ${ctx.base ?? 'its base'} doesn't have`,
            skin.hint,
          )
          .build(),
      )
    }
  } else {
    rows.push(row().space().text('Nothing in it is unmerged.').build())
  }
  rows.push(blank(inner))
  rows.push(row().space().text('Deletes the worktree and branch; the conversation stays.').build())
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Keep it', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Removing…' : unmerged ? 'Remove anyway' : 'Remove',
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return box(`Remove ${name}?`, rows, width, skin, { corner: 'esc' })
}

/**
 * Closing every agent that has finished, asked first: what it would close, by
 * name, so a list that is longer than you thought is still your decision.
 */
export function closeDone(panel: CloseDonePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const count = panel.tasks.length
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]
  for (const task of panel.tasks.slice(0, 6)) {
    rows.push(
      row()
        .space(3)
        .text('✓', skin.done)
        .space()
        .text(task.split('/').at(-1) ?? task)
        .build(),
    )
  }
  if (count > 6)
    rows.push(
      row()
        .space(5)
        .text(`and ${count - 6} more`, skin.hint)
        .build(),
    )
  rows.push(blank(inner))
  rows.push(
    row().space().text('Each stops, with its worktree and branch; conversations stay.').build(),
  )
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Keep them', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Closing…' : `Close ${count}`,
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return box(`Close ${count} finished agent${count === 1 ? '' : 's'}?`, rows, width, skin, {
    corner: 'esc',
  })
}

export function diff(panel: DiffPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(96, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const path = panel.files[panel.file] ?? ''
  const name = panel.task.split('/').at(-1) ?? panel.task
  const room = Math.max(6, Math.min(24, ctx.height - 10))
  const rows: { text: string; hits: Hit[] }[] = []
  const parsed = ctx.diff

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
    const scroll = Math.min(panel.scroll, Math.max(0, parsed.lines.length - room))
    for (const line of parsed.lines.slice(scroll, scroll + room)) {
      const r = row().space()
      if (line.kind === 'hunk') {
        r.text(line.text, skin.hint)
      } else {
        const number = String((line.kind === 'remove' ? line.old : line.new) ?? '').padStart(
          numberWidth,
        )
        r.text(number, skin.hint).space()
        const sign = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '
        const tone =
          line.kind === 'add' ? skin.done : line.kind === 'remove' ? skin.bad : (t: string) => t
        r.text(`${sign}${line.text}`, tone)
      }
      rows.push(r.build())
    }
  }
  while (rows.length < Math.min(room, 4)) rows.push(blank(inner))
  rows.push(blank(inner))
  rows.push(
    row()
      .space()
      .button('Open in editor', { kind: 'control', id: 'editor' })
      .space()
      .button('Ask the agent about this', { kind: 'control', id: 'ask' })
      .right((r) => {
        if (panel.files.length > 1) {
          r.text('‹', skin.signal, { kind: 'control', id: 'prev-file' })
            .text(` ${panel.file + 1}/${panel.files.length} `, skin.hint)
            .text('›', skin.signal, { kind: 'control', id: 'next-file' })
            .space(2)
        }
        r.text('↑↓ scroll · ←→ file', skin.hint).space()
      })
      .build(),
  )
  const counts =
    parsed && !parsed.binary
      ? `${skin.done(`+${parsed.added}`)} ${skin.bad(`−${parsed.removed}`)} `
      : ''
  return box(`${path} · ${name}`, rows, width, skin, { corner: `${counts}esc` })
}
