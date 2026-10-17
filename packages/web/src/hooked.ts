import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HookAddress, HookRung, HookSource } from '@tade/core'
import { type Refusal, refuse } from './errors.ts'
import { Window } from './guard.ts'
import { checkDelivery, deliveryDigest, HOOK_BODY_MAX } from './hooks.ts'
import { header, inTime } from './request.ts'
import type { Told } from './serving.ts'

// The doorbell's door (REMOTE-TADE.md §6.2): one delivery read, checked,
// answered and rung, in that order and no other.
//
// 1. **A source with no secret is a path nobody built**: `404`, read at every
//    delivery, so a secret added or cleared counts at the next one without
//    cutting every phone off by building the listener again.
// 2. **A rate, per source** (`HOOK_TRIES` a minute): past it, `429` before a
//    byte of the body is read — a flood costs a counter, and what it was
//    about is found by the poll.
// 3. **A body cap** (`HOOK_BODY_MAX`): past it, `200` and left unread.
// 4. **The signature over the raw bytes, and the source's window**
//    (`hooks.ts`), before anything is parsed.
// 5. **The delivery's id against a ring of the ones already seen** — only of
//    deliveries that verified, or anybody could fill it with guesses and have
//    the real one turned away as a repeat.
// 6. **`200` at once**, because Slack gives three seconds, Linear five and
//    GitHub ten; then which schedules it is for, and the nudge.
//
// **A delivery only ever wakes a schedule**: the window's `match` says which,
// its `wake` makes each look now, and the look reads the source under the
// grant like any other — so nothing here can make work, and a forged one,
// were it to get past every check above, could only make Tade look sooner.
//
// **What the journal is told is bounded where it is written.** A new delivery
// that verified is a line each, because its source sent it. One that did not
// is anybody on the internet, and a repeat may be too — GitHub signs no
// moment, so a delivery somebody captured verifies for ever — so refusals and
// repeats are each a line a minute per source with the count since the last
// one (`REFUSED_EVERY_MS`). The last minute's count is said with the next one
// rather than on a clock: nothing here keeps a timer.

/** What the window hands the doorbell's door. */
export interface WebHooks {
  /** The secret a source signs with, read at every delivery; null or empty is no doorbell. */
  secret(source: HookSource): string | null
  /** Which schedules one delivery is for, by id. Asked after the source has been answered. */
  match(address: HookAddress): Promise<readonly string[]>
  /**
   * Make each look now, or once more after the look under way, handed what the
   * delivery named that a poll cannot see (`HookAddress.item`). Asked after
   * the line is written — which is appended, not yet read back, so the item
   * comes with the wake as well as in the line.
   */
  wake(schedules: readonly string[], item?: string): void
}

/** How many deliveries one source gets a minute before it is told to slow down. */
export const HOOK_TRIES = 120
export const HOOK_WINDOW_MS = 60_000

/** How many delivery ids are remembered per source: a retry storm's worth, and a day of a quiet repository's. */
export const HOOKS_KEPT = 1024

/** How long the line waits on the window to say which schedules a delivery is for. */
export const MATCH_MS = 5_000

/** How often a source's refusals, and its repeats, are a line: the first at once, the rest counted into the next. */
export const REFUSED_EVERY_MS = 60_000

/** One door for every source, held by the listener for its lifetime. */
export class HookDoor {
  private readonly opts: {
    hooks: WebHooks | undefined
    now: () => number
    tell: (told: Told) => void
    answer: (res: ServerResponse, refusal: Refusal) => void
    json: (res: ServerResponse, body: unknown) => void
  }
  private readonly tries = new Window(HOOK_TRIES, HOOK_WINDOW_MS)
  /** Digests of the deliveries seen, per source, oldest first. */
  private readonly seen = new Map<HookSource, string[]>()
  /** Refusals and repeats, per source, since the last line about each. */
  private readonly counts = new Map<string, { at: number; count: number }>()

  constructor(opts: HookDoor['opts']) {
    this.opts = opts
  }

  /** One delivery, answered through the listener's own `answer` and `json`. Never throws. */
  async ring(source: HookSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hooks = this.opts.hooks
    const secret = hooks === undefined ? null : this.asked(() => hooks.secret(source), null)
    if (hooks === undefined || secret === null || secret.trim() === '') {
      return this.opts.answer(res, refuse('no_such'))
    }
    const now = this.opts.now()
    const count = this.tries.add(source, now)
    if (count > HOOK_TRIES) {
      if (count === HOOK_TRIES + 1) {
        this.opts.tell({
          type: 'warning',
          detail: {
            message: `more than ${HOOK_TRIES} ${source} deliveries came in a minute, so the rest are told to slow down; the poll still finds what they were about`,
            where: source,
          },
        })
      }
      return this.opts.answer(res, refuse('slow_down', { after: this.tries.after(source, now) }))
    }
    const raw = await bounded(req, HOOK_BODY_MAX)
    if (raw === null) {
      this.counted({ source, delivery: '', verified: false, why: 'too big' }, now)
      return this.opts.json(res, {})
    }
    const checked = checkDelivery(source, {
      header: (name) => header(req, name),
      raw,
      secret: secret.trim(),
      now,
    })
    if (!checked.ok) {
      if (checked.verified) {
        this.line({ source, delivery: '', verified: true, why: checked.why, woke: [] })
        return this.opts.answer(res, refuse('malformed'))
      }
      this.counted({ source, delivery: '', verified: false, why: checked.why }, now)
      // One answer for every way it did not verify: which check refused is a
      // map of the door, and the sender's move is the same either way.
      return this.opts.answer(res, refuse('bad_origin'))
    }
    const delivery = deliveryDigest(checked.delivery)
    const said: HookRung = { source, delivery, verified: true, event: checked.event }
    if (delivery !== '' && this.saw(source, delivery)) {
      this.counted({ ...said, woke: [], why: 'duplicate' }, now)
      return this.opts.json(res, {})
    }
    this.opts.json(res, checked.answer)
    if (checked.address === null) return this.line({ ...said, woke: [] })
    const address = checked.address
    const woke = await inTime(
      hooks.match(address).catch((err: unknown) => {
        this.opts.tell({
          type: 'warning',
          detail: {
            message: `a ${source} delivery could not be matched to a watch: ${String(err)}`,
          },
        })
        return null
      }),
      MATCH_MS,
      null,
    )
    if (woke === null) {
      return this.line({ ...said, woke: [], why: 'no watch could be named for it in time' })
    }
    // The line first, then the looks: the window reads which looks a doorbell
    // made by what came first in the journal (`schedule-fold.ts`). What it
    // named goes on the line only where it woke something to read it.
    const item = woke.length > 0 ? address.item : undefined
    this.line({ ...said, woke, ...(item === undefined ? {} : { item }) })
    if (woke.length > 0) this.asked(() => hooks.wake(woke, item), undefined)
  }

  /** Whether this delivery was seen before, remembering it if not. */
  private saw(source: HookSource, delivery: string): boolean {
    const kept = this.seen.get(source) ?? []
    this.seen.set(source, kept)
    if (kept.includes(delivery)) return true
    kept.push(delivery)
    if (kept.length > HOOKS_KEPT) kept.splice(0, kept.length - HOOKS_KEPT)
    return false
  }

  /**
   * A refusal or a repeat: the first a line at once, the rest counted into the
   * next one past the minute — a refusal's and a repeat's apart, so a repeat
   * that verified is never written down as one that did not.
   */
  private counted(rung: HookRung, now: number): void {
    const key = `${rung.source} ${rung.verified}`
    const kept = this.counts.get(key) ?? { at: Number.NEGATIVE_INFINITY, count: 0 }
    this.counts.set(key, kept)
    kept.count++
    if (now - kept.at < REFUSED_EVERY_MS) return
    this.line({ ...rung, ...(kept.count > 1 ? { found: kept.count } : {}) })
    kept.at = now
    kept.count = 0
  }

  private line(rung: HookRung): void {
    this.opts.tell({ type: 'hook_rung', detail: rung })
  }

  /** One of the window's own answers, never allowed to throw a delivery over. */
  private asked<T>(read: () => T, safe: T): T {
    try {
      return read()
    } catch (err) {
      this.opts.tell({
        type: 'warning',
        detail: { message: `the doorbell could not ask the window something: ${String(err)}` },
      })
      return safe
    }
  }
}

/**
 * The raw body, or null where it is larger than `most` — read to its end all
 * the same, without keeping it, so the connection is left where the next
 * request can use it. Counted as it arrives: a declared length is a claim.
 */
async function bounded(req: IncomingMessage, most: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size <= most) chunks.push(bytes)
  }
  return size > most ? null : Buffer.concat(chunks)
}
