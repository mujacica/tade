// A drag held off the end of something that scrolls.
//
// The pointer held still past an edge reports nothing, so a selection that
// stopped there could never reach past one screen: what is under it goes on
// scrolling by a clock of its own, a step every `EDGE_MS`, each as far as the
// pointer is past the edge. A hand moving out there is an event at every cell,
// though, and each one used to stop that clock and start it again with a step
// of its own — so a drag off the end scrolled at the rate the mouse reports
// rather than at this one, faster the more the hand shook. Held the same way,
// an event only says how far the next step goes.

/**
 * How often a drag held off the end scrolls. A hand held still reports
 * nothing, so this is the only clock in a selection — fast enough to read as
 * scrolling, slow enough that a whole file does not go past under it.
 */
export const EDGE_MS = 80

/** A drag held past an edge, stepping on a clock until it comes back inside or is let go. */
export class EdgeHold<T> {
  private readonly step: (held: T) => void
  private readonly sameWay: (was: T, now: T) => boolean
  private held: T | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  /**
   * `step` moves what is held one step; `sameWay` says whether two holds are
   * one — the same thing scrolling the same way — so the second only changes
   * how far.
   */
  constructor(step: (held: T) => void, sameWay: (was: T, now: T) => boolean) {
    this.step = step
    this.sameWay = sameWay
  }

  /**
   * Held past the edge: a step now and one every `EDGE_MS` after — or, where
   * it is already held the same way, nothing now and the next step this far.
   */
  hold(now: T): void {
    const was = this.held
    if (this.timer !== null && was !== null && this.sameWay(was, now)) {
      this.held = now
      return
    }
    this.letGo()
    this.held = now
    this.timer = setInterval(() => {
      if (this.held !== null) this.step(this.held)
    }, EDGE_MS)
    this.timer.unref?.()
    // After the timer, so the first step can stop it where there is nowhere to go.
    this.step(now)
  }

  /** Back inside, let go of, or nowhere left to go. */
  letGo(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.held = null
  }
}
