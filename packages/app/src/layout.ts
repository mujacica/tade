// How the window is divided, and where you were when you closed it.
//
// Sizes come from the config rather than from keys, because every key the
// window claims is a key the focused agent never receives — `[` and `]` would
// be a nice way to resize a sidebar and a terrible way to lose a bracket.
//
// What is remembered across a restart is which agent you were watching. Coming
// back to the pane you left is the part people notice; coming back to a
// sidebar that is two columns wider is not.
//
// Pure: preferences and a terminal size in, concrete rows and columns out.

import type { QueueScope, QueueView } from './queue-view.ts'

export interface LayoutPrefs {
  /** Columns for the projects list. */
  sidebarWidth?: number
  /** Rows for the bottom panel — orchestrator and terminals — including its tabs. */
  stripHeight?: number
  /**
   * The conversation with the orchestrator is going on: the bottom panel is at
   * least tall enough to read it, however small it was dragged, and goes back
   * to its size when it is over.
   */
  grow?: boolean
  /** Filling the window above the buttons, or folded to its row of tabs. */
  bottom?: 'open' | 'max' | 'min'
}

export interface Layout {
  sidebarWidth: number
  stripHeight: number
  /** What is left for the agent's own screen. */
  mainWidth: number
  bodyHeight: number
}

export const DEFAULTS = { sidebarWidth: 26, stripHeight: 9 }

/** How many rows a conversation going on gets, at least, where the window has them. */
export const CONVERSATION_ROWS = 16

/**
 * Rows the window spends on itself: the project tabs and the rule under them,
 * and the rule and buttons at the foot. Counted here rather than in the
 * drawing, because a frame that does not add up to the terminal's height
 * corrupts the whole screen.
 */
export const CHROME = 4

/** Below these the region stops being readable and starts being decoration. */
export const MINIMUM = { sidebar: 12, strip: 4, main: 20, body: 1 }

/** A dragged sidebar stops here: past it the pane is what gets squeezed. */
export const SIDEBAR_MOST = 80

/**
 * Fit the preferences to the terminal actually in front of you.
 *
 * A preference is a wish, not an instruction: a 40-column sidebar in an
 * 80-column terminal leaves no room for the thing you are trying to watch, so
 * every dimension is clamped against what is left rather than honoured blindly.
 */
export function resolveLayout(
  prefs: LayoutPrefs,
  frame: { width: number; height: number },
): Layout {
  const width = Math.max(MINIMUM.sidebar + MINIMUM.main + 1, frame.width)
  const height = Math.max(MINIMUM.strip + MINIMUM.body + CHROME, frame.height)

  // Unasked, the bottom panel takes no more than a third: it is context, not the
  // view. Dragged or maximised, it takes what you gave it, leaving the agent
  // its title and a few rows; folded, it is only its tabs.
  const most = Math.max(MINIMUM.strip, height - CHROME - 4)
  const stripHeight =
    prefs.bottom === 'min'
      ? 1
      : prefs.bottom === 'max'
        ? most
        : prefs.stripHeight !== undefined
          ? clamp(prefs.stripHeight, MINIMUM.strip, most)
          : clamp(
              DEFAULTS.stripHeight,
              MINIMUM.strip,
              Math.max(MINIMUM.strip, Math.floor(height / 3)),
            )
  const room =
    prefs.grow && prefs.bottom !== 'min'
      ? Math.min(CONVERSATION_ROWS, Math.floor(height * 0.45))
      : 0
  const bodyHeight = height - Math.max(stripHeight, room) - CHROME

  // Unasked, the sidebar is a share of the window rather than a fixed 24: on a
  // wide terminal that is a thin ribbon beside an ocean, and task names are the
  // one thing in it that must stay readable.
  const wanted = prefs.sidebarWidth ?? clamp(Math.round(width / 4), DEFAULTS.sidebarWidth, 36)
  const widest = Math.min(SIDEBAR_MOST, width - MINIMUM.main - 1)
  const sidebarWidth = clamp(wanted, MINIMUM.sidebar, Math.max(MINIMUM.sidebar, widest))
  return {
    sidebarWidth,
    stripHeight: Math.max(stripHeight, room),
    mainWidth: width - sidebarWidth - 1,
    bodyHeight,
  }
}

/**
 * Where you were standing in a project: the agent whose pane was in front of
 * you, and the tab in the panel below it.
 *
 * A project is a place you come back to, and coming back to it should put you
 * where you left it — which is one question with one answer whether you came
 * back by clicking its tab a second later or by opening Tade again tomorrow.
 * So it is one shape, read by both, rather than the window keeping its own
 * idea of where you were beside the file's. What differs between the two is
 * only how much of it survives, and that is `worthKeeping`'s to say.
 */
export interface Spot {
  /** The task whose pane was in front, or `null` where no agent was. */
  focused: string | null
  /**
   * The tab in front below: a terminal of that project, or the orchestrator's.
   * Only ever for as long as the window is open — see `worthKeeping`.
   */
  bottom?: string
}

/**
 * Where you were in every project, counting the one you are standing in now.
 *
 * The spot for the project you are in is not kept anywhere — it is the focus
 * and the tab themselves — so this is what folds it in, and what everything
 * that wants the whole answer reads. The rule is here once and read wherever
 * a project is left: its tab (`selectProject`), tabbing past its last agent
 * (`focusBy`), the beat every state passes through (`withTasks`), which is
 * what catches a jump out of a project that went through neither door, and
 * the write on the way out of the window, since closing Tade in a project is
 * leaving it too.
 */
export function whereYouWere(state: {
  project: string | null
  focused: string | null
  bottom: string
  spots: Readonly<Record<string, Spot>>
}): Record<string, Spot> {
  if (!state.project) return { ...state.spots }
  return {
    ...state.spots,
    [state.project]: { focused: state.focused, bottom: state.bottom },
  }
}

/**
 * Where to stand on arriving in a project: the spot you left it on, as far as
 * it is still there.
 *
 * The other door, and the one that has to be careful, because everything a
 * spot names can have gone since. Everything falls back the way the window
 * fell back before any of this, which is what keeps a remembered place from
 * ever being worse than no memory at all: an agent that has finished and been
 * closed, was stopped, or went with its task is not somewhere to stand, and
 * neither is a plan or a schedule you had open, since those stay behind in
 * the project they are of — all of them come back to the first agent, exactly
 * as a project you have never been in opens on it. Only a project with no
 * agents at all comes back to the orchestrator, because there is nothing else
 * there. So there is no arriving at an empty pane, and none of it depends on
 * the spot being right.
 *
 * Given everything there is rather than what is in that project, because what
 * counts as being in it is the same question both halves answer and is worth
 * answering once. `bottom: null` is the orchestrator's tab, left for the
 * caller to name: which tab that is, is the model's word and not this file's.
 */
export function standingIn(
  spot: Spot | undefined,
  project: string,
  here: {
    panes: readonly { task: string; project: string }[]
    terminals: readonly { id: string; project: string }[]
  },
): { focused: string | null; bottom: string | null } {
  const agents = here.panes.filter((pane) => pane.project === project)
  const focused =
    agents.find((pane) => pane.task === spot?.focused)?.task ?? agents[0]?.task ?? null
  const kept = here.terminals.some((one) => one.id === spot?.bottom && one.project === project)
  return { focused, bottom: kept ? (spot?.bottom ?? null) : null }
}

/**
 * The spots as they are worth writing down: where you were, and not which tab.
 *
 * A terminal is a lane of the window's own, and under a driver whose lanes
 * cannot outlive it — `detach: false`, which `pty` is and which is the default
 * — closing Tade ends every one of them. So a tab written down is a tab that
 * can never be found again, and a file that kept one would be promising
 * something Tade cannot do, which is worse than not offering it. Which tab you
 * were on is remembered for as long as the window is open, which is exactly as
 * long as the terminal it names is there to go back to.
 */
export function worthKeeping(spots: Readonly<Record<string, Spot>>): Record<string, Spot> {
  return Object.fromEntries(
    Object.entries(spots).map(([project, spot]) => [project, { focused: spot.focused }]),
  )
}

/**
 * What is worth writing down when the window closes: which pane you were on,
 * the sizes you dragged the dividers to, the order you dragged agents into,
 * and the view choices you made in the sidebar's headings. The config says
 * what a window starts at; a divider you moved is you saying otherwise, and
 * losing that on every restart would be asking you to say it again.
 *
 * Every one of these is a view, never a decision about the work: hiding a
 * finished agent does not close it, and folding a section does not empty it.
 * That is why they live here rather than in the config — nothing reads them
 * but the window that drew them, and they are one person's, on one machine.
 */
export interface RememberedWindow {
  /** The task whose pane had focus. */
  focused: string | null
  sidebarWidth?: number
  stripHeight?: number
  /** `H` beside AGENTS was on: the finished agents are kept out of the list. */
  hidingDone?: boolean
  /** The sidebar sections you folded shut, by id. */
  folded?: string[]
  /** The ones you opened that fold themselves away — the SMART QUEUE with nothing in it. */
  opened?: string[]
  /** By project, the agents in the order they were dragged into. */
  order?: Record<string, string[]>
  /**
   * The project tabs in the order they were moved into. Written down beside
   * the agents' order and for the same reason: where a tab sits is a view, and
   * a project closed and opened again would otherwise come back at the end of
   * a row somebody had arranged.
   */
  projectOrder?: string[]
  /**
   * By project, what the SMART QUEUE was showing — only where that is not the
   * whole of it, exactly as a dragged size is only written when it was dragged.
   */
  queueViews?: Record<string, QueueView>
  /** By project, where you were standing in it — the pane, never the tab (`worthKeeping`). */
  spots?: Record<string, Spot>
}

/**
 * Read back what was remembered. Hand-checked rather than schema-parsed, and
 * null on anything unfamiliar: a layout file is a convenience, and refusing to
 * open the window because of one would be absurd.
 */
export function asRemembered(value: unknown): RememberedWindow | null {
  // `typeof [] === 'object'`, and an array is not a remembered window.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const size = (key: string) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) > 0
      ? { [key]: Math.round(raw[key] as number) }
      : {}
  const order: Record<string, string[]> = {}
  if (typeof raw.order === 'object' && raw.order !== null && !Array.isArray(raw.order)) {
    for (const [project, tasks] of Object.entries(raw.order)) {
      if (Array.isArray(tasks)) order[project] = tasks.filter((task) => typeof task === 'string')
    }
  }
  // Absent and empty are different answers: nothing written means the window
  // starts folded where it always did, and an empty list means you opened
  // every one of them and that is how you want it back.
  const names = (key: string) =>
    Array.isArray(raw[key])
      ? (raw[key] as unknown[]).filter((name): name is string => typeof name === 'string')
      : null
  const folded = names('folded')
  const opened = names('opened')
  const projectOrder = names('projectOrder')
  // A spot is only as good as what is still in it, and `standingIn` is what
  // checks that — so what is asked of the file is only that it has the shape.
  const spots: Record<string, Spot> = {}
  if (typeof raw.spots === 'object' && raw.spots !== null && !Array.isArray(raw.spots)) {
    for (const [project, value] of Object.entries(raw.spots)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const spot = value as Record<string, unknown>
      spots[project] = { focused: typeof spot.focused === 'string' ? spot.focused : null }
    }
  }
  // The one place a *word* of the queue's is checked here rather than its
  // shape: a scope nobody offers is not a view, and reading it back as one
  // would leave a project showing something no control could undo. The words
  // are `QUEUE_SCOPES`', and `layout.test.ts` holds this list to that one, so
  // a scope added there and not here fails at the commit.
  //
  // A file written before the schedules got a section of their own has a
  // `timed` beside its scope. It is ignored rather than refused: a key with no
  // control behind it is not a view, and throwing the row away would lose the
  // scope that was written with it.
  const queueViews: Record<string, QueueView> = {}
  if (
    typeof raw.queueViews === 'object' &&
    raw.queueViews !== null &&
    !Array.isArray(raw.queueViews)
  ) {
    for (const [project, value] of Object.entries(raw.queueViews)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const view = value as { scope?: unknown }
      const scope: QueueScope | null =
        view.scope === 'all' ? 'all' : view.scope === 'next' ? 'next' : null
      if (scope === null) continue
      queueViews[project] = { scope }
    }
  }
  return {
    focused: typeof raw.focused === 'string' ? raw.focused : null,
    ...size('sidebarWidth'),
    ...size('stripHeight'),
    ...(typeof raw.hidingDone === 'boolean' ? { hidingDone: raw.hidingDone } : {}),
    ...(folded ? { folded } : {}),
    ...(opened ? { opened } : {}),
    ...(Object.keys(order).length > 0 ? { order } : {}),
    // A project in here that has since been closed is dropped where the order
    // is read (`projects`), not here: it may be opened again this afternoon,
    // and a place thrown away on the way in is one nobody can get back.
    ...(projectOrder && projectOrder.length > 0 ? { projectOrder } : {}),
    ...(Object.keys(spots).length > 0 ? { spots } : {}),
    ...(Object.keys(queueViews).length > 0 ? { queueViews } : {}),
  }
}

/**
 * The sizes of the two halves of a split, as `splitView` lays them out — the
 * divider, and the second half's bar, taking their row or column.
 *
 * Here rather than beside the lane that asks for it: it is geometry, it is a
 * pure function of a size and a ratio, and a second reading of it anywhere
 * would drift — a screen cut to the wrong number of rows is a screen that
 * jumps when the look catches up with the wheel.
 */
export function halvesOf(
  whole: { cols: number; rows: number },
  split: { direction: 'beside' | 'below'; ratio: number } | null,
): { first: { cols: number; rows: number }; second: { cols: number; rows: number } } {
  if (!split) return { first: whole, second: whole }
  if (split.direction === 'beside' && whole.cols >= 24) {
    const first = Math.max(
      10,
      Math.min(whole.cols - 11, Math.round((whole.cols - 1) * split.ratio)),
    )
    return {
      first: { cols: first, rows: whole.rows },
      second: { cols: whole.cols - 1 - first, rows: Math.max(1, whole.rows - 1) },
    }
  }
  const first = Math.max(1, Math.min(whole.rows - 2, Math.round((whole.rows - 1) * split.ratio)))
  return {
    first: { cols: whole.cols, rows: first },
    second: { cols: whole.cols, rows: Math.max(1, whole.rows - 1 - first) },
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.round(value), low), Math.max(low, high))
}
