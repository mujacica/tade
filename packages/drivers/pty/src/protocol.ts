import type { LaneScreen } from '@tade/drivers-core'

// What crosses between the pty driver and the thread its emulators run on
// (`emulator.ts`), said once and loaded by both: types, and the one number
// both sides have to agree on. Nothing here may load xterm — the driver
// imports this, and the whole point is that the thread that draws never
// holds an emulator.

/**
 * What the driver tells the emulators, in the order it happened.
 *
 * `seq` numbers everything that changes a screen — what the program printed,
 * and the lane being resized — so a frame can say exactly how much of it is
 * in it, and the driver can tell a frame that is current from one that is
 * not without asking.
 */
export type Order =
  | {
      do: 'open'
      key: number
      cols: number
      rows: number
      scrollback: number
      /** Everything up to here is `seed`, which is empty for a lane just started. */
      seq: number
      seed: string
    }
  | { do: 'data'; key: number; seq: number; at: number; data: string }
  | { do: 'resize'; key: number; seq: number; cols: number; rows: number }
  | { do: 'watch'; key: number; lines: number; styled: boolean }
  | { do: 'look'; key: number; ask: number }
  | { do: 'release'; key: number }
  | { do: 'held'; ask: number }

/** What the emulators tell the driver. */
export type Report =
  | ({ is: 'frame'; key: number } & Frame)
  | { is: 'view'; key: number; ask: number; seq: number; view: LaneScreen | null }
  | { is: 'held'; ask: number; bytes: number }

/** One screen, as a capture hands it over, and the numbers beside it. */
export interface Frame {
  /** Everything ordered up to this is in it: the output parsed, the resizes applied. */
  seq: number
  lines: number
  styled: boolean
  rows: string
  /** Not a frame half drawn — `settled` — or the wait for one ran out. */
  whole: boolean
  /** On the alternate screen: the only one whose rows can be two frames mixed. */
  alternate: boolean
  /** The numbers beside it, measured on the same screen at the same moment. */
  view: LaneScreen
}

/** How long a lane stays watched after the last time the driver asked about it. */
export const WATCH_MS = 1_000
