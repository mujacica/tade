import {
  type EventType,
  markOf,
  nobodyHere,
  presenceLineDue,
  presentBefore,
  type SinceItem,
  sinceHere,
} from '@tade/core'
import { reachOf, sinceAnswerOf, type WebSince } from '@tade/web'
import type { Wiring } from './context.ts'

// The person at another of their screens, as this machine counts them: what an
// owner's link carries (`@tade/web`'s `presence.ts`), held for push to read,
// and written down once a stretch as `person_present` — the cursor the
// catch-up card another machine of theirs asks for is folded from
// (`since.ts`, REMOTE-TADE.md §5.4).
//
// **Held in memory and written to the journal are two answers to two
// questions.** Whether to buzz a phone is about the last couple of minutes,
// and is what the window holds. Where "since you were here" starts has to
// outlive a restart, so it is a line in this machine's own journal, in its own
// clock — at most one every few minutes (`presenceLineDue`), never one per
// keystroke.

/** The kinds of line the card is folded from, read through the index rather than the whole file. */
const SINCE_READS: readonly EventType[] = [
  'person_present',
  'task_done',
  'run_started',
  'task_removed',
  'task_created',
  'document_ready',
  'document_triaged',
  'document_moved',
  'document_deleted',
  'queue_held',
  'queue_changed',
  'queue_started',
  'watch_found',
  'schedule_fired',
  'proposal_decided',
  'leftovers_reported',
  'state_change',
  'usage',
]

export class Presences {
  private readonly wire: Wiring
  private readonly news: (said: string) => void
  private at: number | null = null
  /** When this window last wrote a presence line, in this clock. */
  private lineAt: number | null = null

  constructor(wire: Wiring, news: (said: string) => void) {
    this.wire = wire
    this.news = news
  }

  /** When an owner's link last said somebody pressed a key at another of their screens. */
  presentAt(): number | null {
    return this.at
  }

  /**
   * "Nobody is here", for a turn Tade starts — or null where somebody has been
   * lately (`nobodyHere`): a key in this window or at another screen of
   * theirs, and this window's opening where a person opened it.
   */
  nobodyHere(): string | null {
    const here = this.wire.state.lastInputAt
    return nobodyHere({
      seen: here === null ? this.at : this.at === null ? here : Math.max(here, this.at),
      opened: this.wire.openedAt,
      keptBy: this.wire.opts.keptBy ?? null,
      holds: this.wire.opts.config.queue.holds,
      now: this.wire.now(),
    })
  }

  /** An owner's link said a key was pressed there at `at`, in this clock. */
  seen(device: string, at: number): void {
    this.at = Math.max(this.at ?? at, at)
    const now = this.wire.now()
    if (!presenceLineDue(this.lineAt, now - at, now)) return
    this.lineAt = now
    // A line that would not go in is said, never swallowed: the card it is the
    // cursor of would start from the stretch before without a word.
    this.wire.opts.client.log
      .append({ type: 'person_present', detail: { device } })
      .catch((err: unknown) => {
        this.news(`the away view could not write person_present down: ${String(err)}`)
      })
  }

  /** The card: folded over this machine's journal from the last moment it counted them present before `cut`. */
  since(): WebSince {
    return async (device, cut) => {
      const events = await this.wire.opts.client.log.read({ types: SINCE_READS })
      const since = presentBefore(events, cut)
      const here = since === null ? null : sinceHere(events, since, this.wire.now())
      return sinceAnswerOf(here, this.waiting(), reachOf(device))
    }
  }

  /** What is waiting on the person now: the window's own mark, read off its last look. */
  private waiting(): SinceItem[] {
    const now = this.wire.now()
    return (this.wire.live?.tasks ?? []).flatMap((task) =>
      markOf(task) !== 'needs-you'
        ? []
        : [
            {
              task: task.task,
              at: now,
              said: task.approval
                ? `wants an answer about ${task.approval.tool}`
                : task.queued?.state.kind === 'held'
                  ? 'is held, waiting on a decision'
                  : 'is waiting on you',
            },
          ],
    )
  }
}
