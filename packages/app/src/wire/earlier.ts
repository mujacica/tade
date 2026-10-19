import { askingEarlier, READ_FROM_END, withEarlier } from '../transcript.ts'
import { type Actions, notify, type Subject, type Wiring, why } from './context.ts'

// What was said to the orchestrator before this window opened.
//
// The conversation itself was never lost: the orchestrator's session id never
// changes, so its harness takes it up where it stopped. What was lost was the
// *drawing* — the window started every conversation empty, in front of a
// model that remembered everything — so the person could not see what they
// were continuing. This reads it back out of the harness's own record (never
// the journal, which is not a transcript), a page at a time from the newest
// end: the last page when the window opens, and the one before it whenever
// somebody scrolls up to the top of what is shown.

/** How much one read brings back: a few exchanges, about a screen and a half of them. */
export const EARLIER_PAGE = 60

/**
 * How many pages one look back may read past what is newer than what is
 * shown, before it stops for now with its place kept: a record read from its
 * end after lines fell off the top passes over everything still shown first.
 */
export const LOOKS = 40

/** How many of the person's own sentences are looked through to tell theirs from Tade's. */
const SAID_LOOKED_AT = 2_000

export class Earlier implements Subject {
  private readonly wire: Wiring
  /**
   * What the person is recorded as having said (`said` lines), so a message
   * that went under no heading can be told apart from one Tade composed.
   */
  private theirs: Set<string> | null = null
  /** The look back in flight, which everybody asking meanwhile is answered by. */
  private reading: Promise<boolean> | null = null

  constructor(wire: Wiring) {
    this.wire = wire
  }

  actions(): Actions {
    return { 'transcript-earlier': () => void this.more() }
  }

  /**
   * The newest page, when the window opens. Put above whatever the window has
   * already said — nothing the person has typed can be in it yet, since the
   * orchestrator takes seconds to start and this takes milliseconds.
   */
  async load(): Promise<void> {
    await this.read(null)
  }

  /**
   * The page before what is shown — asked by somebody scrolling up here, or
   * by a page on a phone scrolled up past what it holds (`web.ts`). One at a
   * time: an ask while one is being read is answered by that one. False is a
   * record that could not be read, which has been said where it happened.
   */
  more(): Promise<boolean> {
    if (this.reading !== null) return this.reading
    const earlier = this.wire.state.transcript.earlier
    if (!earlier) return Promise.resolve(true)
    this.put(askingEarlier(this.wire.state.transcript))
    this.reading = this.read(earlier.cursor).finally(() => {
      this.reading = null
    })
    return this.reading
  }

  private async read(before: string | null): Promise<boolean> {
    const history = this.wire.opts.history
    if (!history) {
      // Nothing to read it from: nothing is offered.
      const now = this.wire.state.transcript
      if (now.earlier) this.put({ ...now, earlier: null })
      return true
    }
    try {
      const theirs = await this.said()
      // `''` is the record read from its end (`READ_FROM_END`): lines fell off
      // the top of what is shown, so no cursor joins up with it, and what is
      // newer than the first line shown is passed over on the way back.
      let expected = before
      let at = before === READ_FROM_END ? null : before
      for (let looked = 0; looked < LOOKS; looked += 1) {
        const page = await history({ limit: EARLIER_PAGE, before: at })
        const now = this.wire.state.transcript
        // Something fell off the top while this was being read: what came back
        // no longer joins up with what is shown.
        if (expected !== null && now.earlier?.cursor !== expected) return true
        // Only what was said before the first line shown: on the way back
        // from the record's end, the rest is already here.
        const first = now.entries[0]?.at ?? Number.POSITIVE_INFINITY
        const items = page.items.filter((item) => item.at < first)
        const next = withEarlier(now, items, page.earlier, (text) => theirs.has(text))
        if (items.length > 0 || page.earlier === null) {
          this.put(next)
          return true
        }
        // Nothing older on this page yet: carry on from where it ends.
        this.put(askingEarlier(next))
        expected = page.earlier
        at = page.earlier
      }
      const now = this.wire.state.transcript
      this.put({ ...now, earlier: now.earlier ? { ...now.earlier, asking: false } : null })
      return true
    } catch (err) {
      const now = this.wire.state.transcript
      this.put({ ...now, earlier: now.earlier ? { ...now.earlier, asking: false } : null })
      notify(this.wire, `could not read what was said before: ${why(err)}`)
      this.wire.draw()
      return false
    }
  }

  /**
   * Put without moving anything: what is added is above what is in view, and
   * the conversation keeps its place counted from its newest line.
   */
  private put(transcript: Wiring['state']['transcript']): void {
    this.wire.put({ ...this.wire.state, transcript })
    this.wire.draw()
  }

  private async said(): Promise<Set<string>> {
    if (this.theirs) return this.theirs
    // Unread, nothing under no heading is drawn as theirs: the safe way to
    // be wrong, since a sentence of Tade's shown as somebody's is the one
    // mistake this may never make.
    const events = await this.wire.opts.client
      .events({ types: ['said'], limit: SAID_LOOKED_AT })
      .catch(() => [])
    this.theirs = new Set(
      events.flatMap((event) => (typeof event.detail.text === 'string' ? [event.detail.text] : [])),
    )
    return this.theirs
  }
}
