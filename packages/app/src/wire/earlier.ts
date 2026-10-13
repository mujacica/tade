import { askingEarlier, withEarlier } from '../transcript.ts'
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

/** How many of the person's own sentences are looked through to tell theirs from Tade's. */
const SAID_LOOKED_AT = 2_000

export class Earlier implements Subject {
  private readonly wire: Wiring
  /**
   * What the person is recorded as having said (`said` lines), so a message
   * that went under no heading can be told apart from one Tade composed.
   */
  private theirs: Set<string> | null = null

  constructor(wire: Wiring) {
    this.wire = wire
  }

  actions(): Actions {
    return { 'transcript-earlier': () => this.more() }
  }

  /**
   * The newest page, when the window opens. Put above whatever the window has
   * already said — nothing the person has typed can be in it yet, since the
   * orchestrator takes seconds to start and this takes milliseconds.
   */
  async load(): Promise<void> {
    await this.read(null)
  }

  /** The page before what is shown, once, while nothing else is reading one. */
  async more(): Promise<void> {
    const earlier = this.wire.state.transcript.earlier
    if (!earlier || earlier.asking) return
    this.put(askingEarlier(this.wire.state.transcript))
    await this.read(earlier.cursor)
  }

  private async read(before: string | null): Promise<void> {
    const history = this.wire.opts.history
    if (!history) return
    try {
      const [page, theirs] = await Promise.all([
        history({ limit: EARLIER_PAGE, before }),
        this.said(),
      ])
      const now = this.wire.state.transcript
      // Something fell off the top while this was being read: what came back
      // no longer joins up with what is shown.
      if (before !== null && now.earlier?.cursor !== before) return
      this.put(withEarlier(now, page.items, page.earlier, (text) => theirs.has(text)))
    } catch (err) {
      const now = this.wire.state.transcript
      this.put({ ...now, earlier: now.earlier ? { ...now.earlier, asking: false } : null })
      notify(this.wire, `could not read what was said before: ${why(err)}`)
      this.wire.draw()
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
