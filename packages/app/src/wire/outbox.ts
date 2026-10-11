import type { LaneId } from '@tade/core'
import type { PointerReport, WheelTurn } from '@tade/drivers-core'
import type { Workbench } from '@tade/workbench'

// Everything the window sends a lane from what it was handed to type, in the
// order it was sent.
//
// A terminal hands the window what it read from stdin as one event, and pi-tui
// splits the event into the sequences in it and dispatches every one of them
// before anything else runs. A paste the terminal did not bracket, a dictation
// tool typing on somebody's behalf, the keys that piled up while the window was
// drawing — each is hundreds of sequences in one event, and every one of them
// was a write of its own: 2,025 for a 2 KB paste into a terminal, a syscall
// each under `pty` and a whole process each under `tmux`, which spawns them one
// at a time so that they arrive in order.
//
// So what is sent in one turn is sent once, when the turn is over: a microtask,
// which is after the last sequence of the event and before anything is drawn.
// A write is joined only to the write in front of it, and only when that went
// to the same lane, so the bytes a lane gets are the bytes it was sent in the
// order they were sent — a press or a notch reported to it included. That is
// why those come through here too rather than going straight to the driver: a
// click sent past text still waiting would land before the typing it followed.
//
// Nothing here is awaited and nothing here fails out loud, which is what every
// keystroke already did: a lane that went away while somebody typed at it is
// not news, and the next look says it has gone.

/** The three ways the window reaches into a lane. */
export type LaneDoor = Pick<Workbench, 'write' | 'point' | 'wheel'>

type Sent =
  | { kind: 'write'; lane: LaneId; data: string }
  | { kind: 'point'; lane: LaneId; report: PointerReport }
  | { kind: 'wheel'; lane: LaneId; turn: WheelTurn }

export class Outbox {
  private readonly door: LaneDoor
  private sent: Sent[] = []
  /** The end of this turn is already asked for. */
  private due = false

  constructor(door: LaneDoor) {
    this.door = door
  }

  /** Type into a lane: joined to the write in front of it where that went to the same lane. */
  write(lane: LaneId, data: string): void {
    const last = this.sent[this.sent.length - 1]
    if (last?.kind === 'write' && last.lane === lane) last.data += data
    else this.queue({ kind: 'write', lane, data })
  }

  /** What the pointer did, for a program that answers it itself. */
  point(lane: LaneId, report: PointerReport): void {
    this.queue({ kind: 'point', lane, report })
  }

  /** The wheel, for a program that scrolls itself. */
  wheel(lane: LaneId, turn: WheelTurn): void {
    this.queue({ kind: 'wheel', lane, turn })
  }

  /** Send everything waiting, now and in order. The end of the turn is when. */
  flush(): void {
    const sent = this.sent
    this.sent = []
    for (const one of sent) {
      const went =
        one.kind === 'write'
          ? this.door.write(one.lane, one.data)
          : one.kind === 'point'
            ? this.door.point(one.lane, one.report)
            : this.door.wheel(one.lane, one.turn)
      void went.catch(() => {})
    }
  }

  private queue(one: Sent): void {
    this.sent.push(one)
    if (this.due) return
    this.due = true
    queueMicrotask(() => {
      this.due = false
      this.flush()
    })
  }
}
