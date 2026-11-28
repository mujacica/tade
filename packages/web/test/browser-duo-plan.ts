// The foldable iPhone Duo, as `scripts/browser-duo.ts` holds the away view to
// it: its screens, the looks at each, and how a stylesheet is answered so a
// browser engine that knows nothing of a camera column draws one.

import { FULL_SIZES } from './browser-full-plan.ts'
//
// **Pure**, like `browser-plan.ts`, so the offline suite holds the plan — that
// all four screens are here with their insets, and that every look is a route
// the server serves — while the browser stays optional on the machine.

/** The edges of the screen the phone keeps for itself, in CSS pixels. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/** One of the Duo's screens, held one way up. */
export interface DuoScreen {
  name: string
  width: number
  height: number
  insets: Insets
  /** How much of the height the keyboard takes, so the chat is looked at with it up. */
  keyboard: number
}

/**
 * **The Duo's four screens, at @3x**, as the phone reports them (pinned in
 * vrolta's `client/touch/touch_screen.gd`): the outer screen is 2034 by 1398
 * pixels and the inner 2853 by 2007, so 678 by 466 and 951 by 669 CSS pixels.
 *
 * Sideways, the outer screen keeps a column of 84 points down its left edge
 * for the status bar and the camera, and 34 along the bottom for the home
 * indicator; upright, that column is along the top. The inner screen's camera
 * is under the glass, so it keeps only the home indicator's band: 21 points
 * sideways, 34 upright.
 *
 * The keyboard is an iPhone's with its suggestions bar over it, measured as a
 * share of each screen as iOS draws it; the figures are estimates, and what
 * they hold is that the chat's field and its last line stay in the room left.
 */
export const DUO: readonly DuoScreen[] = [
  {
    name: 'outer-upright',
    width: 466,
    height: 678,
    insets: { top: 84, right: 0, bottom: 34, left: 0 },
    keyboard: 336,
  },
  {
    name: 'outer-landscape',
    width: 678,
    height: 466,
    insets: { top: 0, right: 0, bottom: 34, left: 84 },
    keyboard: 209,
  },
  {
    name: 'inner-upright',
    width: 669,
    height: 951,
    insets: { top: 0, right: 0, bottom: 34, left: 0 },
    keyboard: 380,
  },
  {
    name: 'inner-landscape',
    width: 951,
    height: 669,
    insets: { top: 0, right: 0, bottom: 21, left: 0 },
    keyboard: 300,
  },
]

/** One page to look at on each screen, and what to do on it before measuring. */
export interface DuoLook {
  name: string
  path: string
  /** What has drawn once the page is ready to measure; `main` when not said. */
  ready?: string
  /** The field to put the caret in. */
  focus?: string
  /** Looked at with the keyboard up. */
  keyboard?: true
  /** Looked at with no session: the pairing page. */
  paired?: false
}

/**
 * **Where the overview is looked at: the full view's sizes** (§10 T5 of the
 * Duo plan, `FULL_SIZES`) — the Duo's six from the plan's §1 and two slab
 * iPhones each way up — so the page's two modes are held at the same screens.
 * The keyboard is an estimate of iOS's with its suggestions bar, as `DUO`'s:
 * what it holds is that the box and its last line stay in the room left.
 */
export const OVERVIEW_SIZES: readonly DuoScreen[] = FULL_SIZES.map((one) => ({
  name: one.name,
  width: one.width,
  height: one.height,
  insets: one.insets,
  keyboard: Math.round(one.height * (one.width > one.height ? 0.47 : 0.42)),
}))

/**
 * The page's two screens, each at its real path with the fixtures' own names
 * (`browser-plan.ts`'s `NAMES`): the pairing page, and the overview — as it
 * opens, and with the keyboard up in the box to Tade. Everything else is a
 * panel of the window, in the full view (`browser-full.ts`).
 */
export const DUO_LOOKS: readonly DuoLook[] = [
  { name: 'pairing', path: '/pair', ready: '#label', paired: false },
  { name: 'overview', path: '/', ready: 'main .page-overview .ov-tile' },
  {
    name: 'overview-keyboard',
    path: '/',
    ready: 'main .page-overview textarea',
    focus: 'main .page-overview textarea',
    keyboard: true,
  },
]

/** `env(safe-area-inset-x)` and `env(safe-area-inset-x, fallback)`, in any spacing. */
const ENV = /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g

/**
 * A stylesheet with every inset turned into a custom property the harness sets
 * on the root, so the shipped rules are laid out with the phone's bands in
 * them. Nothing else in the sheet changes.
 */
export function insetsAsVars(css: string): string {
  return css.replace(ENV, (_, side: string) => `var(--duo-inset-${side}, 0px)`)
}
