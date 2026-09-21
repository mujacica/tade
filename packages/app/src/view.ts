import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { type FileEntry, folderMark } from './files.ts'
import type { Change, Frame, LaneView, ListRowView, ListSectionView, NoteShown } from './frame.ts'
import {
  type Hit,
  pointingIn,
  rowHit,
  type ScrollArea,
  sameTarget,
  shift,
  type Target,
} from './hits.ts'
import { resolveLayout } from './layout.ts'
import { linkedRow } from './links.ts'
import {
  type AgentPane,
  type AppState,
  agentsHere,
  conversing,
  doneTasks,
  laneShown,
  offsetOf,
  queuedCount,
  queueRows,
  sectionOpen,
  showingActions,
  shownName,
  splitShown,
  tasksOf,
} from './model.ts'
import { drawPanel } from './panel-view.ts'
import { BAR, barAcross } from './scrollbar.ts'
import { type Band, type Look, PLAIN, type Skin } from './skin.ts'
import { blank, box, type Drawn, fit, NO_POINTER, overlay, type Pointer, Row, stack } from './ui.ts'
import { actionRows, toneFor } from './view/actions.ts'
import { renderFoot } from './view/foot.ts'
import { blockAt, scrolledBar, typingIn } from './view/lane.ts'
import {
  type QueueTree,
  queueSection,
  queueSpread,
  queueStems,
  renderPlan,
  renderQueued,
  taskRow,
} from './view/queue.ts'
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
} from './view/rows.ts'
import { renderSchedule, schedulesHere } from './view/schedule.ts'
import { belowFirst, besideFirst, splitView } from './view/split.ts'
import { renderStrip } from './view/strip.ts'
import {
  clockOf,
  cutAtWord,
  inProject,
  saidShort,
  shortened,
  shortModel,
  shortPath,
  tailOf,
  wrapPath,
} from './view/text.ts'
import { renderTop, toastFor } from './view/top.ts'

// Drawing, as one pure function of state.
//
// The window is shaped like the thing it is showing. Projects are tabs along
// the top, because you are in one at a time. The agents in that project are
// down the side, with where they work and what they have changed, the middle is the agent you
// are watching, and the orchestrator runs along the bottom, always there and
// not closeable — it is how you know what Tade heard. Money is bottom right,
// what needs you and the key to talk with are top right, and a panel, when one
// is open, floats over all of it.
//
// Composition is done here rather than with a layout engine because the panes
// have to tail: an agent's newest output is the point, and a stack that clips
// from the bottom would show you the top of the screen instead.

export type { Drawn } from './ui.ts'
export { BUTTONS } from './view/foot.ts'

/** The whole window, one string per row, each exactly as wide as the window. */
export function renderApp(state: AppState, frame: Frame): string[] {
  return draw(state, frame).rows
}

export function draw(state: AppState, frame: Frame): Drawn {
  const skin = frame.skin ?? PLAIN
  const pointer: Pointer = { hover: state.hover, pressed: state.pressed }
  // The config's sizes, then the ones dragged to, then the bottom folded or filling.
  const { sidebarWidth, stripHeight, mainWidth, bodyHeight } = resolveLayout(
    { ...frame.layout, ...state.sizes, bottom: state.bottomMode, grow: conversing(state) },
    frame,
  )
  // The clamped width, not the asked-for one: a terminal too narrow to hold a
  // readable sidebar and a pane still gets whole rows, just wider than itself.
  const width = sidebarWidth + mainWidth + 1

  const rows: string[] = []
  const hits: Hit[] = []
  const add = (drawn: Drawn) => {
    hits.push(...shift(drawn.hits, rows.length))
    rows.push(...drawn.rows)
  }

  add(renderTop(state, frame, width, skin, pointer))

  const left = renderSidebar(state, frame, sidebarWidth, bodyHeight, skin, pointer)
  const right = renderMain(state, frame, mainWidth, bodyHeight, skin, pointer)
  // The line between them is a handle: it lights up under the pointer, and
  // dragging it moves it.
  const sidebarEdge: Target = { kind: 'divider', edge: 'sidebar' }
  const edgeLit = state.resizing === 'sidebar' || sameTarget(state.hover, sidebarEdge)
  const body: Drawn = {
    rows: [],
    hits: [
      ...left.hits,
      ...shift(right.hits, 0, sidebarWidth + 1),
      ...Array.from({ length: bodyHeight }, (_, i) => ({
        row: i,
        from: sidebarWidth,
        to: sidebarWidth,
        target: sidebarEdge,
      })),
    ],
  }
  for (let i = 0; i < bodyHeight; i++) {
    body.rows.push(
      `${fit(left.rows[i] ?? '', sidebarWidth)}${edgeLit ? skin.signal('┃') : skin.chrome('│')}${fit(right.rows[i] ?? '', mainWidth)}`,
    )
  }
  add(body)

  add(renderStrip(state, frame, width, stripHeight, skin, pointer))
  add(renderFoot(state, frame, width, skin, pointer))

  let window: Drawn = { rows, hits }
  const toast = toastFor(state, frame, width, skin, pointer)
  if (toast) {
    const toastWidth = Math.max(0, ...toast.rows.map((row) => visibleWidth(row)))
    window = overlay(
      window,
      toast,
      { row: 2, col: Math.max(0, width - toastWidth - 1) },
      width,
      skin,
      false,
    )
  }
  if (!state.panel) return window
  const extra = frame.panel ?? {}
  const drawing = drawPanel(state.panel, {
    width,
    height: rows.length,
    skin,
    pointer,
    scrolling: state.scrolling?.area ?? null,
    home: frame.home ?? '~/.tade',
    date: frame.date ?? clockOf(frame),
    route: frame.route ?? null,
    spend: frame.spendView ?? null,
    panes: state.panes,
    project: state.project,
    items: extra.items ?? [],
    changes: extra.changes ?? frame.changes ?? [],
    ahead: extra.ahead ?? null,
    branch: extra.branch ?? null,
    base: extra.base ?? frame.base ?? null,
    diff: extra.diff ?? null,
    choices: extra.choices ?? [],
    settings: extra.settings ?? [],
    accounts: extra.accounts ?? [],
    updates: extra.updates ?? null,
    updatesBusy: extra.updatesBusy ?? false,
    lanesSurvive: extra.lanesSurvive ?? false,
    configPath: extra.configPath ?? '~/.tade/config.yaml',
    releases: extra.releases ?? false,
    budgetWarnings: extra.budgetWarnings ?? 0,
    levels: extra.levels ?? state.levels,
    openRows: extra.openRows ?? [],
    browsing: extra.browsing ?? null,
    homeDir: extra.homeDir ?? process.env.HOME ?? '',
    entries: extra.entries ?? [],
    talkKey: extra.talkKey ?? (frame.voice?.keys ?? ['ctrl', 'space']).join('+'),
    talkMode: extra.talkMode ?? 'hold',
    bindings: frame.bindings ?? {},
    running: extra.running ?? state.panes.reduce((n, pane) => n + pane.lanes.length, 0),
    searching: extra.searching ?? false,
    viewing: extra.viewing ?? null,
    branches: extra.branches ?? [],
    checkout: extra.checkout ?? frame.where?.branch ?? null,
    found: extra.found ?? 0,
    terminalName: extra.terminalName ?? 'terminal',
    extensions: extra.extensions ?? [],
    harnessExtensions: extra.harnessExtensions ?? [],
    servers: extra.servers ?? [],
    extensionsRoot: extra.extensionsRoot ?? '~/.tade/extensions',
    models: extra.models ?? [],
    modelTarget: extra.modelTarget ?? 'the orchestrator',
    currentModel: extra.currentModel ?? null,
    written: extra.written ?? [],
    setup: extra.setup ?? null,
    extensionView: extra.extensionView ?? null,
  })
  const panelWidth = Math.max(0, ...drawing.panel.rows.map((row) => visibleWidth(row)))
  // The wheel scrolls whatever panel it is over, anywhere on it: under every
  // control, so a click still presses what it is on.
  const panel: Drawn = {
    rows: drawing.panel.rows,
    hits: [
      ...drawing.panel.rows.map((_, i) => ({
        row: i,
        from: 0,
        to: Math.max(0, panelWidth - 1),
        target: { kind: 'scroll', area: 'panel' } as Target,
      })),
      ...drawing.panel.hits,
    ],
  }
  // Find sits on the bottom panel's top edge, over the terminal it searches.
  const anchor =
    state.panel.kind === 'menu'
      ? state.panel.anchor
      : state.panel.kind === 'find'
        ? { row: 2 + bodyHeight - panel.rows.length + 1, col: width - panelWidth - 1 }
        : null
  // A menu opens where it was asked for, over a window that stays bright; a
  // panel that asks something takes the middle and fades the rest.
  const at = anchor
    ? {
        row: Math.max(0, Math.min(anchor.row, rows.length - panel.rows.length)),
        col: Math.max(0, Math.min(anchor.col, width - panelWidth)),
      }
    : {
        row: Math.max(1, Math.floor((rows.length - panel.rows.length) / 3)),
        col: Math.max(0, Math.floor((width - panelWidth) / 2)),
      }
  let drawn = overlay(window, panel, at, width, skin, !anchor)
  if (anchor) {
    // Not faded, but still a menu: a click anywhere else closes it. The menu's
    // own hits are put back where it was put, rather than counted off the
    // front of the window's — a window whose parts a menu happens to cover
    // whole would take that many of the menu's rows away with them.
    drawn = {
      rows: drawn.rows,
      hits: [
        ...drawn.rows.map((_, i) => rowHit(i, width, { kind: 'dismiss' })),
        ...shift(panel.hits, at.row, at.col),
      ],
    }
  }
  for (const popup of drawing.popups) {
    const row = at.row + popup.row
    const col = Math.min(
      at.col + popup.col,
      Math.max(0, width - Math.max(0, ...popup.drawn.rows.map((r) => visibleWidth(r)))),
    )
    const room = Math.max(0, drawn.rows.length - row)
    const clipped = {
      rows: popup.drawn.rows.slice(0, room),
      hits: popup.drawn.hits.filter((hit) => hit.row < room),
    }
    drawn = overlay(drawn, clipped, { row, col }, width, skin, false)
  }
  return drawn
}

// ── Top: projects, what needs you, and the key to talk ───────────────────────

// ── Side: where, agents, changes, files, notes ───────────────────────────────

function renderSidebar(
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
  // With nothing waiting and nothing scheduled the queue is quiet: still
  // there, still a heading you can open, and folded until you do.
  const waiting = queuedCount(state) + schedulesHere(state, frame)
  const queueOpen = sectionOpen(state, 'queue', waiting === 0)
  const spread = queueOpen ? queueSpread(queueStems(entries), width) : { wide: 0, shown: 0 }
  const sideways = Math.max(0, spread.wide - spread.shown)
  const across = Math.min(Math.max(0, state.across), sideways)
  const tree: QueueTree = { ...spread, across }
  // The bar lies along the bottom row, and the list gets what is left.
  const body = sideways > 0 ? Math.max(1, height - 1) : height
  const tasks = tasksOf(state)
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
          : tabList(
              tasks.map((task) =>
                taskRow(width, skin, pointer, task, spend[task.task], frame.now ?? 0),
              ),
              width,
            ),
    },
    // Always, so the queue is somewhere you can look rather than something
    // that appears: with nothing in it, its heading is all it costs the side.
    queueSection(state, frame, width, skin, pointer, tree, waiting, queueOpen),
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
              row()
                .space(3)
                .text(state.focused ? 'nothing changed' : 'open an agent to see', skin.hint)
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

// ── Middle: the agent you are watching ───────────────────────────────────────

function renderMain(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const pane = state.panes.find((p) => p.task === state.focused)
  if (!pane && state.showingPlan) return renderPlan(state, frame, width, height, skin, pointer)
  const schedule = frame.schedules?.find((one) => one.id === state.schedule)
  if (!pane && schedule) {
    return renderSchedule(state, frame, schedule, width, height, skin, pointer)
  }
  if (!pane) return renderWelcome(state, frame, width, height, skin, pointer)
  if (pane.queued) {
    return renderQueued(
      state,
      frame,
      { ...pane, queued: pane.queued },
      width,
      height,
      skin,
      pointer,
    )
  }

  const work = showingActions(state, pane.task)
  const shown = work ? null : laneShown(state, pane)
  // A tab per lane — the agent, and any shell beside it — then what it has
  // done, and + for another shell.
  const tabs = (r: Row) => {
    if (pane.lanes.length === 0) r.tab('agent', { kind: 'task', task: pane.task }, !work)
    for (const { id, label } of laneLabels(pane.lanes)) {
      const target: Target = { kind: 'lane', task: pane.task, lane: id }
      const kind = pane.lanes.find((lane) => lane.id === id)?.kind
      // The agent's own tab has no buttons: it is not a lane you close.
      if (kind === 'agent') {
        r.tab(label, target, id === shown)
        continue
      }
      // A shell's close and menu, as a terminal tab has them: drawn while the
      // pointer is anywhere in the tab, and the tab lit while it is on them.
      //
      // Their room is *not* kept here, where the bottom panel's tabs keep
      // theirs. This row is already full — what is to the right of the tabs is
      // the harness, the model, how hard it thinks and how much context is
      // left, and six columns held for buttons nobody is pointing at took the
      // thinking control and the context meter off it. A strip that grows by
      // six while you point at it costs less than a control you can no longer
      // read, and it is less than the ten these tabs moved by before, which
      // they moved by whenever the shell was simply the one in front.
      const menu: Target = {
        kind: 'menu',
        subject: { kind: 'lane', task: pane.task, lane: id, name: label },
      }
      const close: Target = { kind: 'action', name: `close-lane:${id}` }
      const pointed = pointingIn(state.hover, [target, menu, close])
      r.tab(label, target, id === shown, pointed)
      if (pointed) r.icon('×', close, 'danger').icon('≡', menu)
    }
    r.tab('actions', { kind: 'pane-tab', task: pane.task, tab: 'actions' }, work)
    r.space().button('+', { kind: 'action', name: 'new-shell' }, 'add')
  }

  const route = frame.route
  const vitals = frame.vitals
  // What the agent says it runs on beats what the config hoped for.
  const model = vitals?.model ?? route?.model
  // Its harness, its model and how hard it thinks are controls: click one to change it for this agent.
  const harness: Target = { kind: 'action', name: `harness:${pane.task}` }
  const switcher: Target = { kind: 'action', name: `model:${pane.task}` }
  const thinker: Target = { kind: 'action', name: `thinking:${pane.task}` }
  // How hard it thinks, as it said; before it has, what new agents are given.
  const thinking = vitals?.thinking ?? route?.thinking ?? null
  const percent = vitals?.contextPercent ?? null
  type Shown = { context: boolean; thinking: 'long' | 'short' | 'none'; harness: boolean }
  // A harness that cannot change them has no button for them: the model is
  // still said, as what it runs on.
  const offers = frame.offers
  const controls = (show: Shown) => (r: Row) => {
    if (show.harness) r.button(`${route?.harness ?? 'pi'} ▾`, harness).space()
    const named = `${model ? shortModel(model) : 'its default model'}`
    if (offers?.model.shown === false) r.text(named, skin.hint)
    else r.button(`${named} ▾`, switcher)
    if (show.thinking !== 'none' && offers?.thinking.shown !== false) {
      const label =
        show.thinking === 'long' ? `${thinking ?? 'thinking'} ▾` : `${thinking ?? 'think'} ▾`
      r.space().button(label, thinker)
    }
    if (show.context && percent !== null) {
      const tone = percent >= 85 ? skin.bad : percent >= 60 ? skin.waiting : skin.busy
      r.text(' ctx ', skin.hint)
        .meter(percent / 100, 6, tone)
        .text(` ${Math.round(percent)}%`, skin.hint)
    }
    r.space()
    // Close this agent, running or not: it stops, and goes from the list.
    r.button('×', { kind: 'action', name: `close-task:${pane.task}` }, 'danger').space()
  }
  const measure = (build: (r: Row) => void) => {
    const probe = new Row(width, skin)
    build(probe)
    return probe.used
  }
  const hasControls = Boolean(route || vitals)
  // The name gives way before the controls do: cut short, it still says whose
  // agent this is, and a model you cannot change is a control you lost.
  const least = hasControls
    ? measure(controls({ context: false, thinking: 'short', harness: false })) + 1
    : 0
  const header = new Row(width, skin, pointer).space()
  const forTitle = Math.max(8, width - 3 - measure(tabs) - least)
  // Short of room the project gives way before the agent's own name does:
  // which agent you are looking at is the one thing this line has to say.
  const full = `${pane.project} › ${shownName(pane)}`
  const title = visibleWidth(full) <= forTitle ? full : shownName(pane)
  header.text(shortened(title, forTitle), skin.you).space(2)
  tabs(header)
  if (hasControls) {
    // Where the header is short of room, shed in this order: the context
    // meter, the word "thinking", the harness — one agent in a hundred changes
    // it — and then the thinking level. The model and the close always stay.
    const tries: Shown[] = [
      { context: true, thinking: 'long', harness: true },
      { context: false, thinking: 'long', harness: true },
      { context: false, thinking: 'short', harness: true },
      { context: false, thinking: 'short', harness: false },
      { context: false, thinking: 'none', harness: false },
    ]
    const fits = tries.find((show) => header.used + measure(controls(show)) + 1 <= width)
    header.right(controls(fits ?? { context: false, thinking: 'none', harness: false }))
  }

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
  ]
  const room = height - rows.length
  if (room <= 0) return stack(rows.slice(0, height))

  const split = shown ? splitShown(state, pane) : null
  // The bar down the right of the agent's screen, and the column it takes from
  // it. Only where there is one screen: a split is two, and its halves are
  // measured against the lane sizes the window asked the driver for.
  const lane = shown && !split ? (frame.paneScreen ?? null) : null
  const body = lane ? width - BAR : width
  if (work) {
    // Laid out in the room there is, then windowed: a page longer than its
    // pane scrolls, with a bar beside it, rather than losing its end.
    const full = actionRows(frame.actions ?? null, pane, state, frame, width, skin, pointer)
    if (full.length <= room) {
      rows.push(...full)
    } else {
      const body = width - BAR
      const page = actionRows(frame.actions ?? null, pane, state, frame, body, skin, pointer)
      const offset = offsetOf(state, 'actions', page.length, room)
      const seen = page.slice(offset, offset + room)
      while (seen.length < room) seen.push(blank(body))
      rows.push(
        ...barBeside(
          seen,
          { total: page.length, shown: room, offset, rows: room },
          'actions',
          body,
          state,
          skin,
        ),
      )
    }
    // The wheel over the page scrolls it, wherever on it the pointer is.
    rows.forEach((row, i) => {
      if (i >= 2) row.hits.unshift(rowHit(0, width, { kind: 'scroll', area: 'actions' }))
    })
  } else if (!shown) {
    rows.push(blank(width))
    rows.push(
      new Row(width, skin)
        .space(2)
        .text(`${describeState(pane)}.`, skin.hint)
        .build(),
    )
    rows.push(blank(width))
    rows.push(
      new Row(width, skin, pointer)
        .space(2)
        .button('Open its agent', { kind: 'action', name: 'open-agent' }, 'primary')
        .space()
        .text('picks the conversation up where it stopped', skin.hint)
        .build(),
    )
  } else if (split) {
    // Two lanes at once: the one in front, and a shell beside or below it.
    const kindOf = (lane: string) => pane.lanes.find((one) => one.id === lane)?.kind ?? 'shell'
    const label = laneLabels(pane.lanes).find((one) => one.id === split.lane)?.label ?? 'shell'
    const drawn = splitView({
      width,
      height: room,
      split,
      edge: 'split',
      lit:
        state.resizing === 'split' || sameTarget(state.hover, { kind: 'divider', edge: 'split' }),
      focus: state.splitFocus,
      label,
      actions: `split:${pane.task}`,
      skin,
      pointer,
      first: (w, h) =>
        underTargets(
          laneLines(
            frame.screen,
            kindOf(shown),
            w,
            // The agent's half ends above its approval card, exactly as the
            // whole pane does when there is no split: a screen drawn under
            // one is a sentence the card is sitting on.
            pane.approval && kindOf(shown) === 'agent' ? Math.max(1, h - APPROVAL_ROWS - 1) : h,
            skin,
            pointer,
            frame.linkers,
          ),
          w,
          { kind: 'pane' },
          'pane',
        ),
      second: (w, h) =>
        underTargets(
          laneLines(
            frame.splitScreen ?? '',
            kindOf(split.lane),
            w,
            h,
            skin,
            pointer,
            frame.linkers,
          ),
          w,
          { kind: 'pane', side: 'split' },
          null,
        ),
    })
    rows.push(
      ...drawn.rows.map((text, i) => ({
        text,
        hits: drawn.hits.filter((hit) => hit.row === i).map((hit) => ({ ...hit, row: 0 })),
      })),
    )
  } else if (state.paneScroll > 0) {
    // Scrolled back: exactly the lines asked for, and a way back to the newest.
    const lines = frame.screen.split('\n').slice(-(room - 1))
    for (let gap = room - 1 - lines.length; gap > 0; gap--) rows.push(blank(body))
    for (const line of lines) rows.push(linkedRow(line, body, skin, pointer, frame.linkers))
    rows.push(scrolledBar(state.paneScroll, 'pane-end', body, skin, pointer))
  } else {
    const kind = pane.lanes.find((one) => one.id === shown)?.kind
    // An approval card sits at the bottom; the conversation ends above it.
    const reading = kind === 'agent' && pane.approval ? Math.max(1, room - APPROVAL_ROWS - 1) : room
    rows.push(
      ...laneLines(
        frame.screen,
        kind ?? 'shell',
        body,
        reading,
        skin,
        pointer,
        frame.linkers,
        // The block where what you type lands, on the lane the keyboard is on.
        lane && typingIn(state) === 'pane' ? lane.cursor : null,
      ),
    )
  }
  // Anywhere on the agent's screen gives it the keyboard back, and the wheel
  // scrolls back through what it said. A split pane says which half it was.
  if (!split) {
    rows.forEach((row, i) => {
      if (i >= 2) {
        row.hits.unshift(rowHit(0, width, { kind: 'pane' }))
        row.hits.unshift(rowHit(0, width, { kind: 'scroll', area: 'pane' }))
      }
    })
  }

  while (rows.length < height) rows.push(blank(lane ? body : width))
  if (lane) {
    const seen = Math.max(0, height - 2)
    rows.splice(
      2,
      seen,
      ...barBeside(
        rows.slice(2, 2 + seen),
        {
          total: Math.max(lane.lines, seen),
          shown: seen,
          offset: Math.max(0, lane.lines - seen - state.paneScroll),
          rows: seen,
        },
        'pane',
        body,
        state,
        skin,
      ),
    )
  }
  const drawn = stack(rows.slice(0, height))
  // The approval card belongs to the agent's screen: over the ACTIONS tab it
  // would cover what somebody opened the tab to read, and in a split it stays
  // inside the agent's own half rather than laying itself over the shell
  // beside it — the divider is the edge of the agent's screen, not a line
  // drawn on top of one wide one.
  if (pane.approval && !work) {
    const half =
      split === null
        ? { width, height }
        : split.direction === 'beside'
          ? { width: width >= 24 ? besideFirst(width, split.ratio) : width, height }
          : { width, height: rows.length - room + belowFirst(room, split.ratio) }
    return withApproval(drawn, pane.approval, half, width, height, skin, pointer)
  }
  return drawn
}

/**
 * A lane's screen as rows, bottom-anchored for an agent. pi draws from the top
 * of a terminal and stops where its prompt is, which in a tall pane leaves the
 * prompt stranded half way down, so an agent's screen is read from the bottom,
 * like a conversation; a shell is left where it draws, because full-screen
 * programs count rows.
 */
function laneLines(
  screen: string,
  kind: string,
  width: number,
  rows: number,
  skin: Skin,
  pointer: Pointer,
  linkers: Frame['linkers'],
  cursor: LaneView['cursor'] | null = null,
): { text: string; hits: Hit[] }[] {
  const lines = screen.split('\n')
  const out: { text: string; hits: Hit[] }[] = []
  if (kind === 'agent') {
    while (lines.length > 0 && stripTerminalSequences(lines.at(-1) ?? '').trim() === '') lines.pop()
    for (let gap = rows - lines.length; gap > 0; gap--) out.push(blank(width))
  }
  // Which row the last line captured ended on: what the cursor is counted
  // back from, and the one thing the two anchorings above disagree about.
  const last = kind === 'agent' ? rows - 1 : Math.min(lines.length, rows) - 1
  for (const line of lines.slice(-rows)) out.push(linkedRow(line, width, skin, pointer, linkers))
  while (out.length < rows) out.push(blank(width))
  if (cursor) blockAt(out, last - cursor.back, cursor.column, width, skin)
  return out
}

/** Rows given what a click and the wheel anywhere on them mean, under what they already hold. */
function underTargets(
  rows: { text: string; hits: Hit[] }[],
  width: number,
  target: Target,
  scroll: ScrollArea | null,
): Drawn {
  return stack(
    rows.map((row) => ({
      text: row.text,
      hits: [
        ...(scroll ? [rowHit(0, width, { kind: 'scroll', area: scroll })] : []),
        rowHit(0, width, target),
        ...row.hits,
      ],
    })),
  )
}

/** How tall the approval card is: its border and two rows. */
const APPROVAL_ROWS = 4

/** A waiting approval, where the agent asked for it, answerable by click. */
function withApproval(
  pane: Drawn,
  approval: { tool: string; summary: string },
  /** The agent's own screen: where the card has to fit, and sit at the bottom of. */
  half: { width: number; height: number },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const cardWidth = Math.min(half.width - 4, 64)
  if (cardWidth < 30) return pane
  const inner = cardWidth - 2
  const card = box(
    'wants approval',
    [
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: 'approve' }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: 'deny' })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.chrome, title: skin.waiting, surface: false },
  )
  // Not modal: the agent's screen stays readable around it.
  return overlay(
    pane,
    card,
    { row: Math.max(2, Math.min(half.height, height) - card.rows.length - 1), col: 2 },
    width,
    skin,
    false,
  )
}

function renderWelcome(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const project = state.project
  const rows = [
    blank(width),
    new Row(width, skin)
      .space(3)
      .text(project ? `Nothing is running in ${project}.` : 'No projects yet.', skin.you)
      .build(),
    blank(width),
    new Row(width, skin, pointer)
      .space(3)
      .button('+ New agent', { kind: 'action', name: 'new-agent' }, project ? 'primary' : 'off')
      .space()
      .button(
        'Open project',
        { kind: 'action', name: 'open-project' },
        project ? 'rest' : 'primary',
      )
      .build(),
    blank(width),
    new Row(width, skin)
      .space(3)
      .text('Or hold ', skin.hint)
      .keys(voice.keys)
      .text(' and say what you want done.', skin.hint)
      .build(),
  ]
  return stack(rows.slice(0, height))
}

function describeState(pane: AgentPane): string {
  switch (pane.state) {
    case 'review':
      return 'Ready for review, and no agent is running'
    case 'parked':
      return 'Parked'
    case 'failed':
      return 'Its last run failed'
    default:
      return 'No agent is running here'
  }
}

/** Tab names for a task's lanes: `agent`, `shell`, `shell 2`. */
export function laneLabels(
  lanes: readonly { id: string; kind: string; title?: string }[],
): { id: string; label: string }[] {
  const seen = new Map<string, number>()
  return lanes.map((lane) => {
    const n = (seen.get(lane.kind) ?? 0) + 1
    seen.set(lane.kind, n)
    // A shell you named is called what you called it.
    if (lane.kind !== 'agent' && lane.title) return { id: lane.id, label: lane.title }
    return { id: lane.id, label: n === 1 ? lane.kind : `${lane.kind} ${n}` }
  })
}
