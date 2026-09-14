import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { type FileEntry, folderMark } from './files.ts'
import { type Hit, rowHit, type ScrollArea, sameTarget, shift, type Target } from './hits.ts'
import { keyCaps } from './keys.ts'
import { type LayoutPrefs, resolveLayout } from './layout.ts'
import { type Linker, linkedRow } from './links.ts'
import {
  type AgentPane,
  type AppState,
  conversing,
  glyph,
  isAction,
  laneShown,
  matchActions,
  ORCHESTRATOR_TAB,
  projects,
  shownName,
  splitShown,
  tasksOf,
  terminalSplitShown,
  terminalsOf,
} from './model.ts'
import { drawPanel, type PanelContext } from './panel-view.ts'
import { PLAIN, type Skin } from './skin.ts'
import type { SpendView } from './spend.ts'
import { type Line, transcriptLines } from './transcript-view.ts'
import { blank, box, type Drawn, fit, overlay, type Pointer, Row, stack } from './ui.ts'

// Drawing, as one pure function of state.
//
// The window is shaped like the thing it is showing. Projects are tabs along
// the top, because you are in one at a time. The agents in that project are
// down the side, with where they work and what they have changed, the middle is the agent you
// are watching, and the orchestrator runs along the bottom, always there and
// not closeable — it is how you know what Wilco heard. Money is bottom right,
// what needs you and the key to talk with are top right, and a panel, when one
// is open, floats over all of it.
//
// Composition is done here rather than with a layout engine because the panes
// have to tail: an agent's newest output is the point, and a stack that clips
// from the bottom would show you the top of the screen instead.

export type { Drawn } from './ui.ts'

/** A file the task has changed, as git sees it. */
export interface Change {
  path: string
  /** `M`odified, `A`dded, `D`eleted, `R`enamed, `?` untracked, `U`nmerged. */
  mark: string
  added: number | null
  removed: number | null
}

export interface Frame {
  width: number
  height: number
  /** The focused lane's screen, as captured. May carry ANSI. */
  screen: string
  /** The orchestrator's own screen, when it is running where you can see it. */
  orchestrator?: string
  /**
   * The terminal in front of the bottom panel: its screen as captured, and —
   * while finding in it — its scrollback as plain text, the line found, and
   * what was looked for.
   */
  terminal?: {
    screen: string
    find?: { lines: readonly string[]; line: number | null; query: string } | null
  }
  /** The files of the focused agent's worktree, or of the project when there is none. */
  files?: readonly FileEntry[]
  /** What git says about those files, by path: `M`, `A`, `D`, `R`, `U`, `!`. */
  fileMarks?: Readonly<Record<string, string>>
  /**
   * Where the work is: the project's repository, the branch in front of you,
   * and — for an agent — the branch it started from and the worktree it is in.
   * Paths as you would type them.
   */
  where?: {
    repo: string
    branch: string | null
    base: string | null
    worktree: string | null
    /** Where that is on this machine, in full: the worktree, or the repository. */
    path: string
    /** The same, from your home as you would type it: `~/src/checkout`. */
    shownPath?: string
    /** Where the agent's work came from — an issue, a trace — each opened by a click. */
    links?: readonly { title: string; url: string }[]
  } | null
  /** What the focused agent has changed since it branched. */
  changes?: readonly Change[]
  /** The branch those changes are counted against. */
  base?: string | null
  /** What you have told Wilco about this project, newest first. */
  notes?: readonly string[]
  /** Today's spend, in total and by task. */
  spend?: Spend
  /**
   * What the agent you are looking at runs on, as configured, and how that
   * provider is paid for: `signed in`, `API key`, `env API key`.
   */
  route?: {
    harness: string
    model: string | null
    provider: string | null
    credential?: string | null
  }
  /** What it says it actually runs on, and how full its context is. */
  vitals?: { model: string | null; contextPercent: number | null } | null
  /** The Spend panel's view, when it is open. */
  spendView?: SpendView | null
  /** What the open panel needs that the window does not: a menu, a diff, models. */
  panel?: Partial<
    Pick<
      PanelContext,
      | 'items'
      | 'changes'
      | 'ahead'
      | 'branch'
      | 'base'
      | 'diff'
      | 'choices'
      | 'settings'
      | 'accounts'
      | 'configPath'
      | 'releases'
      | 'budgetWarnings'
      | 'levels'
      | 'openRows'
      | 'browsing'
      | 'homeDir'
      | 'entries'
      | 'talkKey'
      | 'talkMode'
      | 'running'
      | 'searching'
      | 'viewing'
      | 'branches'
      | 'checkout'
      | 'found'
      | 'terminalName'
      | 'extensions'
      | 'harnessExtensions'
      | 'extensionsRoot'
      | 'models'
      | 'modelTarget'
      | 'currentModel'
      | 'proposals'
      | 'setup'
      | 'extensionView'
    >
  >
  /** The key you hold to talk, and whether there is anything to hear you. */
  voice?: { keys: readonly string[]; available: boolean }
  /** Wilco's home, as you would type it, for showing where worktrees go. */
  home?: string
  /** Who pays for the orchestrator's model: its provider, and how you are signed in to it. */
  orchestratorAccount?: { provider: string | null; credential: string | null }
  /** Nothing is said or played. */
  muted?: boolean
  /** A picture is on the clipboard, and has not been taken or turned down. */
  clipboardImage?: boolean
  /** Extensions that need setting up, or are broken: the Extensions button says so. */
  extensionsNeedYou?: number
  /** The second lane of a split pane, as captured. */
  splitScreen?: string
  /** The second terminal of a split bottom panel. */
  splitTerminal?: Frame['terminal']
  /** The window's own keys as set, for the keys sheet. */
  bindings?: Readonly<Record<string, string>>
  /** The orchestrator's input, as its editor draws it, rules included, while it is being typed in. */
  input?: { lines: string[] }
  /** What extensions keep in the status bar. */
  statuses?: readonly {
    extension: string
    text: string
    tone: 'quiet' | 'warning' | 'bad'
    viewable: boolean
  }[]
  /** The orchestrator's model, shown on its tab: undefined where the window has no orchestrator. */
  orchestratorModel?: string | null
  /** Text extensions know how to open, made clickable wherever it is shown. */
  linkers?: readonly Linker[]
  now?: number
  /** How to divide the window. Defaults when absent. */
  layout?: LayoutPrefs
  /** How to colour it. Plain unless told otherwise. */
  skin?: Skin
}

export interface Spend {
  tokens: number
  usd: number
  hasCost: boolean
  byTask: Readonly<Record<string, { tokens: number; usd: number }>>
}

/**
 * The footer's buttons: the few things that are not about an agent. Starting
 * one and opening a project have their own `+` where agents and projects are,
 * and search has ctrl+k beside the talk key. Each is grey unless there is
 * something to say: an extension that needs you, or sound that is off.
 */
export const BUTTONS: readonly { label: string; action: string }[] = [
  { label: 'Extensions', action: 'extensions' },
  { label: 'Settings', action: 'settings' },
  { label: 'Mute', action: 'mute' },
]

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
    home: frame.home ?? '~/.wilco',
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
    configPath: extra.configPath ?? '~/.wilco/config.yaml',
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
    extensionsRoot: extra.extensionsRoot ?? '~/.wilco/extensions',
    models: extra.models ?? [],
    modelTarget: extra.modelTarget ?? 'the orchestrator',
    currentModel: extra.currentModel ?? null,
    proposals: extra.proposals ?? [],
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
    // Not faded, but still a menu: a click anywhere else closes it.
    drawn = {
      rows: drawn.rows,
      hits: [
        ...drawn.rows.map((_, i) => rowHit(i, width, { kind: 'dismiss' })),
        ...drawn.hits.filter((hit) => hit.target.kind !== 'dismiss').slice(window.hits.length),
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

/**
 * An agent you are not looking at needs you: a card under the tabs, answerable
 * where it appears. Only for what blocks an agent — news that does not need
 * you goes to the orchestrator's transcript.
 */
function toastFor(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn | null {
  const shown = state.toasts
    .map((toast) => ({ toast, pane: state.panes.find((pane) => pane.task === toast.task) }))
    .filter(({ pane }) => pane?.waiting && pane.approval && pane.task !== state.focused)
    .at(-1)
  if (!shown?.pane?.approval || width < 70) return null
  const { toast, pane } = shown
  const approval = pane.approval
  if (!approval) return null
  const cardWidth = 52
  const inner = cardWidth - 2
  const seconds = Math.max(0, Math.floor(((frame.now ?? toast.at) - toast.at) / 1000))
  const card = box(
    `${skin.waiting('●')} ${pane.project} › ${shownName(pane)}`,
    [
      new Row(inner, skin)
        .space()
        .text('wants approval', skin.waiting)
        .right((r) => r.text(`${seconds}s`, skin.hint).space())
        .build(),
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      blank(inner),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: `toast-allow:${pane.task}` }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: `toast-deny:${pane.task}` })
        .space()
        .button('Show', { kind: 'action', name: `toast-show:${pane.task}` })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.waiting, corner: '×' },
  )
  // The × in the corner closes it.
  card.hits.push({
    row: 0,
    from: cardWidth - 5,
    to: cardWidth - 3,
    target: { kind: 'action', name: `toast-close:${pane.task}` },
  })
  return card
}

// ── Top: projects, what needs you, and the key to talk ───────────────────────

function renderTop(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space().text('WILCO', skin.brand).space(2)
  for (const project of projects(state)) {
    row.tab(project, { kind: 'project', project }, project === state.project)
  }
  row.space().button(' + ', { kind: 'action', name: 'open-project' }, 'add')

  const waiting = state.panes.filter((pane) => pane.waiting || pane.state === 'blocked').length
  const working = state.panes.filter((pane) => pane.state === 'working').length
  // The talk key is the one thing here that must survive a narrow terminal;
  // search is next, then what waits on you. The counts shorten, then go, first.
  type Counts = 'full' | 'short' | 'waiting' | 'none'
  const right = (show: { search: boolean; counts: Counts }) => (r: Row) => {
    if (waiting > 0 && show.counts !== 'none') {
      const label = show.counts === 'full' ? `● ${waiting} waiting` : `● ${waiting}`
      r.text(label, skin.waiting, { kind: 'action', name: 'next-waiting' }).space(2)
    }
    if (working > 0 && (show.counts === 'full' || show.counts === 'short')) {
      r.text(show.counts === 'full' ? `○ ${working} working` : `○ ${working}`, skin.busy).space(3)
    }
    // Search, beside talking: the two keys that work from anywhere.
    if (show.search) {
      const search: Target = { kind: 'action', name: 'search' }
      r.keys(keyCaps(frame.bindings?.search ?? 'ctrl+k')).space()
      r.text('search', sameTarget(state.hover, search) ? skin.link : skin.hint, search).space(3)
    }
    talkChip(r, state, frame, skin)
    r.space()
  }
  const tries: { search: boolean; counts: Counts }[] = [
    { search: true, counts: 'full' },
    { search: true, counts: 'short' },
    { search: true, counts: 'waiting' },
    { search: false, counts: 'short' },
    { search: false, counts: 'waiting' },
    { search: false, counts: 'none' },
  ]
  const fits = tries.find((show) => {
    const probe = new Row(width, skin)
    right(show)(probe)
    return row.used + 1 + probe.used <= width
  })
  row.right(right(fits ?? { search: false, counts: 'none' }))
  // A row of room under the rule, so the tabs below are not pressed against it.
  return stack([row.build(), { text: skin.chrome('━'.repeat(width)), hits: [] }, blank(width)])
}

/**
 * The key you talk with, always on screen, in whatever state talking is in.
 * Red while the microphone is open: that is never something to have to infer.
 */
function talkChip(r: Row, state: AppState, frame: Frame, skin: Skin): void {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const target: Target = { kind: 'action', name: 'voice' }
  if (state.talkingSince !== null && state.listening) {
    const seconds = Math.max(
      0,
      Math.floor(((frame.now ?? state.talkingSince) - state.talkingSince) / 1000),
    )
    r.text(` ● TX ${clock(seconds)} `, skin.transmit, target)
    return
  }
  if (state.hearing) {
    r.text('◌ transcribing…', skin.hint, target)
    return
  }
  if (frame.muted) {
    r.text('✕ muted', skin.bad, { kind: 'action', name: 'mute' }).space(2)
  }
  if (!voice.available) {
    // Said, not left to be discovered by holding a key that does nothing.
    r.text('× voice off', skin.bad, target).space()
    r.button('Set up', target)
    return
  }
  r.keys(voice.keys).space()
  r.text('talk', skin.hint, target)
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ── Side: where, agents, changes, files, notes ───────────────────────────────

interface Section {
  id: string
  label: string
  count: number | null
  /** Rows when unfolded. At least one, so an open section never looks broken. */
  rows: (row: () => Row) => { text: string; hits: Hit[] }[]
  action?: { label: string; target: Target }
  /** Said quietly at the right of the heading: what the section is measured against. */
  note?: string
}

function renderSidebar(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const tasks = tasksOf(state)
  const changes = frame.changes ?? []
  const notes = frame.notes ?? []
  const files = frame.files ?? []
  const spend = frame.spend?.byTask ?? {}
  const where = frame.where ?? null

  const sections: Section[] = [
    {
      id: 'agents',
      label: 'AGENTS',
      count: tasks.length,
      action: { label: ' + ', target: { kind: 'action', name: 'new-agent' } },
      rows: (row) =>
        tasks.length === 0
          ? [row().space(3).text('none yet — + starts one', skin.hint).build()]
          : tasks.flatMap((task, i) => [
              taskRow(row(), task, spend[task.task], skin),
              ...(i < tasks.length - 1 ? [blank(width)] : []),
            ]),
    },
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
      action: { label: ' + ', target: { kind: 'action', name: 'add-note' } },
      rows: (row) =>
        notes.length === 0
          ? [row().space(3).text('tell Wilco "remember …"', skin.hint).build()]
          : notes.map((text) => row().space(3).text(text, skin.hint).build()),
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
  sections.forEach((section, i) => {
    if (i > 0 && previousOpen) out.push(blank(width))
    const open = !state.folded.includes(section.id)
    previousOpen = open
    const head = make()
      .space()
      .text(`${open ? '▾' : '▸'} ${section.label}`, skin.label, {
        kind: 'section',
        section: section.id,
      })
    if (section.count !== null && section.count > 0) head.space().badge(section.count)
    if (section.action) {
      const action = section.action
      head.right((r) => r.button(action.label, action.target, 'add').space())
    } else if (section.note) {
      const note = section.note
      head.right((r) => r.text(note, skin.hint).space())
    }
    out.push(head.build())
    if (open && section.id === 'agents') out.push(blank(width))
    if (open) out.push(...section.rows(make))
  })
  // Tailing is for screens that grow at the bottom; a sidebar is read from the
  // top, so it scrolls, and never past its last row.
  const scroll = Math.max(0, Math.min(state.scroll, out.length - height))
  const shown = stack(out.slice(scroll, scroll + height))
  const under = Array.from({ length: height }, (_, i) =>
    rowHit(i, width, { kind: 'scroll', area: 'sidebar' }),
  )
  return { rows: shown.rows, hits: [...under, ...shown.hits] }
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

/** A path in lines of a width, broken after a slash where it can be, and anywhere where it cannot. */
export function wrapPath(path: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const part of path.split(/(?<=\/)/)) {
    if (line !== '' && line.length + part.length > width) {
      lines.push(line)
      line = ''
    }
    line += part
    while (line.length > width) {
      lines.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
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
  const hovered = sameTarget(row.pointer.hover, target) || sameTarget(row.pointer.hover, menu)
  // Coloured the way git sees it, as an editor would: changed amber, new
  // green, conflicted red, and a folder by the most pressing thing inside.
  const mark = entry.folder ? folderMark(entry.path, marks) : (marks[entry.path] ?? null)
  const tone = markTone(mark, skin)
  row.space(3 + entry.depth * 2)
  if (entry.folder) row.text(`${entry.open ? '▾' : '▸'} ${entry.name}/`, tone ?? skin.busy)
  else row.text(`  ${entry.name}`, tone ?? (hovered ? skin.you : (t) => t))
  row.right((r) => {
    if (hovered) r.button('≡', menu).space()
    if (mark) r.text(entry.folder ? '•' : mark, tone ?? skin.hint).space()
    else if (!hovered) r.space(2)
  })
  const built = row.build()
  return {
    text: hovered ? skin.hovered(built.text) : built.text,
    hits: [rowHit(0, row.width, target), ...built.hits.filter((hit) => hit.target.kind === 'menu')],
  }
}

function markTone(mark: string | null, skin: Skin): ((text: string) => string) | null {
  if (mark === 'M' || mark === 'R') return skin.waiting
  if (mark === 'A' || mark === 'U') return skin.done
  if (mark === 'D' || mark === '!') return skin.bad
  return null
}

function taskRow(
  row: Row,
  task: AgentPane & { focused: boolean },
  spent: { tokens: number; usd: number } | undefined,
  skin: Skin,
): { text: string; hits: Hit[] } {
  const target: Target = { kind: 'task', task: task.task }
  const hover = row.pointer.hover
  const hovered = hover !== null && 'task' in hover && hover.task === task.task
  row.text(task.focused ? '▌' : ' ', skin.signal, target)
  row.text(glyph(task), toneOf(task, skin), target).space()
  row.text(shownName(task), task.focused ? skin.you : (t) => t, target)
  row.right((r) => {
    if (spent && (spent.usd > 0 || spent.tokens > 0)) {
      r.text(spent.usd > 0 ? dollars(spent.usd) : tokens(spent.tokens), skin.hint, target).space()
    }
    // The menu mark, and its click, only where it is drawn: on the task you
    // are on, or the one under the pointer. An invisible button is a trap.
    if (task.focused || hovered) {
      r.button('≡', { kind: 'task-menu', task: task.task }).space()
    } else {
      r.space(6)
    }
  })
  const built = row.build()
  // The whole row is the task; the menu mark sits on top of it.
  const hits = [rowHit(0, row.width, target), ...built.hits]
  return { text: task.focused ? skin.selected(built.text) : built.text, hits }
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
  const hovered = sameTarget(row.pointer.hover, target) || sameTarget(row.pointer.hover, menu)
  const room = row.width - 5 - (counts ? counts.length + 2 : 0) - (hovered ? 6 : 0)
  row
    .space(2)
    .text(change.mark, mark)
    .space()
    .text(shortPath(change.path, room), hovered ? skin.you : (t) => t)
  row.right((r) => {
    if (hovered) r.button('≡', menu).space()
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

/** The end of something too long, which for a branch is the part that names it. */
function tailOf(text: string, room: number): string {
  return text.length <= room ? text : `…${text.slice(-Math.max(1, room - 1))}`
}

/** `src/payments/webhooks.test.ts` → `…/webhooks.test.ts`: the name is the part you know. */
export function shortPath(path: string, room: number): string {
  if (path.length <= room) return path
  const name = path.split('/').at(-1) ?? path
  const short = `…/${name}`
  return short.length <= room ? short : `…${name.slice(-Math.max(1, room - 1))}`
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  if (pane.waiting || pane.state === 'blocked') return skin.waiting
  if (pane.state === 'failed') return skin.bad
  if (pane.state === 'review') return skin.done
  if (pane.state === 'working') return skin.busy
  return skin.hint
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
  if (!pane) return renderWelcome(state, frame, width, height, skin, pointer)

  const shown = laneShown(state, pane)
  const header = new Row(width, skin, pointer)
    .space()
    .text(`${pane.project} › ${shownName(pane)}`, skin.you)
    .space(2)
  // A tab per lane — the agent, and any shell beside it — and + for another.
  if (pane.lanes.length === 0) header.tab('agent', { kind: 'task', task: pane.task }, true)
  const labels = laneLabels(pane.lanes)
  labels.forEach(({ id, label }) => {
    const target: Target = { kind: 'lane', task: pane.task, lane: id }
    header.tab(label, target, id === shown)
    const kind = pane.lanes.find((lane) => lane.id === id)?.kind
    if (kind === 'agent') return
    // A shell's menu and close, on the tab you point at or are on; the room is
    // kept either way, so pointing never moves the tabs.
    const menu: Target = {
      kind: 'menu',
      subject: { kind: 'lane', task: pane.task, lane: id, name: label },
    }
    const close: Target = { kind: 'action', name: `close-lane:${id}` }
    const pointed = [target, menu, close].some((one) => sameTarget(state.hover, one))
    if (id === shown || pointed || state.splits[pane.task]?.lane === id) {
      header.button('▾', menu).button('×', close, 'danger')
    }
  })
  header.space().button('+', { kind: 'action', name: 'new-shell' }, 'add')
  const route = frame.route
  const vitals = frame.vitals
  if (route || vitals) {
    // What the agent says it runs on beats what the config hoped for.
    const model = vitals?.model ?? route?.model
    // Its harness and its model are controls: click either to change it for this agent.
    const harness: Target = { kind: 'action', name: `harness:${pane.task}` }
    const switcher: Target = { kind: 'action', name: `model:${pane.task}` }
    const percent = vitals?.contextPercent ?? null
    const controls = (withContext: boolean) => (r: Row) => {
      r.button(`${route?.harness ?? 'pi'} ▾`, harness).space()
      r.button(`${model ? shortModel(model) : 'its default model'} ▾`, switcher)
      if (withContext && percent !== null) {
        const tone = percent >= 85 ? skin.bad : percent >= 60 ? skin.waiting : skin.busy
        r.text(' ctx ', skin.hint)
          .meter(percent / 100, 6, tone)
          .text(` ${Math.round(percent)}%`, skin.hint)
      }
      r.space()
    }
    // Shed the context meter before the controls, where the header is short of room.
    const probe = new Row(width, skin)
    controls(true)(probe)
    header.right(controls(header.used + probe.used + 1 <= width))
  }

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
  ]
  const room = height - rows.length
  if (room <= 0) return stack(rows.slice(0, height))

  const split = shown ? splitShown(state, pane) : null
  if (!shown) {
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
          laneLines(frame.screen, kindOf(shown), w, h, skin, pointer, frame.linkers),
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
    for (let gap = room - 1 - lines.length; gap > 0; gap--) rows.push(blank(width))
    for (const line of lines) rows.push(linkedRow(line, width, skin, pointer, frame.linkers))
    rows.push(scrolledBar(state.paneScroll, 'pane-end', width, skin, pointer))
  } else {
    const kind = pane.lanes.find((lane) => lane.id === shown)?.kind
    // An approval card sits at the bottom; the conversation ends above it.
    const reading = kind === 'agent' && pane.approval ? Math.max(1, room - APPROVAL_ROWS - 1) : room
    rows.push(
      ...laneLines(frame.screen, kind ?? 'shell', width, reading, skin, pointer, frame.linkers),
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

  while (rows.length < height) rows.push(blank(width))
  const drawn = stack(rows.slice(0, height))
  if (pane.approval) return withApproval(drawn, pane.approval, width, height, skin, pointer)
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
): { text: string; hits: Hit[] }[] {
  const lines = screen.split('\n')
  const out: { text: string; hits: Hit[] }[] = []
  if (kind === 'agent') {
    while (lines.length > 0 && stripTerminalSequences(lines.at(-1) ?? '').trim() === '') lines.pop()
    for (let gap = rows - lines.length; gap > 0; gap--) out.push(blank(width))
  }
  for (const line of lines.slice(-rows)) out.push(linkedRow(line, width, skin, pointer, linkers))
  while (out.length < rows) out.push(blank(width))
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

/**
 * Two halves of one place, beside each other or one below the other, with a
 * divider you can drag and a bar on the second half: what it is, and buttons
 * to swap the halves, turn the split, and close it.
 */
export function splitView(opts: {
  width: number
  height: number
  split: { direction: 'beside' | 'below'; ratio: number }
  edge: 'split' | 'terminal-split'
  lit: boolean
  /** The keyboard is on the second half. */
  focus: boolean
  label: string
  /** The actions' prefix: `split:<task>` or `terminal-split`. */
  actions: string
  skin: Skin
  pointer: Pointer
  first: (width: number, height: number) => Drawn
  second: (width: number, height: number) => Drawn
}): Drawn {
  const { width, height, split, skin, pointer } = opts
  const divider: Target = { kind: 'divider', edge: opts.edge }
  const bar = (w: number): { text: string; hits: Hit[] } =>
    new Row(w, skin, pointer)
      .text(opts.split.direction === 'below' ? '── ' : ' ', skin.chrome)
      .text(opts.label, opts.focus ? skin.you : skin.hint)
      .text(opts.focus ? '  typing here' : '', skin.signal)
      .right((r) =>
        r
          .button('⇄', { kind: 'action', name: `${opts.actions}:swap` })
          .space()
          .button(split.direction === 'beside' ? '⇅' : '⇆', {
            kind: 'action',
            name: `${opts.actions}:turn`,
          })
          .space()
          .button('×', { kind: 'action', name: `${opts.actions}:close` })
          .space(),
      )
      .build()
  const rows: string[] = []
  const hits: Hit[] = []
  if (split.direction === 'beside' && width >= 24) {
    const firstWidth = Math.max(10, Math.min(width - 11, Math.round((width - 1) * split.ratio)))
    const secondWidth = width - 1 - firstWidth
    const first = opts.first(firstWidth, height)
    const top = bar(secondWidth)
    const second = opts.second(secondWidth, Math.max(0, height - 1))
    for (let i = 0; i < height; i++) {
      const right = i === 0 ? top.text : (second.rows[i - 1] ?? ' '.repeat(secondWidth))
      rows.push(
        `${fit(first.rows[i] ?? '', firstWidth)}${opts.lit ? skin.signal('┃') : skin.chrome('│')}${fit(right, secondWidth)}`,
      )
      hits.push({ row: i, from: firstWidth, to: firstWidth, target: divider })
    }
    hits.push(...first.hits.filter((hit) => hit.row < height))
    hits.push(...shift(top.hits, 0, firstWidth + 1))
    hits.push(...shift(second.hits, 1, firstWidth + 1).filter((hit) => hit.row < height))
    return { rows, hits }
  }
  const firstHeight = Math.max(1, Math.min(height - 2, Math.round((height - 1) * split.ratio)))
  const secondHeight = Math.max(0, height - 1 - firstHeight)
  const first = opts.first(width, firstHeight)
  const second = opts.second(width, secondHeight)
  rows.push(...first.rows.slice(0, firstHeight))
  hits.push(...first.hits.filter((hit) => hit.row < firstHeight))
  const middle = bar(width)
  // The bar is the divider: take hold of it anywhere but its buttons.
  hits.push(rowHit(firstHeight, width, divider))
  hits.push(...shift(middle.hits, firstHeight))
  rows.push(opts.lit ? skin.signal(stripTerminalSequences(middle.text)) : middle.text)
  rows.push(...second.rows.slice(0, secondHeight))
  hits.push(...shift(second.hits, firstHeight + 1).filter((hit) => hit.row < height))
  while (rows.length < height) rows.push(' '.repeat(width))
  return { rows, hits }
}

/** How tall the approval card is: its border and two rows. */
const APPROVAL_ROWS = 4

/** A waiting approval, where the agent asked for it, answerable by click. */
function withApproval(
  pane: Drawn,
  approval: { tool: string; summary: string },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const cardWidth = Math.min(width - 4, 64)
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
    { row: Math.max(2, height - card.rows.length - 1), col: 2 },
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

// ── Bottom: the orchestrator, the buttons, and what it costs ─────────────────

function renderStrip(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  let bar: string
  let barHits: Hit[] = []
  const talking = state.listening && state.talkingSince !== null
  const terminal = talking ? null : state.terminals.find((one) => one.id === state.bottom)
  if (talking) {
    const seconds = Math.max(0, Math.floor(((frame.now ?? 0) - (state.talkingSince ?? 0)) / 1000))
    const left = new Row(width, skin)
      .text('━ ', skin.chrome)
      .text(' ● TX ', skin.transmit)
      .space()
      .text('listening', skin.you)
      .space()
      .text(clock(seconds), skin.hint)
      .space()
    const tail = ' release to send · esc cancels ━'
    left.text('━'.repeat(Math.max(0, width - left.used - tail.length)), skin.chrome)
    left.text(tail, skin.chrome)
    bar = left.build().text
  } else {
    const tabs = bottomTabs(state, width, skin, pointer)
    bar = tabs.text
    barHits = tabs.hits
  }

  const rows = [fit(bar, width)]
  const hits: Hit[] = talking ? [rowHit(0, width, { kind: 'orchestrator' })] : barHits
  if (height <= 1) return { rows: rows.slice(0, height), hits }
  // A row of room under the tabs, so what is below them is not pressed against them.
  rows.push(' '.repeat(width))
  const room = height - 2
  if (room <= 0) return { rows: rows.slice(0, height), hits }

  if (terminal) {
    const split = terminalSplitShown(state)
    const drawn = split
      ? splitView({
          width,
          height: room,
          split,
          edge: 'terminal-split',
          lit:
            state.resizing === 'terminal-split' ||
            sameTarget(state.hover, { kind: 'divider', edge: 'terminal-split' }),
          focus: state.splitFocus,
          label: state.terminals.find((one) => one.id === split.lane)?.name ?? 'terminal',
          actions: 'terminal-split',
          skin,
          pointer,
          first: (w, h) => terminalBody(frame.terminal, w, h, skin, state.terminalScroll, pointer),
          second: (w, h) => terminalBody(frame.splitTerminal, w, h, skin, 0, pointer, 'split'),
        })
      : terminalBody(frame.terminal, width, room, skin, state.terminalScroll, pointer)
    return { rows: [...rows, ...drawn.rows], hits: [...hits, ...shift(drawn.hits, 2)] }
  }

  if (frame.orchestrator !== undefined && !isAction(state.dictation)) {
    for (const line of frame.orchestrator.split('\n').slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    while (rows.length < height) rows.push(' '.repeat(width))
    return { rows: rows.slice(0, height), hits }
  }

  if (talking) {
    // What the microphone hears, as it hears it — only where the recorder can
    // tell. A meter that moves on its own would be a lie about the one thing
    // you need to trust while talking.
    const meter = state.levels.length > 0 ? levelMeter(state.levels, Math.min(width - 6, 48)) : null
    const lines = [
      ' '.repeat(width),
      meter ? `   ${skin.busy(meter.heard)}${skin.chrome(meter.rest)}` : ' '.repeat(width),
      ' '.repeat(width),
      `${skin.transmit(' ◉ ')} ${skin.hint('speak — Wilco hears you until you let go')}`,
    ]
    for (let gap = room - lines.length; gap > 0; gap--) rows.push(' '.repeat(width))
    for (const line of lines.slice(-room)) {
      hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
      rows.push(fit(line, width))
    }
    return { rows: rows.slice(0, height), hits }
  }

  const body: Line[] = transcriptLines(
    state.transcript,
    width,
    skin,
    pointer,
    frame.now ?? 0,
    frame.linkers,
  )
  const quiet = (text: string): Line => ({ text: fit(text, width), hits: [] })
  if (state.question) {
    body.push(quiet(skin.waiting(` ? ${state.question.question}`)))
    body.push(quiet(skin.hint(`   ${state.question.candidates.join('  ·  ')}`)))
  }

  // Choosing a command: the commands that fit, best first, in place of the conversation.
  const commands: Line[] = []
  if (isAction(state.dictation)) {
    const found = matchActions(state, state.dictation ?? '')
    for (const action of found) {
      const line = ` ${action.name.padEnd(10)} ${action.about}`
      commands.push(quiet(action.ready ? line : skin.hint(line)))
    }
    if (found.length === 0) commands.push(quiet(skin.hint('  no command like that')))
  }

  // The line you type on, boxed as pi boxes its own — a rule above and below
  // — and always there, so opening it moves nothing. Text that wraps grows
  // the box upward into the conversation, never off the edge.
  // Its bottom rule is the footer's, just below.
  const inputHeight = Math.min(Math.max(2, room - 1), inputRows(state, frame).length + 1)
  const bodyRoom = Math.max(0, room - inputHeight)
  // Scrolled back through the conversation, the newest lines wait below; the
  // box's top rule says so, and takes you back to them.
  const scroll = isAction(state.dictation)
    ? 0
    : Math.min(state.transcriptScroll, Math.max(0, body.length - bodyRoom))

  const end = body.length - scroll
  const shown = isAction(state.dictation)
    ? commands.slice(0, bodyRoom)
    : body.slice(Math.max(0, end - bodyRoom), end)
  for (let gap = bodyRoom - shown.length; gap > 0; gap--) {
    hits.push(rowHit(rows.length, width, { kind: 'scroll', area: 'transcript' }))
    hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
    rows.push(' '.repeat(width))
  }
  for (const line of shown) {
    // Under everything, the wheel; over that, the strip; over that, links.
    hits.push(rowHit(rows.length, width, { kind: 'scroll', area: 'transcript' }))
    hits.push(rowHit(rows.length, width, { kind: 'orchestrator' }))
    hits.push(...shift(line.hits, rows.length))
    rows.push(line.text)
  }
  const box = inputBox(state, frame, width, inputHeight, skin, pointer, voice.keys, scroll)
  for (let i = 0; i < box.rows.length; i++) {
    hits.push(rowHit(rows.length + i, width, { kind: 'orchestrator' }))
  }
  hits.push(...shift(box.hits, rows.length))
  rows.push(...box.rows)
  return { rows: rows.slice(0, height), hits }
}

/** What the input box holds, one row each: the editor's lines while typing, or one line saying what it is. */
function inputRows(state: AppState, frame: Frame): string[] {
  const typing = state.dictation !== null && !state.historySearch && frame.input
  // The editor draws its own rules; the box draws them here, with what they carry.
  return typing ? (frame.input?.lines ?? []).slice(1, -1) : ['']
}

function inputBox(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
  talkKeys: readonly string[],
  newer: number,
): Drawn {
  const open = state.dictation !== null
  const rule = open ? skin.signal : skin.chrome
  const hits: Hit[] = []

  // The top rule: pictures going with the message on the left, and the way
  // back to the newest line on the right.
  const top = new Row(width, skin, pointer)
  // Open to hear you, where there is no microphone to hold: said on the rule.
  if (state.listening) top.text('─ ', rule).text('◉ listening', skin.bad).text(' ', rule)
  // A picture on the clipboard, offered: Cmd+V pastes only text, so it is attached here.
  if (open && frame.clipboardImage && state.attached.length === 0) {
    top
      .text('─ ', rule)
      .button('▣ Attach the screenshot on the clipboard', {
        kind: 'action',
        name: 'attach-clipboard',
      })
      .text(' ctrl+v ', skin.hint)
      .button('×', { kind: 'action', name: 'dismiss-clipboard' })
      .text(' ', rule)
  }
  if (state.attached.length > 0) {
    top.text('─ ', rule)
    for (const path of state.attached) {
      top.text(`▣ ${path.split('/').at(-1) ?? path}`, skin.busy).text(' ─ ', rule)
    }
  }
  const controls = (r: Row) => {
    if (newer > 0) {
      r.button(`↓ ${newer} newer`, { kind: 'action', name: 'transcript-end' }).text('─', rule)
    } else if (open && !state.historySearch) {
      r.text(' enter sends · shift+enter new line · ↑ ctrl+r history ', skin.hint).text('─', rule)
    }
  }
  const probe = new Row(width, skin)
  controls(probe)
  // One short of meeting them: a right-hand group needs a column of room to sit in.
  top.text('─'.repeat(Math.max(0, width - top.used - probe.used - 1)), rule)
  top.right(controls)

  const content: string[] = []
  const typed = inputRows(state, frame)
  if (open && !state.historySearch && frame.input) {
    content.push(...typed.slice(-(height - 1)).map((line) => fit(line, width)))
  } else {
    const line = new Row(width, skin, pointer).space()
    if (state.historySearch) {
      // As a shell shows it: what you are looking for, then what it found.
      const { query, missing } = state.historySearch
      line.text(`search: ${query}▏`, missing ? skin.waiting : skin.signal).space(2)
      line.text(missing ? 'nothing said like that' : (state.dictation ?? ''), skin.hint)
      line.right((r) => r.text('ctrl+r older · enter sends · → keeps · esc', skin.hint).space())
    } else if (state.listening) {
      line.text('◉ ', skin.bad).text(state.dictation ?? '', skin.you)
    } else if (open) {
      line.text(`${state.dictation}▏`, skin.you)
    } else if (state.held) {
      line.text(`◌ ${state.held}▏`, skin.hint)
    } else {
      line.text('Ask Wilco anything', skin.hint)
      line.right((r) => r.text('type, or hold ', skin.hint).keys(talkKeys).space())
    }
    const built = line.build()
    hits.push(...shift(built.hits, content.length + 1))
    content.push(built.text)
  }
  while (content.length < height - 1) content.push(' '.repeat(width))

  const builtTop = top.build()
  return { rows: [builtTop.text, ...content], hits: [...builtTop.hits, ...hits] }
}

/**
 * The bottom panel's row of tabs, drawn on its top edge: the orchestrator,
 * each terminal of the project you are in, `+` for another, and on the right
 * find, fill the window and fold away. The rule around them is the handle
 * that resizes the panel.
 */
function bottomTabs(
  state: AppState,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  const edge: Target = { kind: 'divider', edge: 'bottom' }
  const lit = state.resizing === 'bottom' || sameTarget(state.hover, edge)
  const rule = lit ? skin.signal : skin.chrome
  const line = '━'
  const row = new Row(width, skin, pointer).text(`${line} `, rule)
  const orchestrator: Target = { kind: 'bottom-tab', tab: ORCHESTRATOR_TAB }
  row.tab('orchestrator', orchestrator, state.bottom === ORCHESTRATOR_TAB)
  for (const terminal of terminalsOf(state)) {
    const on = terminal.id === state.bottom
    const target: Target = { kind: 'bottom-tab', tab: terminal.id }
    const menu: Target = { kind: 'menu', subject: { kind: 'terminal', id: terminal.id } }
    const close: Target = { kind: 'action', name: `close-terminal:${terminal.id}` }
    row.space().tab(terminal.name, target, on)
    // Its menu and its close button, on the tab you point at or are on. The
    // room for them is kept either way, so pointing never moves the tabs.
    const pointed = [target, menu, close].some((one) => sameTarget(state.hover, one))
    row.space()
    if (on || pointed) {
      row.button('▾', menu).button('×', close, 'danger')
    } else {
      row.space(10)
    }
  }
  row.space().button('+', { kind: 'action', name: 'new-terminal' }, 'add').space()

  const controls = (r: Row) => {
    if (state.terminals.some((one) => one.id === state.bottom)) {
      r.button('⌕', { kind: 'action', name: 'find-terminal' }).space()
    }
    r.button(state.bottomMode === 'max' ? '⤡' : '⤢', { kind: 'action', name: 'bottom-max' }).space()
    r.button(state.bottomMode === 'min' ? '▴' : '▾', { kind: 'action', name: 'bottom-min' })
    r.text(` ${line}`, rule)
  }
  const probe = new Row(width, skin)
  controls(probe)
  // One short of meeting them: a right-hand group needs a column of room to sit in.
  const fill = width - row.used - probe.used - 1
  if (fill > 0) row.text(line.repeat(fill), rule)
  row.right(controls)
  const built = row.build()
  // Under everything: the rule itself, which is what a drag takes hold of.
  return { text: built.text, hits: [rowHit(0, width, edge), ...built.hits] }
}

/**
 * A terminal's screen, tailing like an agent's. While finding in it, its
 * scrollback instead, with the line found in view and what matched lit.
 */
function terminalBody(
  terminal: Frame['terminal'],
  width: number,
  room: number,
  skin: Skin,
  scroll = 0,
  pointer: Pointer = { hover: null, pressed: null },
  side?: 'split',
): Drawn {
  const rows: string[] = []
  const hits: Hit[] = []
  const find = terminal?.find
  if (find) {
    const at = find.line ?? find.lines.length - 1
    const start = Math.max(0, Math.min(at - Math.floor(room / 2), find.lines.length - room))
    const want = find.query.toLowerCase()
    find.lines.slice(start, start + room).forEach((line, offset) => {
      const here = start + offset === find.line
      const cut = fit(line, width)
      const plain = stripTerminalSequences(cut)
      const found = want ? plain.toLowerCase().indexOf(want) : -1
      const text =
        found >= 0
          ? plain.slice(0, found) +
            (here ? skin.transmit : skin.waiting)(plain.slice(found, found + want.length)) +
            plain.slice(found + want.length)
          : plain
      rows.push(here ? skin.selected(text) : text)
    })
  } else if (scroll > 0) {
    const lines = (terminal?.screen ?? '').split('\n').slice(-(room - 1))
    for (const line of lines) rows.push(fit(line, width))
    while (rows.length < room - 1) rows.push(' '.repeat(width))
    const bar = scrolledBar(scroll, 'terminal-end', width, skin, pointer)
    hits.push(...shift(bar.hits, rows.length))
    rows.push(bar.text)
  } else {
    const lines = (terminal?.screen ?? '').split('\n')
    for (const line of lines.slice(-room)) rows.push(fit(line, width))
  }
  while (rows.length < room) rows.push(' '.repeat(width))
  const own = hits.splice(0)
  for (let i = 0; i < rows.length; i++) {
    if (!side) hits.push(rowHit(i, width, { kind: 'scroll', area: 'terminal' }))
    hits.push(rowHit(i, width, side ? { kind: 'terminal', side } : { kind: 'terminal' }))
  }
  hits.push(...own)
  return { rows, hits }
}

/** The last row of a screen scrolled back: how far, and the way to the newest line. */
function scrolledBar(
  lines: number,
  action: string,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  return new Row(width, skin, pointer)
    .text(`── ↑ ${lines} line${lines === 1 ? '' : 's'} back `, skin.chrome)
    .right((r) => r.button('↓ newest', { kind: 'action', name: action }).space())
    .build()
}

function renderFoot(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const row = new Row(width, skin, pointer).space()
  for (const button of BUTTONS) {
    // Amber means something here wants you: an extension to set up, or sound
    // that is off. Otherwise a button is grey, whatever it does.
    const muted = button.action === 'mute' && frame.muted === true
    const needed = button.action === 'extensions' && (frame.extensionsNeedYou ?? 0) > 0
    row
      .button(
        muted ? 'Unmute' : button.label,
        { kind: 'action', name: button.action },
        muted || needed ? 'attention' : 'rest',
      )
      .space()
  }
  const spend = frame.spend
  const target: Target = { kind: 'action', name: 'spend' }
  // The orchestrator's model, and the account paying for it: an agent's own
  // model is on its pane, so this is only ever the one you talk to.
  const switcher: Target = { kind: 'action', name: 'model:orchestrator' }
  const thinker = frame.orchestratorModel
  const account = frame.orchestratorAccount
  const spent = spend && spend.tokens > 0
  // Said in full where there is room, and shed from the left where there is
  // not: what it costs is the part worth keeping on a small terminal.
  const full = { model: true, account: true, tokens: true }
  const tries = [
    full,
    { model: true, account: false, tokens: true },
    { model: true, account: false, tokens: false },
    { model: false, account: false, tokens: false },
  ]
  const status = (show: (typeof tries)[number]) => (r: Row) => {
    // What extensions keep here — what Wilco is using — clicked for their view.
    if (show.model) {
      for (const one of frame.statuses ?? []) {
        const view: Target = { kind: 'action', name: `extension-view:${one.extension}` }
        const tone =
          one.tone === 'bad' ? skin.bad : one.tone === 'warning' ? skin.waiting : skin.hint
        r.text(
          one.text,
          sameTarget(state.hover, view) ? skin.link : tone,
          one.viewable ? view : undefined,
        )
        r.text(' │ ', skin.chrome)
      }
    }
    if (show.model && thinker !== undefined) {
      const look = sameTarget(state.hover, switcher) ? skin.link : skin.hint
      r.text(`${thinker ? shortModel(thinker) : 'no model'} ▾`, look, switcher)
      if (show.account && account?.provider) r.text(` · ${account.provider}`, look, switcher)
      if (show.account && account?.credential) r.text(` · ${account.credential}`, look, switcher)
      r.text(' │ ', skin.chrome)
    }
    if (spent && show.tokens) {
      r.text(tokens(spend.tokens), skin.hint, target).text(' │ ', skin.chrome, target)
    }
    if (spent && spend.hasCost) r.text(dollars(spend.usd), skin.you, target).space()
    r.text(spent ? 'today ▾' : 'nothing spent today ▾', skin.hint, target).space()
  }
  const fits = tries.find((show) => {
    const probe = new Row(width, skin)
    status(show)(probe)
    return row.used + 1 + probe.used <= width
  })
  row.right(status(fits ?? tries[tries.length - 1] ?? full))
  return stack([{ text: skin.chrome('─'.repeat(width)), hits: [] }, row.build()])
}

/**
 * Recent loudness as a row of bars, newest on the right, padded on the left
 * with the floor so the meter keeps its width from the first moment.
 */
export function levelMeter(
  levels: readonly number[],
  cells: number,
): { heard: string; rest: string } {
  const bars = '▁▂▃▄▅▆▇█'
  const recent = levels.slice(-cells)
  const heard = recent
    .map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))])
    .join('')
  return { heard, rest: '▁'.repeat(Math.max(0, cells - recent.length)) }
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

// ── Numbers, the way people read them ────────────────────────────────────────

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k tok`
  return `${count} tok`
}

export function dollars(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

/** `anthropic/claude-opus-5` reads as `claude-opus-5`: the provider is said separately. */
function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}
