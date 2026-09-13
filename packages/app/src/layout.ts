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
  /** Rows for the orchestrator strip, including its rule. */
  stripHeight?: number
}

export interface Layout {
  sidebarWidth: number
  stripHeight: number
  /** What is left for the agent's own screen. */
  mainWidth: number
  bodyHeight: number
}

export const DEFAULTS = { sidebarWidth: 24, stripHeight: 9 }

/** Below these the region stops being readable and starts being decoration. */
export const MINIMUM = { sidebar: 12, strip: 4, main: 20, body: 1 }

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
  const height = Math.max(MINIMUM.strip + MINIMUM.body + 1, frame.height)

  // The strip never takes more than a third: it is context, not the view.
  const stripHeight = clamp(
    prefs.stripHeight ?? DEFAULTS.stripHeight,
    MINIMUM.strip,
    Math.max(MINIMUM.strip, Math.floor(height / 3)),
  )
  const bodyHeight = height - stripHeight - 1

  const sidebarWidth = clamp(
    prefs.sidebarWidth ?? DEFAULTS.sidebarWidth,
    MINIMUM.sidebar,
    Math.max(MINIMUM.sidebar, width - MINIMUM.main - 1),
  )
  return { sidebarWidth, stripHeight, mainWidth: width - sidebarWidth - 1, bodyHeight }
}

/** What is worth writing down when the window closes. */
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
  const focused = typeof raw.focused === 'string' ? raw.focused : null
  return {
    focused,
    ...(positive(raw.sidebarWidth) ? { sidebarWidth: raw.sidebarWidth as number } : {}),
    ...(positive(raw.stripHeight) ? { stripHeight: raw.stripHeight as number } : {}),
  }
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.round(value), low), Math.max(low, high))
}
