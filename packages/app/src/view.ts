import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { DONE_RULE_MEANS, describeLook, duration, type QueueState, taskOrigin } from '@tade/core'
import { type FileEntry, folderMark } from './files.ts'
import type {
  ActionsView,
  Change,
  CheckView,
  CommitView,
  Frame,
  LaneView,
  ListRowView,
  ListSectionView,
  NoteShown,
} from './frame.ts'
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
  chainOf,
  conversing,
  doneTasks,
  glyph,
  laneShown,
  MARK_TONES,
  markOf,
  offsetOf,
  planOf,
  QUEUE_FILTERS,
  type QueuedView,
  type QueueFilter,
  type QueueRow,
  queuedCount,
  queueEmptySays,
  queueRows,
  type ScheduleView,
  schedulesShown,
  sectionOpen,
  showingActions,
  shownName,
  spinner,
  splitShown,
  tasksOf,
} from './model.ts'
import { drawPanel } from './panel-view.ts'
import {
  drawPlan,
  drawWhy,
  layoutPlan,
  type PlanBox,
  type PlanRun,
  type PlanTone,
  planWidth,
  treeStems,
} from './plan-graph.ts'
import { BAR, barAcross } from './scrollbar.ts'
import { type Band, type Look, PLAIN, type Skin } from './skin.ts'
import {
  blank,
  box,
  type Drawn,
  fit,
  NO_POINTER,
  overlay,
  type Pointer,
  Row,
  slid,
  stack,
} from './ui.ts'
import { renderFoot } from './view/foot.ts'
import { blockAt, scrolledBar, typingIn } from './view/lane.ts'
import {
  barBeside,
  doing,
  isScrolling,
  type ListItem,
  MENU_ICON,
  markTone,
  secondRow,
  TAB_EDGES,
  TAB_ICONS,
  tabbed,
  tabList,
  toneOf,
} from './view/rows.ts'
import { belowFirst, besideFirst, splitView } from './view/split.ts'
import { renderStrip } from './view/strip.ts'
import {
  capitalised,
  clockOf,
  cutAtWord,
  dollars,
  saidShort,
  shortened,
  shortModel,
  shortPath,
  spell,
  tailOf,
  tokens,
  wrapPath,
  wrapWords,
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

/**
 * A control in a section's heading. The one that makes another of something
 * is a button; anything beside it is `small` — the same block two columns
 * narrower, so a heading reads as one set of controls with one of them
 * plainly the main one.
 */
interface SectionAction {
  label: string
  target: Target
  look?: Look
  small?: boolean
  /** Red only while the pointer is on it, as a glyph button is. */
  danger?: boolean
}

interface Section {
  id: string
  label: string
  count: number | null
  /**
   * What the count is out of, where the list is showing fewer rows than the
   * section holds — hiding the finished agents says `1/14`, not `1`, because a
   * badge that shrinks as things are hidden reads as agents having gone away.
   * Equal to `count` when nothing is hidden, and then only the count is drawn.
   */
  of?: number
  /** Rows when unfolded. At least one, so an open section never looks broken. */
  rows: (row: () => Row) => { text: string; hits: Hit[] }[]
  /** Its heading's controls, the main one last: the `+` sits against the edge. */
  actions?: SectionAction[]
  /** Said quietly at the right of the heading: what the section is measured against. */
  note?: string
  /**
   * The note in the room a narrow side leaves, drawn where the note itself
   * will not fit. A heading with nothing beside it is exactly what a folded
   * section has to avoid, so it says less rather than saying nothing.
   */
  brief?: string
  /**
   * Nothing in it, so it is folded until you open one. Carried on the heading
   * you press as well, so folding and drawing never read it differently.
   */
  quiet?: boolean
  /** Its items are tabs, and its rows carry their own room above and below them. */
  banded?: boolean
}

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
 * An agent down the side, as a tab: what it is doing, its name — cut short
 * with `…` rather than pushing anything off the edge — and what it has cost.
 * Under the pointer, a close and a menu take the cost's place, each lit in
 * turn: close in red, since it is a close.
 */
function taskRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  task: AgentPane & { focused: boolean; dragging?: boolean },
  spent: { tokens: number; usd: number } | undefined,
  now: number,
): ListItem {
  const target: Target = { kind: 'task', task: task.task }
  const close: Target = { kind: 'action', name: `close-task:${task.task}` }
  const menu: Target = { kind: 'task-menu', task: task.task }
  const pointed = pointingIn(pointer.hover, [target, close, menu])
  // Only where they are drawn: an invisible button is a trap. Not on the one in your hand.
  const buttons = pointed && !task.dragging
  const cost =
    !buttons && spent && (spent.usd > 0 || spent.tokens > 0)
      ? spent.usd > 0
        ? dollars(spent.usd)
        : tokens(spent.tokens)
      : ''
  // The one being dragged is lit wherever it would land.
  const band: Band | null = task.focused || task.dragging ? 'selected' : pointed ? 'hovered' : null
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  inner.text(glyph(task, now), toneOf(task, skin), target).space()
  const right = (cost ? visibleWidth(cost) + 1 : 0) + (buttons ? TAB_ICONS : 0)
  const room = Math.max(1, inner.width - inner.used - right - 1)
  inner.text(shortened(shownName(task), room), task.focused ? skin.you : (t) => t, target)
  inner.right((r) => {
    if (cost) r.text(cost, skin.hint, target).space()
    if (buttons) r.icon('×', close, 'danger').icon('≡', menu).space()
  })
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      // What it is doing, in words, under its name.
      secondRow(width, skin, pointer, band, doing(task), target, 3),
    ],
    band,
  }
}

/** Three glyph buttons at the end of a queued tab — pause, remove, menu — and the room after them. */
const QUEUE_ICONS = 10

/**
 * How queued work is marked: its shape, its colour, and what the right of its
 * tab says.
 *
 * Work at the front of the tree says how much has to happen before it, since
 * that is the whole answer to when it starts: `next` for the one only waiting
 * for room, `1 ahead` for the one behind a single agent. Deeper in a chain it
 * says nothing — the column it sits in already says how far back it is, and a
 * count on every row would cost every name the columns it is read in.
 */
function queueLook(
  queued: QueuedView,
  skin: Skin,
  frame: Frame,
  front = false,
): {
  glyph: string
  tone: (text: string) => string
  when: string
  whenTone: (text: string) => string
} {
  switch (queued.state.kind) {
    case 'held':
      return { glyph: '!', tone: skin.waiting, when: 'held', whenTone: skin.waiting }
    case 'ready':
      return { glyph: '◌', tone: skin.busy, when: 'next', whenTone: skin.busy }
    case 'waiting': {
      const ahead = queued.state.on.length
      return {
        glyph: '◌',
        tone: skin.hint,
        when: front && ahead > 0 ? `${ahead} ahead` : '',
        whenTone: skin.hint,
      }
    }
    case 'scheduled':
      return {
        glyph: '◷',
        tone: skin.hint,
        when: clockOf(frame)(queued.state.at),
        whenTone: skin.hint,
      }
    case 'paused':
      return { glyph: '‖', tone: skin.faded, when: 'paused', whenTone: skin.faded }
  }
}

/** A task's name without its project, which the list it is in already says. */
function inProject(project: string, text: string): string {
  return text.replaceAll(`${project}/`, '')
}

/** Who asked for queued work, in a word. */
function askedBy(by: string | undefined): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? 'you' : origin.name
}

/**
 * Who asked, as short as the row under a name needs: the marks the
 * conversation is drawn with — ❯ what you said, ◆ the orchestrator — or an
 * extension's or a schedule's own name.
 */
function askedMark(by: string | undefined): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? '❯' : origin.kind === 'orchestrator' ? '◆' : origin.name
}

/**
 * Who asked, then what queued work is waiting for, for the row under its name.
 * Who asked goes first: it is short, and a long reason cut with `…` must not
 * take it with it.
 */
function queueSays(pane: AgentPane & { queued: QueuedView }): string {
  const mark = askedMark(pane.by)
  const from = [...mark].length === 1 ? `${mark} ` : `${mark} · `
  const state = pane.queued.state
  switch (state.kind) {
    case 'held':
      return `${from}${inProject(pane.project, state.because)}`
    case 'waiting': {
      const [first, ...rest] = state.on.map((task) => inProject(pane.project, task))
      return `${from}after ${first ?? ''}${rest.length > 0 ? ` +${rest.length}` : ''}`
    }
    case 'ready':
      return `${from}waiting for room`
    case 'scheduled':
      return `${from}waits for its time`
    case 'paused':
      return `${from}paused`
  }
}

/**
 * The SMART QUEUE: work made and waiting to start, under the agents that are
 * working, with a filter over it once there is more than one to filter.
 *
 * In the order the resolved tree gives — what comes next first, and under each
 * piece whatever waits on it — each piece shifted right of what it waits on
 * and joined to it by a line, so the side says the same shape the plan does.
 *
 * It is drawn whether or not there is anything in it. With nothing waiting it
 * folds itself away, and then its heading is what says so — in the words of
 * the reason there is nothing, because a heading saying only its own name is
 * the section not being there at all, which is what this stopped being.
 */
function queueSection(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
  tree: QueueTree,
  all: number,
  open: boolean,
): Section {
  const quiet = all === 0
  return {
    id: 'queue',
    label: 'SMART QUEUE',
    count: all,
    banded: true,
    quiet,
    // The plan it came from, drawn where an agent's screen would be. Small,
    // because it opens what is already there rather than making another of
    // something — and because a narrow side gives it up before the count.
    ...(planOf(state).waits.length > 0
      ? {
          actions: [
            { label: 'plan', target: { kind: 'action' as const, name: 'queue-plan' }, small: true },
          ],
        }
      : {}),
    // Folded with nothing in it, the heading is the only place left to say
    // why there is nothing, so that is what it says.
    ...(quiet && !open ? { note: queueEmptySays(state), brief: 'none' } : {}),
    rows: (row) => {
      const entries = queueRows(state)
      const schedules = schedulesShown(frame.schedules ?? [], state)
      const filters = all > 1 ? [queueFilters(row(), state.queueFilter)] : []
      if (entries.length === 0 && schedules.length === 0) {
        // Why there is nothing, in the words of the reason there is nothing:
        // wrapped rather than cut, because the reason is the whole of what
        // this row is for.
        const none = wrapWords(queueEmptySays(state), Math.max(10, width - 6)).slice(0, 4)
        return [
          ...filters,
          blank(width),
          ...none.map((text) => row().space(3).text(text, skin.hint).build()),
          blank(width),
        ]
      }
      // Where the tree puts each piece, so the side reads like the plan does.
      const stems = queueStems(entries)
      return [
        ...filters,
        ...tabList(
          [
            ...entries.map((one, i) =>
              queueRow(width, skin, pointer, one, stems[i] ?? { stem: '', bars: '' }, frame, tree),
            ),
            ...schedules.map((one) =>
              scheduleRow(width, skin, pointer, one, state.schedule === one.id, frame),
            ),
          ],
          width,
        ),
      ]
    },
  }
}

/** How many schedules the project in front of you has, whatever the filter. */
function schedulesHere(state: AppState, frame: Frame): number {
  return (frame.schedules ?? []).filter((one) => one.project === (state.project ?? one.project))
    .length
}

/**
 * How a schedule is marked: once, on repeat, or a watch; paused, it is only
 * paused; a watch whose last look could not look needs you.
 */
function scheduleMark(
  one: ScheduleView,
  skin: Skin,
): { glyph: string; tone: (text: string) => string } {
  if (one.paused) return { glyph: '‖', tone: skin.faded }
  if (one.watch?.looks[0]?.problem) return { glyph: '!', tone: skin.waiting }
  if (one.kind === 'watch') return { glyph: '◎', tone: skin.hint }
  return { glyph: one.once ? '◷' : '↻', tone: skin.hint }
}

/**
 * A schedule down the side, as a tab: its mark, its name and when it next
 * runs; under it, who made it and when it runs. Under the pointer, pause (or
 * resume), remove and a menu take the place of when.
 */
function scheduleRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  one: ScheduleView,
  selected: boolean,
  frame: Frame,
): ListItem {
  const target: Target = { kind: 'action', name: `schedule-open:${one.id}` }
  const toggle: Target = {
    kind: 'action',
    name: `schedule-${one.paused ? 'resume' : 'pause'}:${one.id}`,
  }
  const remove: Target = { kind: 'action', name: `schedule-remove:${one.id}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'schedule', id: one.id } }
  const pointed = pointingIn(pointer.hover, [target, toggle, remove, menu])
  const band: Band | null = selected ? 'selected' : pointed ? 'hovered' : null
  const mark = scheduleMark(one, skin)
  const next = one.next[0]
  const when = one.paused ? 'paused' : next === undefined ? 'done' : clockOf(frame)(next)
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  inner.text(mark.glyph, mark.tone, target).space()
  const right = pointed ? QUEUE_ICONS : visibleWidth(when) + 1
  const room = Math.max(1, inner.width - inner.used - right - 1)
  const nameTone = selected ? skin.you : one.paused ? skin.faded : (text: string) => text
  inner.text(shortened(one.name, room), nameTone, target)
  inner.right((r) => {
    if (pointed) {
      r.icon(one.paused ? '▶' : '‖', toggle)
        .icon('×', remove, 'danger')
        .icon('≡', menu)
        .space()
    } else {
      r.text(when, one.paused ? skin.faded : skin.hint, target).space()
    }
  })
  const by = askedMark(one.by)
  const failing = one.paused ? null : (one.watch?.looks[0]?.problem ?? null)
  const said = `${[...by].length === 1 ? `${by} ` : `${by} · `}${failing ? 'could not look' : one.when}`
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      secondRow(width, skin, pointer, band, said, target, 3),
    ],
    band,
  }
}

/**
 * A schedule in front of you: when it runs and what it does each time, its
 * next runs, what happens to runs Tade was closed for, who made it, and what
 * it did each time it came due.
 */
function renderSchedule(
  state: AppState,
  frame: Frame,
  one: ScheduleView,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  // Its runs are days apart: a time alone would say every one of them at once.
  const clock = frame.date ?? clockOf(frame)
  const mark = scheduleMark(one, skin)
  const run: Target = { kind: 'action', name: `schedule-run:${one.id}` }
  const toggle: Target = {
    kind: 'action',
    name: `schedule-${one.paused ? 'resume' : 'pause'}:${one.id}`,
  }
  const remove: Target = { kind: 'action', name: `schedule-remove:${one.id}` }
  const menu: Target = { kind: 'menu', subject: { kind: 'schedule', id: one.id } }
  const controls = (r: Row) => {
    r.button('Run now', run, 'primary')
      .space()
      .button(one.paused ? '▶ Resume' : '‖ Pause', toggle)
      .space()
      .button('≡', menu)
      .space()
      .button('×', remove, 'danger')
      .space()
  }
  const probe = new Row(width, skin)
  controls(probe)
  const header = new Row(width, skin, pointer).space()
  const title = `${one.project} › ${one.name}`
  const word = `${mark.glyph} ${one.paused ? 'paused' : one.when}`
  header
    .text(shortened(title, Math.max(8, Math.floor((width - probe.used) / 2))), skin.you)
    .space(2)
    .text(shortened(word, Math.max(1, width - probe.used - visibleWidth(title) - 6)), mark.tone)
  header.right(controls)
  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  const said = (text: string) => shortened(text, Math.max(1, width - 16))
  for (const text of wrapWords(
    `${capitalised(one.when)}, it ${one.does}.`,
    Math.max(10, width - 6),
  ).slice(0, 2)) {
    line((r) => r.text(text, skin.you))
  }
  if (one.prompt.trim()) {
    rows.push(blank(width))
    line((r) => r.text(one.kind === 'ask' ? 'ASKS' : 'TELLS ITS AGENT', skin.label))
    const told = wrapWords(one.prompt.trim(), Math.max(10, width - 6))
    for (const text of told.slice(0, 6)) line((r) => r.text('│', skin.chrome).space().text(text))
    if (told.length > 6) line((r) => r.text('│', skin.chrome).space().text('…', skin.hint))
  }
  rows.push(blank(width))
  const fact = (label: string, value: string) =>
    line((r) => r.text(label.padEnd(10), skin.label).space().text(said(value), skin.hint))
  fact(
    'NEXT',
    one.paused
      ? 'paused'
      : one.next.length > 0
        ? one.next.map(clock).join(' · ')
        : 'nothing left to run',
  )
  fact('IF MISSED', one.missed === 'once' ? 'runs once when Tade next opens' : 'skipped')
  const from = askedBy(one.by)
  const who = (name: string) =>
    name === 'you' ? 'you' : name === 'orchestrator' ? 'the orchestrator' : name
  const watch = one.watch
  if (watch) {
    const acts = watch.found === 'agent' ? (watch.most === 1 ? 'agent' : 'agents') : 'told'
    fact('AT MOST', `${watch.most} ${acts} from one look; the rest wait for the next`)
  }
  fact(
    'FROM',
    `${who(from)}${watch ? ` · turned on by ${who(askedBy(watch.turnedOnBy))}` : ''}${one.said ? ` · “${one.said}”` : ''}`,
  )
  if (watch) {
    const room = Math.max(1, width - 4 - 18)
    if (watch.findings.length > 0) {
      rows.push(blank(width))
      line((r) => r.text('FOUND', skin.label))
      for (const each of watch.findings.slice(0, 6)) {
        line((r) => {
          r.text(clock(each.at).padEnd(18), skin.hint)
          const task = each.task ? state.panes.find((pane) => pane.task === each.task) : null
          if (task) {
            r.text(glyph(task, frame.now ?? 0), toneOf(task, skin))
              .space()
              .text(shortened(`${shownName(task)} · ${each.title}`, Math.max(1, room - 2)))
          } else if (each.task) {
            r.text(
              shortened(`${inProject(one.project, each.task)} · ${each.title}`, room),
              skin.hint,
            )
          } else if (each.told) {
            r.text(shortened(`told ${who(each.told)} · ${each.title}`, room), skin.hint)
          } else {
            r.text(shortened(`could not start · ${each.title}`, room), skin.waiting)
          }
        })
        if (!each.task && !each.told && each.problem) {
          line((r) => r.text(' '.repeat(18)).text(shortened(each.problem ?? '', room), skin.hint))
        }
      }
    }
    if (watch.looks.length > 0) {
      rows.push(blank(width))
      line((r) => r.text('LOOKS', skin.label))
      for (const look of watch.looks.slice(0, 6)) {
        line((r) =>
          r
            .text(clock(look.at).padEnd(18), skin.hint)
            .text(shortened(describeLook(look), room), look.problem ? skin.waiting : skin.hint),
        )
      }
    }
  } else if (one.runs.length > 0) {
    rows.push(blank(width))
    line((r) => r.text('RUNS', skin.label))
    for (const each of one.runs.slice(0, 8)) {
      line((r) => {
        r.text(clock(each.due).padEnd(18), skin.hint)
        if (!each.ran) {
          r.text(`skipped ${each.missed} missed while Tade was closed`, skin.faded)
          return
        }
        const task = each.task ? state.panes.find((pane) => pane.task === each.task) : null
        if (task)
          r.text(glyph(task, frame.now ?? 0), toneOf(task, skin))
            .space()
            .text(shownName(task))
        else
          r.text(
            each.task ? inProject(one.project, each.task) : 'ran',
            each.task ? skin.hint : (t) => t,
          )
        if (each.missed > 0) r.space(2).text(`${each.missed} missed before it`, skin.hint)
      })
    }
  }
  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}

/**
 * The filters over the SMART QUEUE: the set of small controls every other
 * heading has, and the one showing is filled in the brand's amber — what
 * being on looks like everywhere else in the window, taken from the skin so
 * it moves when the palette does. They light under the pointer as chips do,
 * because a control that never answers the pointer reads as a label.
 *
 * Nothing here pauses anything: pausing is something you do to one piece of
 * work, beside its name — in its tab, its menu, or on the card it opens — so
 * it is never in doubt which one you are pausing.
 */
function queueFilters(row: Row, current: QueueFilter): { text: string; hits: Hit[] } {
  row.space(2)
  QUEUE_FILTERS.forEach((filter, i) => {
    if (i > 0) row.space()
    row.chip(
      filter,
      { kind: 'action', name: `queue-filter:${filter}` },
      filter === current ? 'primary' : 'rest',
    )
  })
  return row.build()
}

/**
 * The lines drawn to the left of queued work, so the side says the same tree
 * the plan does: each piece shifted right of what it waits on, hanging from it
 * by a turn, and the lines of whatever is still to come carried down past it.
 *
 * A piece sits in the column its depth in the resolved tree gives it — not
 * in one counted off the rows above it — so work that can run side by side
 * lines up under work that can run side by side, and a filter that hides a
 * parent does not pull its children back to the front. The shallowest thing
 * shown starts at the left: the columns say what waits on what within the
 * queue, and the queue is what the side is a list of.
 *
 * `stem` goes before its mark; `bars` is what carries on under it, drawn both
 * on its second row and in the room beneath, so a two-row tab never breaks a
 * line in half. The lines themselves are `treeStems`', the same ones every
 * wait's reason is drawn with.
 */
function queueStems(rows: readonly QueueRow[]): { stem: string; bars: string }[] {
  const index = new Map(rows.map((row, i) => [row.pane.task, i]))
  // Only work that is shown can be hung from: a filter may leave a parent out.
  const parent = rows.map((row) => (row.parent === null ? -1 : (index.get(row.parent) ?? -1)))
  const front = rows.length === 0 ? 0 : Math.min(...rows.map((row) => row.depth))
  return treeStems(
    parent,
    rows.map((row) => row.depth - front),
  )
}

/**
 * Enough of a queued task's name, and of the reason under it, to be worth
 * reading. The tree is always laid out with this much room past its deepest
 * stem — further right than the side is wide, if that is what it takes — and
 * the side is a window onto it.
 */
const QUEUE_ROOM = 16

/** How far the tree of queued work reaches, and how much of it the side shows. */
interface QueueTree {
  /** Columns the deepest piece of it needs: what the side is a window onto. */
  wide: number
  /** Columns of it in view at once. */
  shown: number
  /** Columns of it scrolled past, off the left. */
  across: number
}

/**
 * How wide the queue's tree came out against the room the side has for it:
 * the deepest stem, its mark, and enough of a name to read.
 *
 * `wide` equal to `shown` is a tree that fits, and then nothing is drawn to
 * scroll it — a bar along the bottom of a side that fits costs a row to say
 * there is more when there is not — and each tab goes back to being laid out
 * in its own room, cut with an `…` as it always was.
 *
 * `shown` is the room a tab with nothing pinned at its right has. What the
 * pointer is on, and the couple of columns a `next` or a clock costs the row
 * it is on, are left out of the sums on purpose: a tree that reflowed as the
 * mouse moved across it would be worse than one you cannot read, and one
 * row's badge is no reason to say the whole list is too narrow.
 */
function queueSpread(
  stems: readonly { stem: string; bars: string }[],
  width: number,
): { wide: number; shown: number } {
  const shown = Math.max(1, width - TAB_EDGES - 1)
  const wide = stems.reduce(
    // A leading space, the stem, the mark and a space, then room for a name.
    (widest, one) => Math.max(widest, 4 + visibleWidth(one.stem) + QUEUE_ROOM),
    shown,
  )
  return { wide, shown }
}

/**
 * Queued work down the side, as a tab like an agent's: its mark, its name, and
 * when it starts; under it, what it waits for and who asked. It sits right of
 * what it waits on, hanging from it by a line. Under the pointer, pause (or
 * resume), remove and a menu take the place of when.
 *
 * The tree and the name are laid out in the room the tree needs and shown
 * through the room the side has, scrolled together by `tree.across`, so every
 * row moves by the same columns and a column goes on meaning what it meant.
 * What is pinned at the right — when it starts, and the controls under the
 * pointer — is pinned to the side and not to the tree: a button you cannot
 * reach because the chain is deep is a button that is gone.
 */
function queueRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  row: QueueRow,
  stems: { stem: string; bars: string },
  frame: Frame,
  tree: QueueTree,
): ListItem {
  const pane = row.pane
  const target: Target = { kind: 'task', task: pane.task }
  const paused = pane.queued.state.kind === 'paused'
  const toggle: Target = {
    kind: 'action',
    name: `queue-${paused ? 'resume' : 'pause'}:${pane.task}`,
  }
  const remove: Target = { kind: 'action', name: `queue-remove:${pane.task}` }
  const menu: Target = { kind: 'task-menu', task: pane.task }
  const pointed = pointingIn(pointer.hover, [target, toggle, remove, menu])
  const band: Band | null = pane.focused ? 'selected' : pointed ? 'hovered' : null
  const look = queueLook(pane.queued, skin, frame, row.parent === null)
  const shift = visibleWidth(stems.stem)
  const edge = Math.max(0, width - TAB_EDGES)
  const right = pointed ? QUEUE_ICONS : look.when ? visibleWidth(look.when) + 1 : 0
  const room = Math.max(1, edge - right - 1)
  // A tree that fits has no room of its own: every tab is laid out in the
  // room it has and cut with an `…`, exactly as it was before any of this.
  const canvas = tree.wide > tree.shown ? tree.wide : 0

  // Laid out in the tree's own room, then shown through the side's.
  const laid = new Row(Math.max(room, canvas), skin, pointer).space()
  if (stems.stem) laid.text(stems.stem, skin.chrome, target)
  laid.text(look.glyph, look.tone, target).space()
  const nameTone = pane.focused ? skin.you : paused ? skin.faded : (text: string) => text
  laid.text(shortened(shownName(pane), Math.max(1, laid.width - laid.used)), nameTone, target)
  const reach = laid.used
  const seen = edged(
    slid([laid.build()], tree.across, room)[0] ?? blank(room),
    room,
    reach > tree.across + room,
    skin,
  )

  const inner = new Row(edge, skin, pointer)
  inner.text(seen.text)
  inner.right((r) => {
    if (pointed) {
      r.icon(paused ? '▶' : '‖', toggle)
        .icon('×', remove, 'danger')
        .icon('≡', menu)
        .space()
    } else if (look.when) {
      r.text(look.when, look.whenTone, target).space()
    }
  })
  const first = inner.build()
  first.hits.push(...seen.hits)

  const laidSaid = new Row(Math.max(edge, canvas), skin, pointer).space()
  if (stems.bars) laidSaid.text(stems.bars, skin.chrome, target)
  // Level with the name above it, whatever lines pass under the mark.
  laidSaid.space(Math.max(1, shift + 3 - laidSaid.used))
  laidSaid.text(
    shortened(queueSays(pane), Math.max(1, laidSaid.width - laidSaid.used - 1)),
    skin.hint,
    target,
  )
  const said = edged(
    slid([laidSaid.build()], tree.across, edge)[0] ?? blank(edge),
    edge,
    laidSaid.used > tree.across + edge,
    skin,
  )

  return {
    rows: [tabbed(width, skin, band, first, target), tabbed(width, skin, band, said, target)],
    band,
    // The lines of what is still to come carry on through the room beneath it.
    ...(stems.bars
      ? {
          under:
            slid(
              [
                new Row(Math.max(width, canvas + TAB_EDGES / 2 + 1), skin)
                  .space(3)
                  .text(stems.bars, skin.chrome)
                  .build(),
              ],
              tree.across,
              width,
            )[0] ?? blank(width),
        }
      : {}),
  }
}

/**
 * A tab's row, cut at the side's edge with an `…` where its name carries on
 * past it. What is past it is scrolled to and not lost — but a name that
 * stops mid-letter with nothing to say why reads like the side broke, and
 * that is the reading this whole thing is here to end.
 */
function edged(
  row: { text: string; hits: Hit[] },
  width: number,
  more: boolean,
  skin: Skin,
): { text: string; hits: Hit[] } {
  if (!more || width < 1) return row
  const kept = fit(sliceByColumn(row.text, 0, width - 1), width - 1)
  return { ...row, text: `${kept}${skin.hint('…')}` }
}

/**
 * The picture of a plan where an agent's screen would be: the boxes and the
 * arrows, and the same tree again as the reason for every wait. Each part is
 * laid out in the room it needs and shown through the room there is, all of
 * them moving together, with a bar along the bottom where that is less than
 * all of it.
 *
 * A chain too wide for the pane is scrolled to, never folded into a list of
 * names: the columns and the arrows are the whole of what the picture says,
 * and a list says none of it. Each part keeps its heading where it is, so
 * what you are looking at is still named once you have moved along it.
 *
 * The bar goes under the first part rather than at the foot of the whole
 * thing: that is where the picture runs off the pane, and it is the part a
 * short pane still has room to show.
 */
function planPicture(
  state: AppState,
  skin: Skin,
  pointer: Pointer,
  width: number,
  parts: readonly { label?: string; rows: readonly PlanRun[][] }[],
): { text: string; hits: Hit[] }[] {
  const room = Math.max(1, width - 4)
  const wide = Math.max(room, ...parts.map((part) => planWidth(part.rows)))
  const across = Math.min(Math.max(0, state.planAcross), Math.max(0, wide - room))
  const paint = planPaint(skin)
  const scrolls: Target = { kind: 'scroll', area: 'plan' }
  const out: { text: string; hits: Hit[] }[] = []
  let drawn = 0
  for (const part of parts) {
    if (part.rows.length === 0) continue
    if (part.label !== undefined) {
      const label = part.label
      out.push(blank(width))
      out.push(new Row(width, skin, pointer).space(2).text(label, skin.label).build())
    }
    const laid = part.rows.map((runs) => {
      const r = new Row(2 + wide, skin, pointer).space(2)
      for (const run of runs) {
        r.text(
          run.text,
          run.tone ? paint[run.tone] : (text) => text,
          run.task ? { kind: 'task', task: run.task } : undefined,
        )
      }
      return r.build()
    })
    for (const row of slid(laid, across, width)) {
      // The wheel over the picture moves it: the hit goes under what is drawn,
      // so a box on it is still what a click lands on.
      out.push({ ...row, hits: [rowHit(0, width, scrolls), ...row.hits] })
    }
    drawn++
    if (drawn === 1 && wide > room) {
      const bar: Target = {
        kind: 'scrollbar',
        area: 'plan',
        total: wide,
        shown: room,
        across: true,
      }
      // Under the picture and no wider than it: a bar that ran the width of
      // the pane would be saying it was about the pane.
      const track = barAcross(
        { total: wide, shown: room, offset: across, rows: room },
        skin,
        isScrolling(state, 'plan', true),
      )
      out.push({
        text: `  ${track}${' '.repeat(Math.max(0, width - room - 2))}`,
        hits: [{ row: 0, from: 2, to: Math.max(2, room + 1), target: bar }],
      })
    }
  }
  return out
}

/**
 * The project's plan where an agent's screen would be: a column per step, a
 * box per task with its mark and what it is doing, an arrow for every wait,
 * and under it every wait's reason. Wider than the pane, it scrolls sideways.
 */
function renderPlan(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const { tasks, waits } = planOf(state)
  const working = tasks.filter((pane) => !pane.queued && markOf(pane) === 'working').length
  const queued = tasks.filter((pane) => pane.queued).length
  const header = new Row(width, skin, pointer).space()
  header.text(`${state.project ?? ''} › plan`, skin.you).space(2)
  header.text(`${tasks.length} tasks · ${working} working · ${queued} waiting to start`, skin.hint)
  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  if (tasks.length === 0) {
    line((r) => r.text('Nothing here waits on anything: there is no plan to draw.', skin.hint))
  }

  const boxes = planBoxes(tasks, frame, skin, null)
  const drawing = drawPlan(boxes, waits, Math.max(0, width - 4), (column) =>
    column === 0 ? 'FIRST' : 'THEN',
  )
  rows.push(
    ...planPicture(state, skin, pointer, width, [
      { rows: drawing.rows },
      ...(waits.length > 0
        ? [{ label: 'WHY THIS ORDER', rows: drawWhy(boxes, waits, Math.max(8, width - 4)) }]
        : []),
    ]),
  )

  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}

/** A plan box's tone, from the name the skin's tones go by. */
function planTone(tone: string): PlanTone {
  return tone === 'busy' ||
    tone === 'waiting' ||
    tone === 'bad' ||
    tone === 'done' ||
    tone === 'faded'
    ? tone
    : 'hint'
}

/** Which of the skin's tones each part of a drawn plan is painted in. */
function planPaint(skin: Skin): Record<PlanTone, (text: string) => string> {
  return {
    busy: skin.busy,
    hint: skin.hint,
    waiting: skin.waiting,
    bad: skin.bad,
    done: skin.done,
    faded: skin.faded,
    line: skin.chrome,
    label: skin.label,
    here: skin.you,
  }
}

/**
 * A box per piece of work, for a plan or for one path through it: its mark,
 * its name, what it cost or when it starts, and what it is doing — or, queued,
 * what it is waiting for. `here` is the one you are looking at, drawn heavier.
 */
function planBoxes(
  tasks: readonly AgentPane[],
  frame: Frame,
  skin: Skin,
  here: string | null,
): PlanBox[] {
  const spend = frame.spend?.byTask ?? {}
  const now = frame.now ?? 0
  return tasks.map((pane) => {
    const mine = pane.task === here ? { here: true } : {}
    if (pane.queued) {
      const look = queueLook(pane.queued, skin, frame)
      return {
        task: pane.task,
        mark: look.glyph,
        name: shownName(pane),
        right: look.when,
        note: queueSays({ ...pane, queued: pane.queued }),
        tone: planTone(
          pane.queued.state.kind === 'held'
            ? 'waiting'
            : pane.queued.state.kind === 'ready'
              ? 'busy'
              : pane.queued.state.kind === 'paused'
                ? 'faded'
                : 'hint',
        ),
        ...mine,
      }
    }
    const spent = spend[pane.task]
    return {
      task: pane.task,
      mark: glyph(pane, now),
      name: shownName(pane),
      right: spent && spent.usd > 0 ? dollars(spent.usd) : '',
      note: doing(pane),
      tone: planTone(MARK_TONES[markOf(pane)]),
      ...mine,
    }
  })
}

/** A queued task's state, in a word, for its card. */
function queueWord(state: QueueState): string {
  switch (state.kind) {
    case 'held':
      return 'held'
    case 'ready':
      return 'next'
    case 'waiting':
      return 'waiting'
    case 'scheduled':
      return 'at a time'
    case 'paused':
      return 'paused'
  }
}

/**
 * Queued work in front of you, where an agent's screen would be: where it
 * stands and what to do about it, the whole chain it is in drawn as boxes with
 * every wait's reason under it, what its agent will be told, and how it will
 * count as finished. This is what clicking it shows — looking at queued work
 * is not starting it, which is the Start now beside its name.
 */
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

/**
 * What an agent has actually done, where its screen would be: the commits it
 * made itself, kept apart from everybody else's; what it has changed and not
 * committed; the review it is out for; and how the project's own checks stand
 * at the commit in hand — what each one ran, how long it took, what it
 * counted, and what it printed.
 *
 * Everything here is a query somebody else answered: the rows are drawn from
 * the frame, and nothing in this function reads a file or asks a forge. The
 * page is laid out in full and handed back; the pane windows it and puts a
 * bar beside it, because a page that folds itself up is a page that hides the
 * failure you opened it for.
 */
function actionRows(
  view: ActionsView | null,
  pane: AgentPane,
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] }[] {
  const rows: { text: string; hits: Hit[] }[] = []
  const now = frame.now ?? 0
  const line = (build: (r: Row) => void, indent = 2) => {
    const r = new Row(width, skin, pointer).space(indent)
    build(r)
    rows.push(r.build())
  }
  const said = (text: string, from = 6) => shortened(text, Math.max(1, width - from))
  if (!view) {
    rows.push(blank(width))
    line((r) => r.text('Nothing is known about this work yet.', skin.hint))
    return rows
  }

  /**
   * A section: its name, a rule to where what it adds up to begins, and the
   * controls that act on it pinned to the edge. Three sections a page, each
   * announced the same way — the grouping is the whole of the design here.
   */
  const heading = (label: string, note: ((r: Row) => void) | null, controls?: (r: Row) => void) => {
    const whole = (r: Row) => {
      if (note) {
        note(r)
        r.space(controls ? 2 : 1)
      }
      if (controls) controls(r)
    }
    const measure = (build: (r: Row) => void) => {
      const probe = new Row(width, skin)
      build(probe)
      return probe.used
    }
    const left = 2 + visibleWidth(label) + 1
    // Short of room a heading gives up what it adds up to before it gives up
    // the button that acts on it — and the rule is drawn to whatever is left,
    // never to a group that will not fit and is dropped, which leaves the
    // heading with a stub of a line and a hole after it.
    const group =
      left + measure(whole) + 2 <= width
        ? whole
        : controls && left + measure(controls) + 2 <= width
          ? controls
          : null
    const r = new Row(width, skin, pointer).space(2).text(label, skin.label).space()
    r.text('─'.repeat(Math.max(1, width - r.used - (group ? measure(group) : 0) - 2)), skin.chrome)
    if (group) r.right(group)
    rows.push(r.build())
  }

  // ── Where the work is ──────────────────────────────────────────────────
  rows.push(blank(width))
  const ahead = view.ahead ?? 0
  const standing =
    ahead === 0 && view.mine.length === 0
      ? 'nothing committed yet'
      : [
          `${ahead} ahead${view.base ? ` of ${view.base}` : ''}`,
          view.behind ? `${view.behind} behind` : '',
        ]
          .filter(Boolean)
          .join(' · ')
  line((r) => {
    r.text(
      tailOf(view.branch ?? 'no branch yet', Math.max(8, width - standing.length - 8)),
      skin.you,
    )
    r.right((g) => g.text(standing, skin.hint).space(2))
  })
  if (view.review) {
    const review = view.review
    line((r) => {
      const marks = review.marks.map((mark) => mark.text).join(' ')
      r.text(review.number, skin.link, { kind: 'link', url: review.url })
        .space()
        .text(shortened(review.title, Math.max(6, width - 12 - visibleWidth(marks))))
      r.right((g) => {
        for (const mark of review.marks) g.text(mark.text, toneFor(mark.tone, skin)).space()
        g.space()
      })
    })
  }

  // ── What this agent committed, and what it has not ─────────────────────
  rows.push(blank(width))
  const added = view.mine.reduce((sum, one) => sum + (one.added ?? 0), 0)
  const removed = view.mine.reduce((sum, one) => sum + (one.removed ?? 0), 0)
  heading('THIS AGENT’S COMMITS', (g) => {
    if (view.mine.length === 0) return void g.text('none yet', skin.hint)
    g.text(`${view.mine.length}`, skin.hint)
    if (added > 0) g.text(` +${added}`, skin.done)
    if (removed > 0) g.text(` −${removed}`, skin.bad)
  })
  if (view.mine.length === 0) {
    line(
      (r) =>
        r.text(
          said('No commit carries this task’s trailer yet, so none of these are its own.'),
          skin.hint,
        ),
      4,
    )
  }
  for (const commit of view.mine.slice(0, OWN_COMMITS)) {
    line((r) => commitRow(r, commit, now, skin, true))
  }
  if (view.mine.length > OWN_COMMITS) {
    line((r) => r.text(`and ${view.mine.length - OWN_COMMITS} more`, skin.hint), 4)
  }
  // Uncommitted work is this agent's outstanding work — except where it is
  // not, which is every shared checkout, and is said rather than counted as
  // its own.
  if (view.dirty === 0) {
    line((r) =>
      r.text('◌', skin.chrome).space().text('Nothing changed and not committed.', skin.hint),
    )
  } else {
    const files = `${view.dirty} file${view.dirty === 1 ? '' : 's'} not committed`
    const whose = view.shared
      ? 'shared checkout — Tade cannot say which are this agent’s'
      : 'in its own worktree, so all of them are its own'
    line((r) => {
      r.text('◌', skin.waiting).space().text(files, skin.you)
      r.right((g) => g.text(shortened(whose, Math.max(10, width - 30)), skin.hint).space(2))
    })
  }

  // ── How it stands ──────────────────────────────────────────────────────
  rows.push(blank(width))
  const run: Target = { kind: 'action', name: `checks-run:${pane.task}` }
  const adopt: Target = { kind: 'action', name: `checks-adopt:${pane.task}` }
  const going = view.running
  const at = view.commit ? view.commit.slice(0, 7) : 'no commit'
  const rollup = (g: Row) => {
    // A run going on says how far along it is; otherwise the rollup, in the
    // one word the whole page is about — and `unknown` is one of the three.
    if (going) {
      g.meter(going.total === 0 ? 0 : going.done / going.total, 6, skin.busy)
        .space()
        .text(`${going.done} of ${going.total}`, skin.busy)
        .space()
        .text(spell((now - going.since) / 1000), skin.hint)
      return
    }
    if (!view.commit) return void g.text('no commit to check yet', skin.waiting)
    const word =
      view.rollup === 'pass' ? 'green' : view.rollup === 'fail' ? 'red' : 'nobody has run these'
    const tone =
      view.rollup === 'pass' ? skin.done : view.rollup === 'fail' ? skin.bad : skin.waiting
    g.text(word, tone).text(` at ${at}`, skin.hint)
  }
  heading('CHECKS', rollup, (r) => {
    // Adoption is the act that makes these runnable, so it sits where the
    // thing it unlocks is — and `Run all` stays primary, because once a
    // project has adopted them that is the only button that matters.
    if (view.adoptable) r.chip('Adopt from CI', adopt).space()
    r.button(going ? 'Running…' : 'Run all', run, going ? 'rest' : 'primary').space()
  })
  // Where they came from is load-bearing in exactly two cases: there are none,
  // and there are some that nothing here may run. Anywhere else it is a row
  // spent saying `.tade/checks.yaml` to somebody who wrote it.
  if (view.checks.length === 0 || view.adoptable) {
    line((r) => r.text(said(view.source), skin.hint))
  }
  // Said once, where it is the whole answer: absent is not fine, and a page
  // that leaves `unknown` looking like a quiet green is the bug this rule is
  // for. Not said where the row above already explains why nothing has run.
  if (!going && view.rollup === 'unknown' && view.checks.length > 0 && !view.adoptable) {
    line((r) =>
      r.text(
        said(
          view.commit
            ? 'Nobody has run these over this commit, which is not the same as their passing.'
            : 'Nothing is committed here yet, and a check is always about a commit.',
        ),
        skin.hint,
      ),
    )
  }
  for (const check of view.checks) {
    rows.push(...checkRows(check, pane.task, state, now, width, skin, pointer))
  }
  // ── What else landed on this branch ────────────────────────────────────
  if (view.others.length > 0) {
    rows.push(blank(width))
    heading('ALSO ON THIS BRANCH', (g) =>
      g.text(`${view.others.length}, not this agent’s`, skin.hint),
    )
    for (const commit of view.others.slice(0, OTHER_COMMITS)) {
      line((r) => commitRow(r, commit, now, skin, false))
    }
    if (view.others.length > OTHER_COMMITS) {
      line((r) => r.text(`and ${view.others.length - OTHER_COMMITS} more`, skin.hint), 4)
    }
  }

  for (const note of view.notes) {
    rows.push(blank(width))
    for (const part of wrapWords(note, Math.max(20, width - 6))) {
      line((r) => r.text(part, skin.hint))
    }
  }
  return rows
}

/** How many of each kind of commit the page shows before it says how many more. */
const OWN_COMMITS = 5
const OTHER_COMMITS = 2

/** One commit: whose it is in the glyph, what it touched on the right. */
function commitRow(r: Row, commit: CommitView, now: number, skin: Skin, own: boolean): void {
  const touched = [
    commit.files === null ? '' : `${commit.files} file${commit.files === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join('')
  const when = commit.at > 0 ? `${duration(Math.max(0, now - commit.at))} ago` : ''
  const group = (g: Row) => {
    if (!own && commit.task) g.text(shortened(commit.task, 22), skin.hint).space(2)
    if (touched) g.text(touched, skin.hint).space()
    if (commit.added) g.text(`+${commit.added}`, skin.done).space()
    if (commit.removed) g.text(`−${commit.removed}`, skin.bad).space()
    if (when) g.space().text(when, skin.hint)
    g.space()
  }
  const probe = new Row(r.width, skin)
  group(probe)
  r.text(own ? '●' : '·', own ? skin.done : skin.chrome)
    .space()
    .text(commit.sha.slice(0, 7), skin.hint)
    .space()
  const room = Math.max(6, r.width - r.used - probe.used - 2)
  r.text(shortened(commit.subject, room), own ? (text) => text : skin.hint)
  r.right(group)
}

/**
 * One check, as two or three rows: how it went and what it counted on the
 * line you scan, the command it ran under it, and where it went wrong under
 * that. Open — clicked — it also shows the last of what it printed, which is
 * what a red check is opened for and the reason this page exists.
 */
function checkRows(
  check: CheckView,
  task: string,
  state: AppState,
  now: number,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] }[] {
  const rows: { text: string; hits: Hit[] }[] = []
  const target: Target = { kind: 'check', task, check: check.id }
  const open = state.openCheck[task] === check.id
  const red = check.state === 'failed' || check.state === 'timed out'
  const going = check.state === 'running' || check.state === 'queued'
  const tone = check.state === 'passed' ? skin.done : red ? skin.bad : going ? skin.busy : skin.hint
  const line = (build: (r: Row) => void, indent = 6) => {
    const r = new Row(width, skin, pointer).space(indent)
    build(r)
    rows.push(r.build())
  }
  const took =
    check.state === 'running' && check.startedAt
      ? spell((now - check.startedAt) / 1000)
      : check.seconds === null
        ? ''
        : spell(check.seconds)
  const when =
    check.state === 'running'
      ? 'going now'
      : check.state === 'queued'
        ? 'waiting its turn'
        : check.at
          ? `${duration(Math.max(0, now - check.at))} ago`
          : check.skip
            ? 'cannot run here'
            : 'nobody has run it'
  const hovered = sameTarget(pointer.hover, target)
  // The line you scan: what it is, how it went, how long it took, when — and
  // what it counted, pinned right, which is the answer somebody came for.
  const head = new Row(width, skin, pointer).space(2)
  head
    .text(check.state === 'running' ? spinner(now) : glyphFor(check.state), tone)
    .space()
    .text(check.id.padEnd(8), hovered ? skin.you : (text) => text)
    .space()
    .text(check.state.padEnd(8), tone)
    .space()
    .text(took.padStart(6), skin.hint)
    .space(2)
    .text(when, skin.hint)
  head.right((g) => {
    if (check.counts.length > 0) {
      check.counts.forEach((count, i) => {
        if (i > 0) g.text(' · ', skin.chrome)
        const paint =
          count.tone === 'good' ? skin.done : count.tone === 'bad' ? skin.bad : skin.hint
        g.text(`${count.count} ${count.label}`, count.count === 0 ? skin.hint : paint)
      })
    } else if (check.summary && check.state !== 'passed') {
      g.text(shortened(check.summary, Math.max(8, Math.floor(width / 2))), skin.hint)
    } else if (!check.required) {
      g.text('not required', skin.hint)
    }
    g.space(2)
  })
  const built = head.build()
  rows.push({
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, width, target), ...built.hits],
  })
  // What actually ran, which is the question a green tick never answers —
  // and, beside it, the way into what it printed.
  const under = (text: string, paint: (text: string) => string) =>
    line((r) => {
      const chip = check.tail.length > 0 ? (open ? '▴ hide' : '▾ what it printed') : ''
      const room = Math.max(8, width - 8 - (chip ? visibleWidth(chip) + 5 : 0))
      r.text(shortened(text, room), paint)
      if (chip) r.right((g) => g.chip(chip, target).space(2))
    })
  const after = check.needs.length > 0 ? `  (after ${check.needs.join(', ')})` : ''
  if (check.skip) under(check.skip, skin.hint)
  else if (check.run) under(`${check.run}${after}`, skin.chrome)
  // What it ran at, where that is not the commit in hand: a run carries to a
  // later commit only over the very bytes it read, and is never silent about it.
  if (check.carried && check.commit) {
    line((r) => r.text(`ran at ${check.commit?.slice(0, 7)}, over these very bytes`, skin.hint))
  }
  const places = open ? check.places : check.places.slice(0, 1)
  for (const place of places) {
    line((r) => {
      r.text(shortPath(place.path, Math.max(12, width - 24)), red ? skin.you : skin.hint)
      if (place.at) r.text(`:${place.at}`, skin.hint)
      if (place.note) {
        r.space(2).text(shortened(place.note, Math.max(6, width - r.used - 8)), skin.hint)
      }
    })
  }
  const rest = check.more + (check.places.length - places.length)
  if (rest > 0) line((r) => r.text(`and ${rest} more`, skin.hint))
  if (open && check.tail.length > 0) {
    for (const text of check.tail) {
      line((r) =>
        r
          .text('│', skin.chrome)
          .space()
          .text(shortened(text, Math.max(8, width - 12))),
      )
    }
    line((r) =>
      r
        .chip('the whole log', { kind: 'action', name: `check-log:${task}\u0000${check.id}` })
        .space()
        .text('in the conversation', skin.hint),
    )
  }
  return rows
}

/** A mark's tone, as the skin says it. Quiet by default: most marks are facts. */
function toneFor(
  tone: 'quiet' | 'good' | 'warning' | 'bad' | undefined,
  skin: Skin,
): (text: string) => string {
  if (tone === 'bad') return skin.bad
  if (tone === 'good') return skin.done
  if (tone === 'warning') return skin.waiting
  return skin.hint
}

/** A check's state as one character, the same one the CLI prints. */
function glyphFor(state: string): string {
  if (state === 'passed') return '✓'
  if (state === 'failed' || state === 'timed out') return '✗'
  if (state === 'skipped' || state === 'cancelled') return '–'
  if (state === 'not run') return '◦'
  return '⋯'
}

function renderQueued(
  state: AppState,
  frame: Frame,
  pane: AgentPane & { queued: QueuedView },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const queued = pane.queued
  const look = queueLook(queued, skin, frame)
  const clock = clockOf(frame)
  const start: Target = { kind: 'action', name: `queue-start:${pane.task}` }
  const paused = queued.state.kind === 'paused'
  const toggle: Target = {
    kind: 'action',
    name: `queue-${paused ? 'resume' : 'pause'}:${pane.task}`,
  }
  const remove: Target = { kind: 'action', name: `queue-remove:${pane.task}` }
  const controls = (r: Row) => {
    r.button('Start now', start, 'primary')
      .space()
      .button(paused ? '▶ Resume' : '‖ Pause', toggle)
      .space()
      .button('×', remove, 'danger')
      .space()
  }
  const probe = new Row(width, skin)
  controls(probe)
  const header = new Row(width, skin, pointer).space()
  const word = `${look.glyph} ${queueWord(queued.state)}`
  const title = `${pane.project} › ${shownName(pane)}`
  header
    .text(shortened(title, Math.max(8, width - probe.used - visibleWidth(word) - 5)), skin.you)
    .space(2)
    .text(word, look.tone)
  header.right(controls)

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  const name = (task: string) => inProject(pane.project, task)
  const said = (text: string) => shortened(text, Math.max(1, width - 6))
  switch (queued.state.kind) {
    case 'held': {
      const because = inProject(pane.project, queued.state.because)
      line((r) =>
        r
          .text('!', skin.waiting)
          .space()
          .text(said(`Held: ${because}.`), skin.you),
      )
      line((r) => r.space(2).text('It will not start by itself. What should happen?', skin.hint))
      rows.push(blank(width))
      line((r) =>
        r
          .button(
            'Wait for a retry',
            { kind: 'action', name: `queue-wait:${pane.task}` },
            'attention',
          )
          .space()
          .button('Start anyway', start)
          .space()
          .button('Remove', remove, 'danger'),
      )
      break
    }
    case 'waiting': {
      const on = queued.state.on.map(name)
      line((r) =>
        r
          .text('◌', skin.hint)
          .space()
          .text(said(`Waits on ${on.join(', ')}, then starts by itself.`)),
      )
      break
    }
    case 'ready':
      line((r) =>
        r
          .text('◌', skin.busy)
          .space()
          .text(said(`Starts as soon as ${pane.project} has room for another agent.`)),
      )
      break
    case 'scheduled': {
      const at = queued.state.at
      line((r) =>
        r
          .text('◷', skin.hint)
          .space()
          .text(said(`Starts at ${clock(at)}.`)),
      )
      break
    }
    case 'paused':
      line((r) =>
        r.text('‖', skin.faded).space().text(said('Paused: it starts when you resume it.')),
      )
      break
  }

  // The whole path it is on, drawn: everything it waits on however far back,
  // everything that waits on it, a box each, and an arrow for every wait. Its
  // own box is the heavy one. Wider than the pane, it is scrolled along — a
  // chain that loses its boxes the moment it gets long loses them exactly
  // when there was something to see.
  const chain = chainOf(state, pane.task)
  const boxes = planBoxes(chain.tasks, frame, skin, pane.task)
  const laid = layoutPlan(
    chain.tasks.map((one) => one.task),
    chain.waits,
  )
  const at = laid.columns.findIndex((column) => column.includes(pane.task))
  const drawing =
    chain.waits.length > 0
      ? drawPlan(boxes, chain.waits, Math.max(0, width - 4), (column) =>
          column === at ? 'THIS ONE' : column > at ? 'AFTER IT' : column === 0 ? 'FIRST' : 'THEN',
        )
      : null
  if (drawing || chain.waits.length > 0) {
    rows.push(
      ...planPicture(state, skin, pointer, width, [
        ...(drawing ? [{ label: 'THE CHAIN IT IS IN', rows: drawing.rows }] : []),
        ...(chain.waits.length > 0
          ? [
              {
                label: 'WHY IT WAITS',
                rows: drawWhy(boxes, chain.waits, Math.max(8, width - 4)),
              },
            ]
          : []),
      ]),
    )
  } else if (queued.after.length > 0) {
    rows.push(blank(width))
    line((r) => r.text('WAITS ON', skin.label))
    for (const dep of queued.after) {
      const other = state.panes.find((one) => one.task === dep.task)
      const to: Target = { kind: 'task', task: dep.task }
      line((r) => {
        r.text(other ? glyph(other, frame.now ?? 0) : '✕', other ? toneOf(other, skin) : skin.bad)
        r.space()
          .text(name(dep.task), (text) => text, to)
          .space(2)
        // What it waits on may itself be waiting: then that is what it is doing.
        const now = !other
          ? 'not there any more'
          : other.queued
            ? queueSays({ ...other, queued: other.queued })
            : doing(other)
        r.text(said(now), skin.hint)
      })
      if (dep.why) line((r) => r.space(2).text(said(dep.why), skin.hint))
    }
  }

  if (queued.prompt.trim()) {
    rows.push(blank(width))
    line((r) => r.text('WILL BE TOLD', skin.label))
    const told = wrapWords(queued.prompt.trim(), Math.max(10, width - 6))
    for (const text of told.slice(0, 6)) line((r) => r.text('│', skin.chrome).space().text(text))
    if (told.length > 6) line((r) => r.text('│', skin.chrome).space().text('…', skin.hint))
  }

  rows.push(blank(width))
  const fact = (label: string, value: string) =>
    line((r) => r.text(label.padEnd(10), skin.label).space().text(said(value), skin.hint))
  if (queued.touches.length > 0) fact('TOUCHES', queued.touches.join(', '))
  fact('FINISHES', DONE_RULE_MEANS[pane.done ?? 'said'])
  const from = askedBy(pane.by)
  fact('FROM', from === 'you' ? 'you' : from === 'orchestrator' ? 'the orchestrator' : from)

  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
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
