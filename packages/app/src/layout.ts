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

export interface LayoutPrefs {
  /** Columns for the projects list. */
  sidebarWidth?: number
  /** Rows for the bottom panel — orchestrator and terminals — including its tabs. */
  stripHeight?: number
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

/**
 * Rows the window spends on itself: the project tabs, the rule under them, and
 * the rule and buttons at the foot. Counted here rather than in the drawing,
 * because a frame that does not add up to the terminal's height corrupts the
 * whole screen.
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
  const bodyHeight = height - stripHeight - CHROME

  // Unasked, the sidebar is a share of the window rather than a fixed 24: on a
  // wide terminal that is a thin ribbon beside an ocean, and task names are the
  // one thing in it that must stay readable.
  const wanted = prefs.sidebarWidth ?? clamp(Math.round(width / 4), DEFAULTS.sidebarWidth, 36)
  const widest = Math.min(SIDEBAR_MOST, width - MINIMUM.main - 1)
  const sidebarWidth = clamp(wanted, MINIMUM.sidebar, Math.max(MINIMUM.sidebar, widest))
  return { sidebarWidth, stripHeight, mainWidth: width - sidebarWidth - 1, bodyHeight }
}

/**
 * What is worth writing down when the window closes: which pane you were on,
 * and the sizes you dragged the dividers to. The config says what a window
 * starts at; a divider you moved is you saying otherwise, and losing that on
 * every restart would be asking you to say it again.
 */
export interface RememberedWindow {
  /** The task whose pane had focus. */
  focused: string | null
  sidebarWidth?: number
  stripHeight?: number
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
  return {
    focused: typeof raw.focused === 'string' ? raw.focused : null,
    ...size('sidebarWidth'),
    ...size('stripHeight'),
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.round(value), low), Math.max(low, high))
}
