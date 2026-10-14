import {
  type Config,
  changedFrom,
  type Keeping as Due,
  keepingDue,
  saidChanged,
  type ToldPart,
} from '@tade/core'
import { inTime } from '@tade/web'
import { withTranscript } from '../model.ts'
import { problem, tadeDid } from '../transcript.ts'
import { type Thinker, type Wiring, why } from './context.ts'

// The orchestrator's conversation, kept in shape by Tade so nobody has to.
//
// Nobody else can: the person talks to it through Tade, and a slash command
// like `/compact` is not theirs to send. So three things are watched, and
// what is done about each is said in one line and written down:
//
// - **What it holds.** A harness that pins what a conversation was first told
//   (`capabilities.pins`) is compacted when that changed, which is the only
//   thing that makes it read its instructions and tools again.
// - **What it would be told now.** Notes and settings move while it runs; when
//   they change what it would be told, it is started again on the same
//   conversation, under the same session id — it picks the conversation back
//   up and is never introduced again.
// - **How full it is.** Past `orchestrator.compact_at`, it is compacted before
//   it fills, rather than when the harness's own limit forces it.
//
// **Never across a turn and never under somebody's fingers** (`keepingDue`):
// both are a turn of their own, and a question typed while one runs waits
// behind something nobody asked for.

/** How long a compaction may take before the window stops waiting for it. */
const COMPACT_MS = 10 * 60_000
/** After one failed, how long before the same thing is tried again: a broken harness is not hammered. */
const AGAIN_MS = 10 * 60_000
/** Starting it again costs a turn read whole, so notes arriving one by one are taken a few at a time. */
const REFRESH_EVERY_MS = 5 * 60_000

export class Keeping {
  private readonly wire: Wiring
  private thinker: Thinker | null = null
  private off: (() => void) | null = null
  /** Something is being done to it right now. */
  private acting = false
  /** The notes and the config as last looked at, so a change is noticed once. */
  private notes = ''
  private config: Config | null = null
  /** The notes or the config moved: whether that changes what it is told is asked once it is free. */
  private moved = false
  /** That its harness cannot be asked was said: once for each start. */
  private said = false
  private failedAt = Number.NEGATIVE_INFINITY
  private refreshedAt = Number.NEGATIVE_INFINITY
  /** Why it was started again, for the line written when it is back. */
  private refreshing: readonly ToldPart[] | null = null

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /** It started — at first, or again: what it was told is written down, and watched from here. */
  attached(thinker: Thinker): void {
    this.off?.()
    this.thinker = thinker
    this.said = false
    this.failedAt = Number.NEGATIVE_INFINITY
    this.notes = this.notesNow()
    this.config = this.wire.opts.config
    this.moved = false
    // The moment a turn ends is the one most likely to have filled it, and
    // the one before anybody starts typing the next.
    this.off =
      thinker.onEvent?.((event) => {
        if (event.type === 'idle') void this.beat()
      }) ?? null
    const holding = thinker.told?.()
    if (!holding) return
    const refreshed = this.refreshing
    this.refreshing = null
    void this.wire.opts.client.log
      .append({
        type: 'orchestrator_told',
        task: null,
        detail: {
          ...holding.told,
          // Whether its conversation holds what this start said, or what it
          // was told before: the one thing the next start compares with.
          holds: holding.stale.length === 0,
          ...(refreshed ? { refreshed: [...refreshed] } : {}),
        },
      })
      .catch(() => {})
  }

  /** Look, and do what is due: on every beat of the window, and whenever a turn ends. */
  async beat(): Promise<void> {
    const thinker = this.thinker
    if (!thinker || this.acting) return
    const notes = this.notesNow()
    if (notes !== this.notes || this.wire.opts.config !== this.config) this.moved = true
    this.notes = notes
    this.config = this.wire.opts.config
    const due = keepingDue({
      busy: thinker.busy?.() ?? false,
      typing: this.typing(),
      compacts: thinker.offers?.compact?.shown ?? false,
      holding: thinker.told?.() ?? null,
      percent: thinker.context?.() ?? null,
      threshold: this.wire.opts.config.orchestrator.compact_at,
    })
    if (due && this.wire.now() - this.failedAt >= AGAIN_MS) return this.act(thinker, due)
    if (!this.moved || thinker.busy?.() || this.typing()) return
    if (this.wire.now() - this.refreshedAt < REFRESH_EVERY_MS) return
    return this.refresh(thinker)
  }

  /** Something is on the orchestrator's line: whoever is writing it is not interrupted. */
  private typing(): boolean {
    const state = this.wire.state
    return (state.dictation ?? state.orchestratorDraft).trim() !== ''
  }

  /** Enough to tell the notes moved, without reading every one on every beat. */
  private notesNow(): string {
    const notes = this.wire.opts.client.recallAll()
    return `${notes.length}:${notes.at(-1)?.at ?? ''}`
  }

  private async act(thinker: Thinker, due: Due): Promise<void> {
    if (due.act === 'say') {
      if (this.said) return
      this.said = true
      const offers = thinker.offers
      const cannot = `${offers?.harness ?? 'its harness'} ${offers?.compact?.note ?? 'cannot be asked to compact'}`
      this.say(
        due.why === 'told'
          ? `Tade could not bring the orchestrator up to date with what it is told now: ${cannot}`
          : `The orchestrator's context is past ${this.wire.opts.config.orchestrator.compact_at}% and Tade cannot compact it: ${cannot}`,
        true,
      )
      return
    }
    const compact = thinker.compact
    if (!compact) return
    this.acting = true
    const told = thinker.told?.()?.told
    try {
      const done = compact.call(thinker).then(() => 'done' as const)
      if ((await inTime(done, COMPACT_MS, 'late' as const)) === 'late') {
        throw new Error(`it had not finished after ${COMPACT_MS / 60_000} minutes`)
      }
      this.say(
        due.why === 'context'
          ? `compacted the orchestrator at ${due.percent}% of its context`
          : `refreshed the orchestrator: ${saidChanged(due.changed, due.known)}`,
      )
      await this.wire.opts.client.log
        .append({
          type: 'orchestrator_compacted',
          task: null,
          detail: {
            ...told,
            why: due.why,
            ...(due.why === 'context'
              ? { percent: due.percent, at: this.wire.opts.config.orchestrator.compact_at }
              : { changed: [...due.changed], known: due.known }),
            after: thinker.context?.() ?? null,
          },
        })
        .catch(() => {})
    } catch (err) {
      this.failedAt = this.wire.now()
      this.say(`Tade could not compact the orchestrator: ${why(err)}`, true)
    } finally {
      this.acting = false
    }
  }

  /**
   * Start it again on the same conversation when what it would be told now is
   * not what it was told: the notes and settings it is given at launch moved.
   * Its own notes since it started are left out (`toldNow`) — it wrote them.
   */
  private async refresh(thinker: Thinker): Promise<void> {
    const toldNow = this.wire.opts.toldNow
    const restart = this.wire.opts.restartThinker
    const holding = thinker.told?.()
    if (!toldNow || !restart || !holding) {
      this.moved = false
      return
    }
    this.acting = true
    try {
      const now = await toldNow(holding.since)
      // Tools load when Tade starts and never between, so only what was said
      // and set can have moved.
      const changed = changedFrom(holding.told, now).filter((part) => part !== 'tools')
      if (changed.length === 0) {
        this.moved = false
        return
      }
      // Looked again: somebody may have started typing while it was worked out.
      if (this.thinker !== thinker || thinker.busy?.() || this.typing()) return
      this.moved = false
      this.refreshedAt = this.wire.now()
      this.refreshing = changed
      this.say(`refreshed the orchestrator: ${saidChanged(changed)}`)
      await restart()
    } catch (err) {
      this.refreshing = null
      this.say(`Tade could not refresh the orchestrator: ${why(err)}`, true)
    } finally {
      this.acting = false
    }
  }

  /** One line in the conversation: Tade's, or trouble. */
  private say(text: string, trouble = false): void {
    const at = this.wire.now()
    const transcript = this.wire.state.transcript
    this.wire.put(
      withTranscript(
        this.wire.state,
        trouble ? problem(transcript, text, at) : tadeDid(transcript, text, at),
      ),
    )
    this.wire.draw()
  }
}
