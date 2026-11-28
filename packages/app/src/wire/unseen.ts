import type { Terminal } from '@earendil-works/pi-tui'

// The terminal of a window nobody sits at (`tade serve`): it takes every write
// and shows none of them, reads no key and never changes size.
//
// The window runs on it whole, so a phone's full view has the subjects a frame
// is folded from (`FarFaces`) — which only a window has — and what the window
// would have drawn for itself goes nowhere. Its size is what a lane is fitted
// against (`Fitting`): `UNSEEN` lays the agent's pane out near the 120 × 40 a
// lane is made at with no window at all (the drivers' own default), so serving
// the full view does not squeeze every agent into a terminal-shaped corner.

/** The size the unseen window lays itself out at. */
export const UNSEEN = { columns: 160, rows: 52 } as const

/** A terminal that is written to and never seen. */
export function unseenTerminal(size: { columns: number; rows: number } = UNSEEN): Terminal {
  const nothing = () => {}
  return {
    start: nothing,
    stop: nothing,
    drainInput: async () => {},
    write: nothing,
    columns: size.columns,
    rows: size.rows,
    kittyProtocolActive: false,
    moveBy: nothing,
    hideCursor: nothing,
    showCursor: nothing,
    clearLine: nothing,
    clearFromCursor: nothing,
    clearScreen: nothing,
    setTitle: nothing,
    setProgress: nothing,
    setProgramStatus: nothing,
  }
}
