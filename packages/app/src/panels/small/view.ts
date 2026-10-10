import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { KEY_BINDINGS, KEYS_AND_AGENTS } from '@tade/core'
import { type Hit, sameTarget } from '../../hits.ts'
import { keyCaps } from '../../keys.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap, fitTo, pad, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook } from '../frame.ts'
import {
  type BranchPanel,
  branchChoices,
  type CloseDonePanel,
  type ConfirmPanel,
  type ConfirmRemovePanel,
  type DiffPanel,
  type FindPanel,
  type KeysPanel,
  noteFacts,
  type PromptPanel,
  type QuitPanel,
  type ReloadPanel,
} from './state.ts'

// How each of the one-question panels looks. What a key does to one is beside
// this in `state.ts`.

export function keysSheet(panel: KeysPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 92 })
  // The sheet keeps a column for its bar: it is thirty lines on a terminal
  // that may have fourteen, and the last of them used to be off the bottom
  // with nothing to say so.
  const inner = width - 2 - BAR
  const label = (text: string) =>
    new Row(inner, skin, ctx.pointer).space().text(pad(text, 26), skin.label)
  // What a key does, in whatever room its caps leave: capped a column short
  // of the edge, so a long one ends in an ellipsis instead of running into
  // the border of the box it is in.
  const means = (row: Row, text: string) =>
    row.text(cap(text, Math.max(0, inner - row.used - 1)), skin.hint).build()
  const talk = ctx.talkKey
  const rows: Line[] = [
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
  )
  const drawn = column(
    {
      body: { lines: rows, width: inner, scroll: panel.scroll },
      foot: [
        blank(inner),
        new Row(inner, skin, ctx.pointer)
          .right((r) =>
            r.button('Change shortcuts…', { kind: 'control', id: 'change-keys' }).space(),
          )
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box('Shortcuts', drawn.rows, width, skin, { corner: 'esc' })
}

export function quit(panel: QuitPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width } = panelSize(ctx, { max: 62 })
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
  const { width } = panelSize(ctx, { max: 62 })
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
  const { width } = panelSize(ctx, { max: 72 })
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
  // An account's key goes into the same file every other key goes into, and
  // this is the moment somebody is deciding to put one there. `wrapTo` and
  // not a slice: what would be cut on a narrow terminal is the way out, and
  // a sentence that stops mid-word with no mark reads as a bug.
  if (panel.purpose === 'account-key') {
    for (const line of wrapTo(KEYS_AND_AGENTS, inner - 2, 12)) {
      rows.push(row().space().text(line, skin.hint).build())
    }
    rows.push(blank(inner))
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
        .option(!panel.everywhere, `About ${ctx.project ?? 'this project'}`, {
          kind: 'control',
          id: 'everywhere',
        })
        .space()
        .option(panel.everywhere, 'About everything', { kind: 'control', id: 'everywhere' })
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
  // As tall as the window allows, and the same height while typing narrows it.
  const { width, rows: tall } = panelSize(ctx, { max: 72 })
  const inner = width - 2 - BAR
  const choices = branchChoices(ctx.branches, panel.query)
  const head: Line[] = [
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
  const rows: Line[] = []
  choices.forEach((choice, at) => {
    const on = at === panel.index
    const target = { kind: 'control' as const, id: `row:${at}` }
    const pointed = sameTarget(ctx.pointer.hover, target)
    const lit = on || pointed
    const r = new Row(inner, skin).marker(on).space()
    if (choice.create) {
      r.text('+ ', skin.signal)
        .text('Create ', lit ? skin.you : (t: string) => t)
        .text(choice.name, skin.busy)
    } else {
      r.text(choice.row?.current ? '● ' : '  ', skin.done).text(
        choice.name,
        lit ? skin.you : skin.busy,
      )
      const when = choice.row?.when ?? ''
      r.right((g) => g.text(choice.row?.current ? 'current' : when, skin.hint).space())
    }
    const built = r.build()
    rows.push({
      text: rowLook(built.text, skin, { on, pointed }),
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  })
  if (choices.length === 0)
    rows.push(new Row(inner, skin).space().text('No branch like that.', skin.hint).build())
  const drawn = column(
    {
      head,
      body: {
        lines: rows,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following ? { from: panel.index, to: panel.index } : null,
      },
      foot: [
        panel.error
          ? new Row(inner, skin).space().text(`▲ ${panel.error}`, skin.waiting).build()
          : blank(inner),
        new Row(inner, skin, ctx.pointer)
          .space()
          .text(
            panel.busy ? 'Switching…' : '↑↓ choose · enter switches · a new name creates it',
            skin.hint,
          )
          .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box('Switch branch', drawn.rows, width, skin, { corner: 'esc' })
}

/** Finding in a terminal: the box, how many, and older and newer. */
export function find(panel: FindPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width } = panelSize(ctx, { max: 58 })
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
  const { width } = panelSize(ctx, { max: 66 })
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
  const { width } = panelSize(ctx, { max: 66 })
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
  // The document is said *after* the unmerged work and before the consequence,
  // because it is the thing this panel was wrong about: an agent in the
  // project's own checkout has no unmerged work to lose and its task folder is
  // the only copy of what it produced, so "nothing in it is unmerged" used to
  // be the last word before a document was deleted.
  if (panel.unread) {
    rows.push(blank(inner))
    rows.push(row().space().text('It produced a document nobody has read:', skin.waiting).build())
    rows.push(row().space(3).text(panel.unread).build())
  }
  rows.push(blank(inner))
  rows.push(
    row()
      .space()
      .text(
        panel.unread
          ? 'Deletes the worktree, the branch and that document; the conversation stays.'
          : 'Deletes the worktree and branch; the conversation stays.',
      )
      .build(),
  )
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
            panel.busy ? 'Removing…' : unmerged || panel.unread ? 'Remove anyway' : 'Remove',
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
  const { width } = panelSize(ctx, { max: 66 })
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const count = panel.tasks.length
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]
  const unread = new Set(panel.unread)
  for (const task of panel.tasks.slice(0, 6)) {
    rows.push(
      row()
        .space(3)
        .text('✓', skin.done)
        .space()
        .text(task.split('/').at(-1) ?? task)
        .space()
        .text(unread.has(task) ? '· document unread' : '', skin.waiting)
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
  // Counted and said before the press. This button closed twenty agents at
  // once on the machine this was found on, and six of them had written an
  // analysis in the minutes before — all six deleted, nothing asked.
  if (unread.size > 0) {
    rows.push(
      row()
        .space()
        .text(
          `${unread.size} produced a document nobody has read. Closing deletes ${unread.size === 1 ? 'it' : 'them'}.`,
          skin.waiting,
        )
        .build(),
    )
    rows.push(blank(inner))
  }
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
  const { width, rows: tall } = panelSize(ctx, { max: 96 })
  // The diff keeps a column for its bar: it is the one panel where how far
  // through a file you are is most of what you want to know.
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const path = panel.files[panel.file] ?? ''
  const name = panel.task.split('/').at(-1) ?? panel.task
  const rows: Line[] = []
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
    for (const line of parsed.lines) {
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
  const drawn = column(
    {
      body: { lines: rows, width: inner, scroll: panel.scroll },
      foot: [
        blank(inner),
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
      ],
      rows: tall,
    },
    ctx,
  )
  const counts =
    parsed && !parsed.binary
      ? `${skin.done(`+${parsed.added}`)} ${skin.bad(`−${parsed.removed}`)} `
      : ''
  return box(`${path} · ${name}`, drawn.rows, width, skin, { corner: `${counts}esc` })
}
