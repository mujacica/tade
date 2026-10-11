import type { Frame } from '../frame.ts'
import { type Hit, shift } from '../hits.ts'
import { type AppState, SPIN_MS } from '../model.ts'
import type { Regions } from '../selection.ts'
import { type Drawn, fit, shiftRegions } from '../ui.ts'

// The regions the last frame drew, and what each was drawn from.
//
// `draw` composes five regions, and a frame is asked for whenever any one
// thing on screen moved: a lane printing in front of you is a frame every
// thirty-three milliseconds, and in every one of them the top, the side, the
// strip and the foot were drawn again from inputs that had not changed. So a
// region whose inputs are the ones it was last drawn from is handed back as
// it was — the same `Drawn`, its hits and its regions included, so nothing
// about where things are or what scrolls can differ between a region drawn
// and a region kept. "How much is in view is the rows the region drew" holds
// because they are the rows it drew.
//
// **What a region was drawn from is recorded while it draws, never listed.**
// A list of the fields each region reads would be right on the day it was
// written, and a field read on a path no screen happens to exercise would be a
// region that never redraws when it should — the one way this can go wrong,
// and silently. So the region is handed `state` and `frame` behind a proxy
// that writes down every field it asks for, and on the next frame exactly
// those fields are compared. A field it did not read cannot have changed what
// it drew; a field it did read that changed means drawing it again.
//
// **Compared as data, to a depth, and by identity past it.** State moves by
// replacement, so a field nobody touched is the same object. The frame is
// folded afresh every time and several subjects hand back a new `{ held,
// problem }` with the same two values in it, which compared by identity would
// never be the same twice. Plain objects and arrays are compared member by
// member, `DEPTH` levels down; anything else — a `Map`, a function, a class —
// only by identity, because a `Map` has no members `Object.keys` can see and
// two different ones would compare equal. Which is the rule a subject has to
// keep: **nothing handed to the frame is changed in place**. A held `Map`
// that is written into rather than replaced is the same object with other
// contents, and a region kept over it is a region showing the past.
// `checked` exists to catch exactly that.
//
// **`checked`** draws every kept region again anyway and throws where the two
// differ. The wire tests run the whole window under it, against real
// subjects, so a subject that changes something in place fails a test that
// never thought about this file.
//
// Pure, and owned by whoever draws repeatedly: `draw` without one draws
// everything, which is what the goldens and the bench's per-screen figures are.

/**
 * The five regions a window is composed of, in the order `draw` composes them.
 *
 * The bench times the same five (`test/bench.ts`), and `frame-cost.probe.test.ts`
 * holds this list to what `view.ts` imports, so a sixth region is one nobody
 * can add without saying whether it is kept.
 */
export const REGIONS = ['top', 'sidebar', 'main', 'strip', 'foot'] as const

export type RegionName = (typeof REGIONS)[number]

/**
 * The moment a frame is drawn for: `now`, to the spinner's resolution.
 *
 * Every region but the pane reads the clock — a spinner, a count of seconds,
 * how long until a plan resets — so a frame's moment, read to the
 * millisecond, is a field that is different in every frame, and nothing that
 * read it could ever be kept. The finest thing drawn from it is the spinner,
 * which turns every `SPIN_MS` on the same boundaries this rounds to, so
 * nothing it shows moves; what does is a count of seconds, which ticks up to a
 * tenth of a second late. It is also what `turnedSince` already calls a frame
 * worth drawing, so a frame and its news agree about what time it is.
 *
 * Rounded in `draw` whether or not anything is kept, so a region kept and the
 * same region drawn again are the same drawing — which is what `checked`
 * holds them to.
 */
export function drawnFor(now: number): number {
  return Math.floor(now / SPIN_MS) * SPIN_MS
}

/**
 * How far down two plain values are compared member by member before identity
 * has to do.
 *
 * Deep enough for what the subjects fold afresh each frame — a route, a
 * spend, a lane's screen and its cursor — and shallow enough that a list of a
 * hundred fresh rows is compared once each and not walked all the way down.
 * Deeper only costs comparing; shallower only costs drawing again.
 */
export const DEPTH = 4

/** Whether something is a bag of fields, rather than a thing with behaviour. */
function plain(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Whether two values would draw the same: the same thing, or plain data with
 * the same members, `depth` levels down.
 */
export function same(a: unknown, b: unknown, depth = DEPTH): boolean {
  if (Object.is(a, b)) return true
  if (depth <= 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], depth - 1)) return false
    return true
  }
  if (!plain(a) || !plain(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false
    if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1))
      return false
  }
  return true
}

/**
 * What a region read of one object while it drew: each field it asked for and
 * what it found, each field it asked *about*, and whether it asked for all of
 * them — which a spread or `Object.keys` does, and which makes the whole
 * object what it was drawn from.
 */
class Reading<T extends object> {
  private readonly of: T
  private readonly fields = new Map<PropertyKey, unknown>()
  private readonly asked = new Map<PropertyKey, boolean>()
  private whole = false
  /** The object as the region is handed it. */
  readonly seen: T

  constructor(of: T) {
    this.of = of
    // First read wins: the value a field had when the region drew from it.
    // Nothing changes the object while it draws, so a second read would find
    // the same — but the first is the one the drawing was made of.
    this.seen = new Proxy(of, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver)
        if (!this.fields.has(key)) this.fields.set(key, value)
        return value
      },
      has: (target, key) => {
        const there = Reflect.has(target, key)
        if (!this.asked.has(key)) this.asked.set(key, there)
        return there
      },
      getOwnPropertyDescriptor: (target, key) => {
        const own = Reflect.getOwnPropertyDescriptor(target, key)
        if (!this.asked.has(key)) this.asked.set(key, own !== undefined)
        return own
      },
      ownKeys: (target) => {
        this.whole = true
        return Reflect.ownKeys(target)
      },
    })
  }

  /** Whether `next` holds what this drawing was made of. */
  still(next: T): boolean {
    if (this.whole && !same(this.of, next)) return false
    const fields = next as Record<PropertyKey, unknown>
    for (const [key, value] of this.fields) if (!same(value, fields[key])) return false
    for (const [key, there] of this.asked) if (key in next !== there) return false
    return true
  }

  /** The fields read, for saying why a region was drawn again. */
  changed(next: T): string[] {
    const fields = next as Record<PropertyKey, unknown>
    const out: string[] = []
    if (this.whole && !same(this.of, next)) out.push('*')
    for (const [key, value] of this.fields) if (!same(value, fields[key])) out.push(String(key))
    for (const [key, there] of this.asked) if (key in next !== there) out.push(`${String(key)}?`)
    return out
  }
}

/** One region as the last frame drew it. */
interface Last {
  args: readonly unknown[]
  state: Reading<AppState>
  frame: Reading<Frame>
  drawn: Drawn
}

/** How often a region was drawn, and how often it was handed back instead. */
export interface Tally {
  drawn: number
  kept: number
}

/** A drawing put somewhere: the same rows, its hits and regions moved there. */
interface Placed {
  row: number
  col: number
  hits: Hit[]
  regions: Regions
}

/** A drawing's rows, each made exactly `width` wide and `height` of them. */
interface Fitted {
  width: number
  height: number
  rows: string[]
}

export class LastFrame {
  private readonly last = new Map<RegionName, Last>()
  private readonly checked: boolean
  /** Where a drawing was last put, by the drawing: a kept region is placed once. */
  private readonly placings = new WeakMap<Drawn, Placed>()
  private readonly fittings = new WeakMap<Drawn, Fitted>()
  /** The body as last composed, and the two drawings and the divider it was composed of. */
  private body: { left: Drawn; right: Drawn; between: string; drawn: Drawn } | null = null
  private readonly tallies = new Map<RegionName, Tally>()
  /**
   * What made each region be drawn again, by field: the question a region that
   * never keeps asks. Kept only while `checked`, which is the only time anybody
   * is asking.
   */
  readonly why = new Map<string, number>()

  constructor(opts: { checked?: boolean } = {}) {
    this.checked = opts.checked === true
  }

  /**
   * The region `name`, drawn by `paint` from `state` and `frame` — or handed
   * back as the last frame drew it, where nothing it read has moved and it is
   * drawn with the same `args`.
   *
   * `args` are what `paint` was given besides the two: its size, the skin,
   * where the pointer is. They are compared the way the fields are.
   */
  region(
    name: RegionName,
    args: readonly unknown[],
    state: AppState,
    frame: Frame,
    paint: (state: AppState, frame: Frame) => Drawn,
  ): Drawn {
    const tally = this.tallies.get(name) ?? { drawn: 0, kept: 0 }
    this.tallies.set(name, tally)
    const last = this.last.get(name)
    if (last && same(last.args, args) && last.state.still(state) && last.frame.still(frame)) {
      tally.kept++
      if (this.checked) differs(name, last.drawn, paint(state, frame))
      return last.drawn
    }
    if (last && this.checked) this.noteWhy(name, last, args, state, frame)
    const read = { state: new Reading(state), frame: new Reading(frame) }
    const drawn = paint(read.state.seen, read.frame.seen)
    this.last.set(name, { args, ...read, drawn })
    tally.drawn++
    return drawn
  }

  /** How often each region was drawn and kept since this was made. */
  counts(): Partial<Record<RegionName, Tally>> {
    return Object.fromEntries(this.tallies)
  }

  /**
   * The hits and regions of `drawn`, moved down `row` and across `col` — once
   * per drawing and place, so a region kept is not moved again every frame.
   */
  placed(drawn: Drawn, row: number, col = 0): Placed {
    const was = this.placings.get(drawn)
    if (was && was.row === row && was.col === col) return was
    const placed = {
      row,
      col,
      hits: shift(drawn.hits, row, col),
      regions: shiftRegions(drawn.regions, row),
    }
    this.placings.set(drawn, placed)
    return placed
  }

  /** `drawn`'s first `height` rows, each fitted to exactly `width` columns. */
  fitted(drawn: Drawn, width: number, height: number): string[] {
    const was = this.fittings.get(drawn)
    if (was && was.width === width && was.height === height) return was.rows
    const rows = fittedRows(drawn, width, height)
    this.fittings.set(drawn, { width, height, rows })
    return rows
  }

  /**
   * The body as last composed, where it was composed of these two drawings
   * with this between them; otherwise `compose`'s, kept for the next frame.
   */
  composed(left: Drawn, right: Drawn, between: string, compose: () => Drawn): Drawn {
    const was = this.body
    if (was && was.left === left && was.right === right && was.between === between) return was.drawn
    const drawn = compose()
    this.body = { left, right, between, drawn }
    return drawn
  }

  private noteWhy(
    name: RegionName,
    last: Last,
    args: readonly unknown[],
    state: AppState,
    frame: Frame,
  ): void {
    const fields = [
      ...(same(last.args, args) ? [] : ['args']),
      ...last.state.changed(state).map((key) => `state.${key}`),
      ...last.frame.changed(frame).map((key) => `frame.${key}`),
    ]
    for (const field of fields) {
      const key = `${name}:${field}`
      this.why.set(key, (this.why.get(key) ?? 0) + 1)
    }
  }
}

/** `drawn`'s first `height` rows, each exactly `width` columns, missing ones blank. */
export function fittedRows(drawn: Drawn, width: number, height: number): string[] {
  return Array.from({ length: height }, (_, i) => fit(drawn.rows[i] ?? '', width))
}

/**
 * Throw where a region handed back is not the region drawing it again would
 * give: the one way keeping can be wrong, said in the words of what differed.
 */
function differs(name: RegionName, kept: Drawn, drawn: Drawn): void {
  const row = kept.rows.findIndex((text, i) => text !== drawn.rows[i])
  const what =
    kept.rows.length !== drawn.rows.length
      ? `it drew ${drawn.rows.length} rows where ${kept.rows.length} were kept`
      : row >= 0
        ? `row ${row} is ${JSON.stringify(drawn.rows[row])} and ${JSON.stringify(kept.rows[row])} was kept`
        : JSON.stringify(kept.hits) !== JSON.stringify(drawn.hits)
          ? 'its hits moved'
          : JSON.stringify(kept.regions ?? {}) !== JSON.stringify(drawn.regions ?? {})
            ? 'what it says scrolls moved'
            : null
  if (what === null) return
  throw new Error(
    `The ${name} region was kept from the last frame, and drawing it again says otherwise: ${what}. ` +
      'Something it reads was changed in place rather than replaced (view/last-frame.ts).',
  )
}
