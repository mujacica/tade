import { visibleWidth } from '@earendil-works/pi-tui'
import type { Frame } from './frame.ts'
import { type Hit, rowHit, sameTarget, shift, type Target } from './hits.ts'
import { resolveLayout } from './layout.ts'
import { type AppState, conversing } from './model.ts'
import { drawPanel } from './panels/context.ts'
import { PLAIN } from './skin.ts'
import { type Drawn, fit, overlay, type Pointer } from './ui.ts'
import { renderFoot } from './view/foot.ts'
import { renderMain } from './view/main.ts'
import { renderSidebar } from './view/sidebar.ts'
import { renderStrip } from './view/strip.ts'
import { clockOf } from './view/text.ts'
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
