import { visibleWidth } from '@earendil-works/pi-tui'
import { type FileEntry, folderMark } from '../files.ts'
import type { Change, Frame, ListRowView, ListSectionView, NoteShown } from '../frame.ts'
import { type Hit, pointingIn, rowHit, sameTarget, type Target } from '../hits.ts'
import {
  type AppState,
  agentsHere,
  doneTasks,
  groupedTasks,
  queuedCount,
  queueRows,
  schedulesShown,
  sectionOpen,
} from '../model.ts'
import { BAR, barAcross } from '../scrollbar.ts'
import type { Band, Look, Skin } from '../skin.ts'
import { blank, type Drawn, NO_POINTER, type Pointer, Row, stack } from '../ui.ts'
import { toneFor } from './actions.ts'
import { type QueueTree, queueSection, queueSpread, queueStems, taskRow } from './queue.ts'
import {
  barBeside,
  isScrolling,
  type ListItem,
  MENU_ICON,
  markTone,
  type Section,
  type SectionAction,
  TAB_EDGES,
  TAB_ICONS,
  tabbed,
  tabList,
} from './rows.ts'
import { schedulesSection } from './schedule.ts'
import { cutAtWord, inProject, saidShort, shortened, shortPath, tailOf, wrapPath } from './text.ts'

// Down the side: where you are, the agents, what they changed, the files and
// the notes — one list of sections, each with a heading you can fold.
//
// The sections themselves come from everywhere: the queue hands one back, an
// extension's rows are drawn from its own cache, and what this file does is
// fit them into the room there is. A heading gives ground in a fixed order —
// its note, then its badge, then its controls — because a side that reflowed
// differently at every width would be a side nobody could learn.

export function renderSidebar(
  state: AppState,
  frame: Frame,
  full: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  // A column of it belongs to the bar down its right; everything below is laid
  // out in what is left.
  const width = Math.max(1, full - BAR)
  // How far the queue's tree reaches against the room there is for it, and so
  // whether the side has anywhere to scroll sideways to. Worked out before
  // anything is drawn, because a bar along the bottom costs the list a row.
  const entries = queueRows(state)
  // With nothing waiting the queue is quiet: still there, still a heading you
  // can open, and folded until you do. Only work — the standing rules are
  // SCHEDULES', which is quiet or not on its own.
  const waiting = queuedCount(state)
  const queueOpen = sectionOpen(state, 'queue', waiting === 0)
  // The project's standing rules, read once: the section is handed them, the way
  // the queue is handed its count, because the side draws four times a second.
  const clocks = schedulesShown(frame.schedules ?? [], state)
  const spread = queueOpen ? queueSpread(queueStems(entries), width) : { wide: 0, shown: 0 }
  const sideways = Math.max(0, spread.wide - spread.shown)
  const across = Math.min(Math.max(0, state.across), sideways)
  const tree: QueueTree = { ...spread, across }
  // The bar lies along the bottom row, and the list gets what is left.
  const body = sideways > 0 ? Math.max(1, height - 1) : height
  const groups = groupedTasks(state)
  const tasks = groups.flatMap((group) => group.tasks)
  const changes = frame.changes ?? []
  const notes = frame.notes ?? []
  const files = frame.files ?? []
  const spend = frame.spend?.byTask ?? {}
  const where = frame.where ?? null
  // Agents that have finished: what `H` hides and `X` closes. Neither control
  // is drawn while there is nothing finished to act on — except `H` while it
  // is hiding, which has to stay reachable.
  const done = doneTasks(state).length
  const all = agentsHere(state).length

  const sections: Section[] = [
    {
      id: 'agents',
      label: 'AGENTS',
      count: tasks.length,
      of: all,
      actions: [
        ...(done > 0 || state.hidingDone
          ? [
              {
                // Letters, not glyphs: two fonts drew the pair as a blob and a
                // box, and a control nobody can make out is a control nobody
                // presses. `H` hides, and it is a switch — so while the
                // finished ones are hidden it is filled in the brand's amber,
                // what being on looks like everywhere else in the window,
                // rather than a shade of grey nobody reads as pressed — and
                // `<H>` rather than `[H]` where there is no colour to fill.
                label: 'H',
                look: state.hidingDone ? ('primary' as const) : ('rest' as const),
                target: { kind: 'action' as const, name: 'toggle-done' },
                small: true,
              },
            ]
          : []),
        ...(done > 0
          ? [
              {
                // `X` closes them, and is red only under the pointer.
                label: 'X',
                target: { kind: 'action' as const, name: 'close-done' },
                small: true,
                danger: true,
              },
            ]
          : []),
        { label: ' + ', target: { kind: 'action' as const, name: 'new-agent' } },
      ],
      banded: true,
      rows: (row) =>
        tasks.length === 0
          ? [
              blank(width),
              row()
                .space(3)
                // Hiding every agent there is leaves an empty list that would
                // otherwise say nobody has ever started one.
                .text(
                  all === 0 ? 'none yet — + starts one' : `${all} finished — H shows them`,
                  skin.hint,
                )
                .build(),
              blank(width),
            ]
          : groups.flatMap((group) => [
              // The name it was given, not the sentence it came from: the side
              // is twenty-odd columns wide and a sentence cut to that says
              // less than the slug everything else already calls the work.
              ...(group.effort
                ? [row().space(3).text(group.effort.toUpperCase(), skin.hint).build()]
                : []),
              ...tabList(
                group.tasks.map((task) =>
                  taskRow(width, skin, pointer, task, spend[task.task], frame.now ?? 0),
                ),
                width,
              ),
            ]),
    },
    // Always, so the queue is somewhere you can look rather than something
    // that appears: with nothing in it, its heading is all it costs the side.
    queueSection(state, frame, width, skin, pointer, tree, waiting, queueOpen),
    // And the clockwork under it, its own section: a standing rule fires again
    // and again and nothing waits on it, which is not what a queue is. Always
    // too, and for the same reason — a watch failing every ten minutes must be
    // somewhere a person can find without having set one first.
    schedulesSection(
      state,
      frame,
      width,
      skin,
      pointer,
      clocks,
      sectionOpen(state, 'schedules', clocks.length === 0),
    ),
    // What an extension keeps here — reviews, most of all — between the work
    // that is waiting and the work in front of you. A section with no rows
    // and nothing wrong is not drawn at all.
    ...listSections(frame, width, skin, pointer),
    {
      id: 'changes',
      label: 'CHANGES',
      count: changes.length,
      ...(frame.base ? { note: `vs ${frame.base.replace(/^origin\//, '')}` } : {}),
      rows: (row) =>
        changes.length === 0
          ? [
              // Nothing changed is about the checkout, not about the agent: it
              // used to say "open an agent to see", which was true of what it
              // read and not of what git knew.
              row()
                .space(3)
                .text(where ? 'nothing changed' : 'no checkout here', skin.hint)
                .build(),
            ]
          : changes.map((change) => changeRow(row(), change, skin, state.focused)),
    },
    {
      id: 'files',
      label: 'FILES',
      count: null,
      rows: (row) =>
        files.length === 0
          ? [row().space(3).text('—', skin.hint).build()]
          : files.map((entry) => fileRow(row(), entry, skin, frame.fileMarks ?? {})),
    },
    {
      id: 'notes',
      label: 'NOTES',
      count: notes.length,
      actions: [{ label: ' + ', target: { kind: 'action', name: 'add-note' } }],
      banded: true,
      rows: (row) =>
        notes.length === 0
          ? [
              blank(width),
              row().space(3).text('tell Tade "remember …"', skin.hint).build(),
              blank(width),
            ]
          : tabList(
              notes.map((note) => noteRow(width, skin, pointer, note, state.project)),
              width,
            ),
    },
    {
      id: 'where',
      label: 'GIT',
      count: null,
      rows: (row) =>
        where
          ? whereRows(row, where, skin, state.focused !== null)
          : [row().space(3).text('—', skin.hint).build()],
    },
  ]

  const out: { text: string; hits: Hit[] }[] = []
  const make = () => new Row(width, skin, pointer)
  let previousOpen = false
  let previousBanded = false
  sections.forEach((section, i) => {
    // A section of tabs already ends on the room below its last one.
    if (i > 0 && previousOpen && !previousBanded) out.push(blank(width))
    const open = sectionOpen(state, section.id, section.quiet === true)
    previousOpen = open
    previousBanded = section.banded === true
    const head = make()
      .space()
      .text(`${open ? '▾' : '▸'} ${section.label}`, skin.label, {
        kind: 'section',
        section: section.id,
        ...(section.quiet ? { quiet: true } : {}),
      })
    const shown = headingFit(head.used, width, section, skin)
    const badge = shown.count === false ? null : badgeText(section, shown.count)
    if (badge !== null) head.space().badge(badge)
    if (shown.actions.length > 0) {
      head.right((r) => {
        headingControls(r, shown.actions, pointer)
        r.space()
      })
    } else {
      const note = noteFitting(section, width - head.used - 2)
      if (note !== null) head.right((r) => r.text(note, skin.hint).space())
    }
    out.push(head.build())
    if (open) out.push(...section.rows(make))
  })
  // A row of room under the last one, where there is scrolling to do: read to
  // the end, the bottom section otherwise sits hard against the strip below
  // it, which looks like a list cut off rather than a list that has ended.
  // Only where it scrolls, because a bar that appears to say "there is more"
  // when the more is a blank row is worse than no margin at all.
  if (out.length > body) out.push(blank(width))
  // Tailing is for screens that grow at the bottom; a sidebar is read from the
  // top, so it scrolls, and never past its last row.
  const scroll = Math.max(0, Math.min(state.scroll, out.length - body))
  const shown = out.slice(scroll, scroll + body)
  while (shown.length < body) shown.push(blank(width))
  const rows = barBeside(
    shown,
    { total: out.length, shown: body, offset: scroll, rows: body },
    'sidebar',
    width,
    state,
    skin,
  )
  // The tree reaches further right than the side is wide: a bar along the
  // bottom says how much of it you are looking at, and takes you to the rest.
  if (sideways > 0) {
    const view = { total: spread.wide, shown: spread.shown, offset: across, rows: width }
    const bar: Target = {
      kind: 'scrollbar',
      area: 'sidebar',
      total: spread.wide,
      shown: spread.shown,
      across: true,
    }
    rows.push({
      text: `${barAcross(view, skin, isScrolling(state, 'sidebar', true))} `,
      hits: [{ row: 0, from: 0, to: Math.max(0, width - 1), target: bar }],
    })
  }
  const stacked = stack(rows)
  const under = Array.from({ length: height }, (_, i) =>
    rowHit(i, full, { kind: 'scroll', area: 'sidebar' }),
  )
  return { rows: stacked.rows, hits: [...under, ...stacked.hits] }
}

/**
 * What a section says beside its label, in the room its label leaves: its
 * note, or the shorter way it has of saying the same thing, or nothing at all
 * where neither fits. The steps are the ladder `headingFit` climbs for the
 * badge, for the same reason — a heading that keeps what it has room for
 * reads better than one that keeps everything and draws none of it.
 */
function noteFitting(section: Section, room: number): string | null {
  for (const said of [section.note, section.brief]) {
    if (said !== undefined && visibleWidth(said) <= room) return said
  }
  return null
}

/** How much of a section's badge is drawn: the fraction, the count alone, or none. */
type Badge = 'full' | 'short' | false

/**
 * What a section's badge says, or nothing where there is nothing to say: how
 * many rows it lists, and — `full`, where it is listing fewer than it holds —
 * what that is out of. `0/14` is worth drawing where a plain `0` is not: it is
 * the difference between no agents and fourteen agents out of sight.
 */
function badgeText(section: Section, how: Exclude<Badge, false>): string | null {
  if (section.count === null) return null
  if (how === 'full' && section.of !== undefined && section.of !== section.count)
    return `${section.count}/${section.of}`
  return section.count > 0 ? String(section.count) : null
}

/** The columns a badge would take, or none where there is no badge to draw. */
function badgeWidth(section: Section, how: Exclude<Badge, false>): number {
  const text = badgeText(section, how)
  return text === null ? 0 : 1 + text.length + 2
}

/**
 * What a heading has room for, beside its own label.
 *
 * Short of columns it gives up what its count is out of first, then the count
 * itself — the list under it is the count — then its small controls, the one
 * nearest the button first, because a heading that keeps the button it is
 * there for is worth more than one that keeps everything and draws none of it.
 * The two steps of badge matter: hiding the finished agents must never be what
 * takes the count off the heading, or pressing `H` would read as the agents
 * having gone rather than as the list being narrowed.
 *
 * Where there is no button that reason is not there either, and the order is
 * the other way round: the count goes last, after the small controls. A folded
 * section is its heading and nothing else, so its badge is the only thing left
 * to say five things are waiting — and `plan` on the SMART QUEUE, drawn where
 * that count would be, would have a narrow side saying the queue is empty.
 */
function headingFit(
  label: number,
  width: number,
  section: Section,
  skin: Skin,
): { count: Badge; actions: SectionAction[] } {
  const all = section.actions ?? []
  const small = all.filter((action) => action.small)
  const main = all.filter((action) => !action.small)
  const sizes: Array<Exclude<Badge, false>> = ['full', 'short']
  /** The columns `kept` of the small controls take, beside the button. */
  const withKept = (kept: number) => {
    const actions = [...small.slice(0, kept), ...main]
    const room = label + (actions.length > 0 ? 1 + headingWidth(actions, width, skin) : 0)
    return { actions, room }
  }
  for (let kept = small.length; kept >= 0; kept--) {
    const { actions, room } = withKept(kept)
    for (const how of sizes) {
      const badge = badgeWidth(section, how)
      if (badge > 0 && room + badge <= width) return { count: how, actions }
    }
    // With a button on it the count goes here, before the controls beside it;
    // with none, every control is given up first and the count outlasts them.
    if (room <= width && (main.length > 0 || kept === 0)) return { count: false, actions }
  }
  for (const how of sizes) {
    const badge = badgeWidth(section, how)
    if (badge > 0 && label + badge <= width) return { count: how, actions: [] }
  }
  return { count: false, actions: [] }
}

/**
 * A heading's controls, drawn side by side: the small ones as one set of
 * chips, then a column, then the button they sit beside — which is how you
 * see at a glance which of them makes another of something.
 */
function headingControls(r: Row, actions: readonly SectionAction[], pointer: Pointer): void {
  actions.forEach((action, i) => {
    if (i > 0 && !action.small) r.space()
    // Destructive, and so red only under the pointer: at rest it is as quiet
    // as everything else in the heading.
    const look: Look = action.danger
      ? sameTarget(pointer.hover, action.target)
        ? 'danger'
        : 'rest'
      : (action.look ?? (action.small ? 'rest' : 'add'))
    if (action.small) r.chip(action.label, action.target, look)
    else r.button(action.label, action.target, look)
  })
}

/** The columns a heading's controls take, the space after them included. */
function headingWidth(actions: readonly SectionAction[], width: number, skin: Skin): number {
  const probe = new Row(width, skin)
  headingControls(probe, actions, NO_POINTER)
  return probe.used + 1
}

/** The repository, the branch in front of you, and the worktree an agent works in. */
function whereRows(
  row: () => Row,
  where: NonNullable<Frame['where']>,
  skin: Skin,
  agent: boolean,
): { text: string; hits: Hit[] }[] {
  const line = (
    label: string,
    value: string,
    paint: (text: string) => string = (t) => t,
    path = true,
  ) => {
    const r = row().space(3).text(label.padEnd(9), skin.hint)
    const room = Math.max(1, r.width - r.used - 1)
    return r.text(path ? shortPath(value, room) : tailOf(value, room), paint).build()
  }
  const rows = [line('repo', where.repo)]
  // The branch is its menu: switch the project's, or rename an agent's.
  const branch: Target = { kind: 'branch' }
  const pointed = sameTarget(row().pointer.hover, branch)
  const said = where.branch || (agent ? 'named at first change' : 'unknown')
  const branchLine = row().space(3).text('branch'.padEnd(9), skin.hint)
  const branchRoom = Math.max(1, branchLine.width - branchLine.used - 3)
  branchLine.text(
    tailOf(said, branchRoom),
    where.branch ? (pointed ? skin.link : skin.busy) : skin.hint,
  )
  branchLine.right((r) => r.text(pointed ? '≡' : ' ', skin.signal).space())
  const builtBranch = branchLine.build()
  rows.push({
    text: pointed ? skin.hovered(builtBranch.text) : builtBranch.text,
    hits: [rowHit(0, branchLine.width, branch)],
  })
  if (where.base) rows.push(line('from', where.base.replace(/^origin\//, ''), skin.hint, false))
  for (const link of where.links ?? []) {
    const target: Target = { kind: 'link', url: link.url }
    const lit = sameTarget(row().pointer.hover, target)
    const r = row().space(3).text('about'.padEnd(9), skin.hint)
    r.text(
      tailOf(`${link.title} ↗`, Math.max(1, r.width - r.used - 1)),
      lit ? skin.link : skin.signal,
    )
    rows.push({ text: r.build().text, hits: [rowHit(0, r.width, target)] })
  }
  if (where.worktree) rows.push(line('worktree', where.worktree))
  // The whole path, never cut, from your home as you would type it; it wraps
  // under its label. A click opens the folder, a right-click copies it.
  const open: Target = { kind: 'action', name: 'open-path' }
  const hovered = sameTarget(row().pointer.hover, open)
  const first = row().space(3).text('path'.padEnd(9), skin.hint)
  const room = Math.max(8, first.width - first.used - 1)
  wrapPath(where.shownPath ?? where.path, room).forEach((piece, i) => {
    const r = i === 0 ? first : row().space(12)
    r.text(piece, hovered ? skin.link : skin.signal)
    rows.push({ text: r.build().text, hits: [rowHit(0, r.width, open)] })
  })
  return rows
}

/** A file or folder in the tree, indented by how deep it is. */
function fileRow(
  row: Row,
  entry: FileEntry,
  skin: Skin,
  marks: Readonly<Record<string, string>>,
): { text: string; hits: Hit[] } {
  const target: Target = entry.folder
    ? { kind: 'folder', path: entry.path }
    : { kind: 'file', path: entry.path }
  const menu: Target = {
    kind: 'menu',
    subject: { kind: 'file', path: entry.path, folder: entry.folder },
  }
  // Lit under the pointer, so it is plain which one a click would open.
  const hovered = pointingIn(row.pointer.hover, [target, menu])
  // Coloured the way git sees it, as an editor would: changed amber, new
  // green, conflicted red, and a folder by the most pressing thing inside.
  const mark = entry.folder ? folderMark(entry.path, marks) : (marks[entry.path] ?? null)
  const tone = markTone(mark, skin)
  row.space(3 + entry.depth * 2)
  if (entry.folder) row.text(`${entry.open ? '▾' : '▸'} ${entry.name}/`, tone ?? skin.busy)
  else row.text(`  ${entry.name}`, tone ?? (hovered ? skin.you : (t) => t))
  row.right((r) => {
    if (hovered) r.icon('≡', menu).space()
    if (mark) r.text(entry.folder ? '•' : mark, tone ?? skin.hint).space()
    else if (!hovered) r.space(2)
  })
  const built = row.build()
  return {
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, row.width, target), ...built.hits.filter((hit) => hit.target.kind === 'menu')],
  }
}

/**
 * The sections extensions keep in the sidebar, drawn from their own caches.
 * The window knows nothing about what is in them: a row is a title, a few
 * words, some marks and what clicking it runs.
 */
function listSections(frame: Frame, width: number, skin: Skin, _pointer: Pointer): Section[] {
  const shown = (frame.lists ?? []).filter(
    (section: ListSectionView) => section.rows.length > 0 || section.problem !== null,
  )
  return shown.map((section: ListSectionView) => ({
    id: `list:${section.id}`,
    label: section.title,
    count: section.rows.length,
    rows: (row: () => Row) =>
      section.problem !== null && section.rows.length === 0
        ? [
            row()
              .space(3)
              .text(shortened(section.problem, Math.max(1, width - 5)), skin.hint)
              .build(),
          ]
        : section.rows.map((one) => listRow(row(), one, skin, width)),
  }))
}

/** One row an extension keeps: what it is, how it is going, and where it opens. */
function listRow(
  row: Row,
  one: ListRowView,
  skin: Skin,
  width: number,
): { text: string; hits: Hit[] } {
  const target: Target = { kind: 'action', name: `list-row:${one.section}\u0000${one.id}` }
  const marks = (one.marks ?? []).map((mark) => mark.text).join(' · ')
  const room = Math.max(4, width - 6 - visibleWidth(marks))
  row.space(2).text(shortened(one.title, room), (text) => text, target)
  if (marks) {
    row.right((r) => {
      for (const mark of one.marks ?? []) r.text(mark.text, toneFor(mark.tone, skin)).space()
    })
  }
  const built = row.build()
  return { text: built.text, hits: [rowHit(0, width, target), ...built.hits] }
}

/** The least a note's own words are worth a row: less than this, and what it is about goes. */
const NOTE_WORDS = 16

/**
 * A note down the side, as a tab of two lines: the headline it was given —
 * what it is about and what it does — over the note as it was said, cut short
 * with `…`, which its own page reads whole.
 *
 * A note nobody wrote a headline for is drawn in its own words, as it always
 * was: as much as fits on top, the rest carrying on underneath. Nothing here
 * ever makes a headline out of the words themselves — a note is kept verbatim
 * because nothing can recover what was meant by it, and a summary invented
 * four times a second would be exactly that guess. Under the pointer, a forget
 * and a menu, the way an agent has a close.
 */
function noteRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  note: NoteShown,
  project: string | null,
): ListItem {
  const target: Target = { kind: 'note', at: note.at, text: note.text }
  const forget: Target = { kind: 'action', name: `forget-note:${note.at}\u0000${note.text}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'note', at: note.at, text: note.text } }
  const pointed = pointingIn(pointer.hover, [target, forget, menu])
  const band: Band | null = pointed ? 'hovered' : null
  const said = note.text.replace(/\s+/g, ' ').trim()
  const headline = (note.summary ?? '').replace(/\s+/g, ' ').trim()
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  // With no headline, where the first line breaks decides what the second one
  // says — so its buttons' room is kept whether they are drawn or not, or
  // pointing at a note would rewrite the line under it. A headline has the
  // whole note under it either way, so its room is its own.
  const kept = headline && !pointed ? 0 : TAB_ICONS
  const room = Math.max(1, inner.width - inner.used - kept - 1)
  const first = headline || (visibleWidth(said) > room ? cutAtWord(said, room) : said)
  // The headline carries the weight; the words themselves are said quietly
  // under it, which is the whole of what the two lines are for.
  inner.text(saidShort(first, room), headline || pointed ? (t) => t : skin.hint, target)
  if (pointed) inner.right((r) => r.icon('×', forget, 'danger').icon('≡', menu).space())
  const rest = headline ? said : said.slice(first.length).trim()
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      ...(rest ? [noteWordsRow(width, skin, pointer, band, rest, target, note, project)] : []),
    ],
    band,
  }
}

/**
 * The note itself, under its headline: quiet, cut at a word with `…`, and at
 * the end of it the task it is about — where it is about one, since the list
 * is already only this project's. What it is about is dropped rather than
 * leaving its own words a corner of the row.
 */
function noteWordsRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  band: Band | null,
  said: string,
  target: Target,
  note: NoteShown,
  project: string | null,
): { text: string; hits: Hit[] } {
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  // Set off by a dot, or the task's name reads as the end of the sentence
  // above it rather than as what that sentence is about.
  const about = taskTag(note.scope ?? null, project)
  const tag = about ? `· ${about}` : ''
  const corner = tag ? visibleWidth(tag) + 2 : 0
  const room = Math.max(1, inner.width - inner.used - 1)
  const shown = tag && room - corner >= NOTE_WORDS ? tag : ''
  inner.text(saidShort(said, room - (shown ? corner : 0)), skin.hint, target)
  if (shown) inner.right((r) => r.text(shown, skin.hint, target).space())
  return tabbed(width, skin, band, inner.build(), target)
}

/** Which task a note is about, where it is about one rather than the whole project. */
function taskTag(scope: string | null, project: string | null): string {
  if (!scope || !project || !scope.startsWith(`${project}/`)) return ''
  return inProject(project, scope)
}

function changeRow(
  row: Row,
  change: Change,
  skin: Skin,
  task: string | null,
): { text: string; hits: Hit[] } {
  const mark =
    change.mark === 'A' || change.mark === '?'
      ? skin.done
      : change.mark === 'D' || change.mark === 'U'
        ? skin.bad
        : skin.waiting
  // A changed file shows its change; with no task to diff against, it opens.
  const target: Target = task
    ? { kind: 'change', task, path: change.path }
    : { kind: 'file', path: change.path }
  const counts = [
    change.added ? `+${change.added}` : '',
    change.removed ? `−${change.removed}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const menu: Target = { kind: 'menu', subject: { kind: 'change', task, path: change.path } }
  const hovered = pointingIn(row.pointer.hover, [target, menu])
  const room = row.width - 5 - (counts ? counts.length + 2 : 0) - (hovered ? MENU_ICON : 0)
  row
    .space(2)
    .text(change.mark, mark)
    .space()
    .text(shortPath(change.path, room), hovered ? skin.you : (t) => t)
  row.right((r) => {
    if (hovered) r.icon('≡', menu).space()
    if (change.added) r.text(`+${change.added}`, skin.done)
    if (change.added && change.removed) r.space()
    if (change.removed) r.text(`−${change.removed}`, skin.bad)
    r.space()
  })
  const built = row.build()
  return {
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, row.width, target), ...built.hits.filter((hit) => hit.target.kind === 'menu')],
  }
}
