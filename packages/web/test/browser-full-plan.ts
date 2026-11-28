// The sizes the full view is held at in a browser (§10 T4 of the Duo plan),
// as `packages/app/scripts/browser-full.ts` drives it: the Duo's six from the
// plan's §1 and two slab iPhones, each the way up it is held, and what the
// window must come to at each.
//
// **Pure**, like `browser-duo-plan.ts`, so the offline suite holds the plan —
// every size here, its insets, the columns asked for — while the browser stays
// optional on the machine.

import type { Insets } from './browser-duo-plan.ts'

/** One screen the full view is looked at on. */
export interface FullSize {
  name: string
  width: number
  height: number
  insets: Insets
  /** The columns the window must be drawn in here, where the plan names a number. */
  columns?: { least: number; most: number }
  /** The large screen sideways: the sidebar's edge goes on the fold, the centre column. */
  fold?: true
}

const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * **The Duo's six**: its two screens each way up as a Home Screen app at @3x
 * (`DUO` in `browser-duo-plan.ts`, with the camera column and the home
 * indicator), the inner screen split in two (Split View, a fixed half), and
 * the small screen sideways in a Safari tab — WebKit's own table in the plan's
 * §1, 594 × 368, the least room the window is drawn in on that phone.
 *
 * **Two slab iPhones**, each upright and sideways: the 6.1" (393 × 852) and
 * the 6.9" (440 × 956), with the Dynamic Island's band and the home indicator.
 */
export const FULL_SIZES: readonly FullSize[] = [
  { name: 'duo-outer-upright', width: 466, height: 678, insets: { ...NONE, top: 84, bottom: 34 } },
  {
    name: 'duo-outer-sideways',
    width: 678,
    height: 466,
    insets: { ...NONE, left: 84, bottom: 34 },
    columns: { least: 78, most: 82 },
  },
  { name: 'duo-inner-upright', width: 669, height: 951, insets: { ...NONE, bottom: 34 } },
  {
    name: 'duo-inner-sideways',
    width: 951,
    height: 669,
    insets: { ...NONE, bottom: 21 },
    columns: { least: 126, most: 132 },
    fold: true,
  },
  { name: 'duo-split-half', width: 385, height: 609, insets: { ...NONE, bottom: 34 } },
  {
    name: 'duo-outer-safari-sideways',
    width: 594,
    height: 368,
    insets: NONE,
    columns: { least: 78, most: 82 },
  },
  { name: 'slab-6.1-upright', width: 393, height: 852, insets: { ...NONE, top: 59, bottom: 34 } },
  {
    name: 'slab-6.1-sideways',
    width: 852,
    height: 393,
    insets: { top: 0, right: 59, bottom: 21, left: 59 },
  },
  { name: 'slab-6.9-upright', width: 440, height: 956, insets: { ...NONE, top: 62, bottom: 34 } },
  {
    name: 'slab-6.9-sideways',
    width: 956,
    height: 440,
    insets: { top: 0, right: 62, bottom: 21, left: 62 },
  },
]
