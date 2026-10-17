import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { LanePointing, LaneScreen, LaneScrolling } from '@tade/drivers-core'
import { type Frame, type Order, type Report, WATCH_MS } from './protocol.ts'

// @xterm/headless is CommonJS with no ESM named exports.
const { Terminal } = createRequire(import.meta.url)(
  '@xterm/headless',
) as typeof import('@xterm/headless')

type XTerm = InstanceType<typeof Terminal>

// The emulators: one headless xterm per lane, keeping the screen a capture
// reads. They run on a thread of their own (`emulator-thread.ts`), and this
// file is what runs there — nothing in it knows it is in a worker, so a test
// can drive it in place.
//
// They used to run on the thread that draws the window, and that was the
// largest single cost Tade had: every byte every agent printed was parsed
// there, in twelve-millisecond slices per lane, interleaved with the draw and
// with every key you pressed — for every lane, always, not only the one in
// front of you. And every lane's screen buffer, thirty megabytes at ten
// thousand lines, sat in the window's heap for its collector to walk.
//
// What crosses between the two threads is said once, in `protocol.ts`: the
// driver's orders, in the order things happened to the lane, and the emulators'
// reports. A screen is never asked for and waited on while the window draws.
// It is pushed — once it has settled, for a lane somebody is looking at — so
// a capture is answered from a frame that is already there, which is the
// same "last whole frame" a capture always fell back to (`Frame.whole`).

interface Emulated {
  term: XTerm | null
  /** The newest order that changed this screen. */
  received: number
  /** Output handed to the emulator and not yet parsed, oldest first. */
  unparsed: number[]
  /** When the program wrote the newest of it, as the driver saw it. */
  lastAt: number
  /**
   * What a capture of this lane asks, while somebody keeps asking.
   *
   * A frame is built only for a lane somebody is looking at: building one is
   * reading every cell of it, and a lane nobody looks at would be paying that
   * on every repaint for a picture nobody draws. It runs out on its own, so a
   * driver that stopped asking — a pane closed, a lane scrolled out of view —
   * stops costing anything without having to say so.
   */
  watch: { lines: number; styled: boolean; until: number } | null
  /** The last frame pushed, to tell a new one from the same one again. */
  pushed: { seq: number; lines: number; styled: boolean; whole: boolean } | null
  pushedAt: number
  pumping: boolean
}

/**
 * The least time between two frames pushed for one lane.
 *
 * A lane streaming flat out settles every time a slice is parsed, which is
 * hundreds of frames a second; the window draws a few dozen. The first frame
 * after a quiet spell goes at once — a keystroke echoed is never held back —
 * and only a lane that keeps on printing is paced.
 */
const PUSH_MS = 16

/** How long a frame being drawn is waited for before the screen is read anyway. */
export const FRAME_WAIT_MS = 50

/**
 * How long a lane has to have stopped writing before its screen is read as a
 * whole frame, where the program never said where its frames begin.
 *
 * Measured off Claude Code answering a wheel at 120x40: it rewrites every row,
 * the repaint reaches the pty as three to six writes over two to seven
 * milliseconds with gaps of 1.1ms to 3.9ms inside it, and then some twenty
 * milliseconds of quiet. Five is past every gap inside a frame and well short
 * of the gap between two, which is what makes "it has stopped writing" mean
 * "it has finished drawing" without ever having been told.
 */
const QUIET_MS = 5

/**
 * How long a screen still being written is waited on, at most.
 *
 * Its own bound rather than `FRAME_WAIT_MS`, because the two failures are not
 * the same. A synchronized update that never ends is a program misbehaving and
 * fifty milliseconds is the price of finding out. A lane that never goes quiet
 * is a program *streaming* rather than drawing frames, which is an ordinary
 * thing for one to do — and then there is no frame to wait for and being late
 * is the only thing waiting buys. Three of the longest repaints measured.
 */
const QUIET_WAIT_MS = 20

export class Emulators {
  private readonly lanes = new Map<number, Emulated>()
  private readonly tell: (report: Report) => void

  constructor(tell: (report: Report) => void) {
    this.tell = tell
  }

  take(order: Order): void {
    switch (order.do) {
      case 'open':
        this.open(order)
        return
      case 'data': {
        const lane = this.lanes.get(order.key)
        if (!lane?.term) return
        lane.received = order.seq
        lane.lastAt = order.at
        write(lane, order.seq, order.data)
        if (watched(lane)) void this.pump(order.key, lane)
        return
      }
      case 'resize': {
        const lane = this.lanes.get(order.key)
        if (!lane?.term) return
        lane.received = order.seq
        lane.term.resize(order.cols, order.rows)
        if (watched(lane)) void this.pump(order.key, lane)
        return
      }
      case 'watch':
        this.watch(order.key, order.lines, order.styled)
        return
      case 'look':
        void this.look(order.key, order.ask)
        return
      case 'release':
        this.release(order.key)
        return
      case 'held':
        collect()
        this.tell({ is: 'held', ask: order.ask, bytes: process.memoryUsage().arrayBuffers })
        return
    }
  }

  private open(order: Extract<Order, { do: 'open' }>): void {
    // A key is never used twice, so one already here is the same lane told
    // twice — the driver starting these again after they died — and the
    // screen it has is the one to keep.
    if (this.lanes.has(order.key)) return
    const lane: Emulated = {
      term: new Terminal({
        cols: order.cols,
        rows: order.rows,
        scrollback: order.scrollback,
        allowProposedApi: true,
      }),
      received: order.seq,
      unparsed: [],
      lastAt: 0,
      watch: null,
      pushed: null,
      pushedAt: 0,
      pumping: false,
    }
    this.lanes.set(order.key, lane)
    if (order.seed !== '') write(lane, order.seq, order.seed)
  }

  private watch(key: number, lines: number, styled: boolean): void {
    const lane = this.lanes.get(key)
    if (!lane?.term) return
    lane.watch = { lines, styled, until: Date.now() + WATCH_MS }
    // Asked again about a screen it has already been sent, or is being sent:
    // only kept watching. Anything newer starts a frame of its own.
    const pushed = lane.pushed
    const sent =
      pushed?.whole === true &&
      pushed.lines === lines &&
      pushed.styled === styled &&
      pushed.seq === current(lane) &&
      pushed.seq === lane.received
    if (!sent) void this.pump(key, lane)
  }

  /**
   * Push a frame of a watched lane once it has settled, and again for as long
   * as more keeps arriving — at most one every `PUSH_MS`.
   *
   * One at a time per lane: output arriving meanwhile is not a second pump,
   * it is a reason for this one to go round again.
   */
  private async pump(key: number, lane: Emulated): Promise<void> {
    if (lane.pumping) return
    lane.pumping = true
    try {
      for (;;) {
        const early = lane.pushedAt + PUSH_MS - Date.now()
        if (early > 0) await pause(early)
        if (!lane.term || !watched(lane)) return
        const whole = await settled(lane)
        const asked = lane.watch
        if (!lane.term || !asked) return
        const seq = current(lane)
        const pushed = lane.pushed
        // A frame the wait ran out on is pushed even where it is the same one
        // again: a capture handed one waits for the next try rather than
        // drawing it, and a try nobody hears about is a capture left waiting.
        if (
          !whole ||
          pushed?.seq !== seq ||
          pushed.whole !== whole ||
          pushed.lines !== asked.lines ||
          pushed.styled !== asked.styled
        ) {
          this.tell({
            is: 'frame',
            key,
            seq,
            whole,
            ...frameOf(lane.term, asked.lines, asked.styled),
          })
          lane.pushed = { seq, lines: asked.lines, styled: asked.styled, whole }
          lane.pushedAt = Date.now()
        }
        // Done once a whole frame holds everything ordered so far. A frame
        // the wait ran out on is tried again, because a screen torn by a
        // program that has since stopped is about to be whole, and handing
        // that one over is the whole point.
        if (whole && lane.received === seq) return
      }
    } finally {
      lane.pumping = false
    }
  }

  /**
   * The numbers beside a screen — how deep it is, where the cursor is, whose
   * the scrolling and the pointer are — parsed, and never waited on for a
   * whole frame.
   *
   * A capture waits for one because two frames mixed is a picture nobody
   * drew. None of these is a picture: a frame half drawn has not moved any of
   * them — the rows it rewrote are the rows it already had, so the depth and
   * the cursor are where they were, and on the alternate screen the depth is
   * the height of the screen whatever is on it. Waiting anyway was most of
   * what a look cost: a lane repainting in place never goes quiet, so the
   * wait ran to its bound every time, for an answer that came back the same
   * thirty times out of thirty.
   */
  private async look(key: number, ask: number): Promise<void> {
    const lane = this.lanes.get(key)
    if (lane?.term) await parsed(lane)
    const term = lane?.term
    if (!lane || !term) {
      this.tell({ is: 'view', key, ask, seq: -1, view: null })
      return
    }
    this.tell({ is: 'view', key, ask, seq: current(lane), view: viewOf(term) })
  }

  /**
   * Everything a closed lane can never be asked for again.
   *
   * `reset()` before `dispose()`, because disposing does not drop what has
   * been written to the emulator and not yet parsed, and a queued chunk holds
   * the whole screen behind it: xterm parses in the background off a chain of
   * `setTimeout(() => this._innerWrite())`, and that closure reaches the write
   * buffer, its parse action, the input handler and every `Uint32Array` of the
   * buffer. Letting go of the reference is then not letting go of anything —
   * 1KB still queued kept 24MB of screen alive, until the backlog happened to
   * drain. Resetting empties the buffers first, so what the leftover parse
   * holds is a fresh, empty one.
   */
  private release(key: number): void {
    const lane = this.lanes.get(key)
    this.lanes.delete(key)
    if (!lane) return
    lane.term?.reset()
    lane.term?.dispose()
    lane.term = null
    lane.watch = null
  }
}

function write(lane: Emulated, seq: number, data: string): void {
  lane.unparsed.push(seq)
  lane.term?.write(data, () => {
    lane.unparsed.shift()
  })
}

/**
 * The newest order every bit of which is on the screen: everything before the
 * oldest output still being parsed. A resize is on it the moment it arrives.
 */
function current(lane: Emulated): number {
  const oldest = lane.unparsed[0]
  return oldest === undefined ? lane.received : oldest - 1
}

function watched(lane: Emulated): boolean {
  return lane.watch !== null && lane.watch.until > Date.now()
}

/**
 * Collect, where whoever started this process allowed it, so that what is only
 * *reachable* is not counted as *held*. Nobody does but a test measuring what
 * a closed lane gives back: the flag is the process's, and the context that
 * reads it has to be made after it was set.
 */
function collect(): void {
  const gc = runInNewContext('typeof gc === "function" ? gc : undefined') as
    | (() => void)
    | undefined
  gc?.()
  gc?.()
}

/**
 * Wait until the screen is one its program meant to show: everything that has
 * arrived parsed — the emulator parses in the background — and no redraw half
 * applied. Read in between, the screen is the last frame torn by the next: a
 * line blinking, text interleaved with what was there. Bounded both ways, so
 * neither a program that begins an update and never ends it nor one that never
 * stops printing can hold a frame back for ever.
 *
 * Where a frame begins is **declared** by a program that draws in synchronized
 * updates (DEC 2026 — pi does, every frame), and then the boundary is a fact
 * and this waits for it. One that repaints the whole screen in place and says
 * nothing (Claude Code emits no 2026 at all, checked at 2.1.267) leaves no
 * boundary to honour, and the only one left is the write itself stopping —
 * `QUIET_MS`. That is a guess, so it is made only where a tear is possible at
 * all: on the alternate screen, where rows are rewritten under each other. A
 * lane that prints and keeps what it printed cannot tear — mid-append it shows
 * a part-written last line, which its own terminal shows too — and pays none
 * of this.
 *
 * True when the screen is a whole frame, false when the wait ran out and it
 * may be two frames mixed.
 */
async function settled(lane: Emulated, ms = FRAME_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + ms
  const quietBy = Date.now() + QUIET_WAIT_MS
  for (;;) {
    // Parsed is asked of the parse, never of the clock. Either the wait's own
    // empty write answered, or nothing that arrived is still waiting — xterm
    // parses in slices of twelve milliseconds and puts the rest behind a
    // timer, so on a thread that was preempted the empty write can come after
    // the deadline with everything before it already on the screen.
    const done = (await parsed(lane, deadline)) || lane.unparsed.length === 0
    const term = lane.term
    if (!term || !done) return false
    // Everything that arrived is on a screen nothing can tear, and that is a
    // whole frame however late the parse answered: asked of the clock, a
    // machine too loaded to answer in time called it torn, and a capture threw
    // it away to wait for the same screen again.
    if (!term.modes.synchronizedOutputMode && term.buffer.active.type !== 'alternate') return true
    if (Date.now() >= deadline) return false
    if (term.modes.synchronizedOutputMode) {
      await pause(2)
      continue
    }
    const since = Date.now() - lane.lastAt
    if (since >= QUIET_MS) return true
    if (Date.now() >= quietBy) return false
    await pause(QUIET_MS - since)
  }
}

/**
 * Everything that has arrived, parsed — the emulator parses in the background,
 * so a screen read without this is one missing whatever is still queued.
 *
 * Bounded, so a parser that never drains cannot hold anything for ever. This is
 * the whole of what a reading needs to be *current*; waiting for it to be a
 * whole *frame* is `settled`, and only a frame needs that. True where the parse
 * answered, false where the deadline did.
 */
async function parsed(lane: Emulated, until?: number): Promise<boolean> {
  const deadline = until ?? Date.now() + FRAME_WAIT_MS
  const left = Math.max(0, deadline - Date.now())
  // The deadline is taken back the moment the parse wins the race, which is
  // nearly every time. Left to expire on its own it is a timer and a closure
  // per frame, every one of them sitting in the timer list for the fifty
  // milliseconds it takes to find out nobody needed it.
  let late: NodeJS.Timeout | null = null
  try {
    // A lane released meanwhile never answers: the wait is bounded either way.
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        try {
          if (lane.term) lane.term.write('', () => resolve(true))
          else resolve(true)
        } catch {
          resolve(true)
        }
      }),
      new Promise<boolean>((resolve) => {
        late = setTimeout(() => resolve(false), left)
      }),
    ])
  } finally {
    if (late) clearTimeout(late)
  }
}

/** A wait with nothing racing it, so the timer goes when it fires. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The screen a capture asked for, and the numbers beside it. */
function frameOf(
  term: XTerm,
  lines: number,
  styled: boolean,
): Pick<Frame, 'lines' | 'styled' | 'rows' | 'alternate' | 'view'> {
  const buffer = term.buffer.active
  // From the bottom up: past the blank rows under the last thing written,
  // then only the rows asked for. Above them can be ten thousand lines of
  // scrollback, and painting every one of them to keep the last forty was
  // most of what echoing a keystroke cost.
  const last = lastWritten(buffer, term.rows)
  // One cell object for the whole frame, loaded in place for every cell,
  // which is what xterm's own typings ask of anybody reading a lot of them.
  // A 200-column pane kept forty rows, several times a second, and every
  // cell of every one of them was a short-lived object: ten thousand a
  // frame, thrown away as fast as they were made.
  const cell = buffer.getNullCell()
  const rows: string[] = []
  for (let i = Math.max(0, last - lines + 1); i <= last; i++) {
    const row = buffer.getLine(i)
    rows.push(row ? (styled ? styledLine(row, term.cols, cell) : row.translateToString(true)) : '')
  }
  return {
    lines,
    styled,
    rows: rows.join('\n'),
    alternate: buffer.type === 'alternate',
    view: viewOf(term, last),
  }
}

/**
 * How deep the screen is, where typing lands, and whose the scrolling and the
 * pointer are — measured exactly as a frame measures it, from the same last
 * row it would end on: a depth and a cursor that disagree with the text draw
 * a scrollbar and a block in the wrong places.
 */
function viewOf(term: XTerm, last = lastWritten(term.buffer.active, term.rows)): LaneScreen {
  const buffer = term.buffer.active
  return {
    lines: last + 1,
    cursor: { back: last - (buffer.baseY + buffer.cursorY), column: buffer.cursorX },
    scrolling: scrollingOf(buffer.type, term.modes.mouseTrackingMode),
    pointing: pointingOf(term.modes.mouseTrackingMode),
  }
}

/**
 * The last row with anything on it, counting the scrollback: where a capture
 * ends, and what the cursor and the depth are both measured against. Read from
 * the bottom up, because under the last thing written is usually blank screen.
 *
 * Except on the alternate screen, where the blank rows are the picture. A
 * program that took the screen is drawing a rectangle exactly `rows` tall and
 * chose what to leave empty in it: the space under a short menu, the gap above
 * a status bar, the blank last line every full-screen editor keeps. Trimmed,
 * that rectangle comes back shorter than the pane it is drawn into, and
 * shorter by a different amount every frame as the content changes — so the
 * whole screen slides up and down under itself. Measured on a twelve-row
 * pane: every capture short, every one of them reporting a cursor *below* the
 * last row it returned.
 *
 * On the normal screen the rule stands as it was. Under the last line a
 * program printed is screen it has not used, drawing it would waste the rows,
 * and the cursor sitting one row into it is what `cursor.back` of -1 means.
 */
function lastWritten(buffer: import('@xterm/headless').IBuffer, rows: number): number {
  const bottom = buffer.baseY + rows - 1
  if (buffer.type === 'alternate') return bottom
  let last = bottom
  while (last >= 0 && (buffer.getLine(last)?.translateToString(true).trim() ?? '') === '') last--
  return last
}

/**
 * Whose the scrolling is, from what the program in the lane has done to its
 * terminal: took the screen for itself, and asked for the mouse or not.
 *
 * The alternate screen is what decides, because it is what says there is no
 * scrollback: a program that prints keeps every line it printed whether or
 * not it also wants the mouse, and those lines are the window's to move.
 */
function scrollingOf(
  buffer: 'normal' | 'alternate',
  mouse: import('@xterm/headless').IModes['mouseTrackingMode'],
): LaneScrolling {
  if (buffer !== 'alternate') return 'window'
  return mouse === 'none' ? 'nobody' : 'lane'
}

/**
 * How much of the pointer the program has asked for, in the window's words
 * rather than the emulator's.
 *
 * The old `x10` asked for presses and not even releases; it is read as
 * `press` and told about both, because a program that does not want a release
 * report drops one and nothing this decade asks for that mode at all —
 * whereas a `press` that lost its release would leave a button held down for
 * ever.
 */
function pointingOf(mouse: import('@xterm/headless').IModes['mouseTrackingMode']): LanePointing {
  if (mouse === 'none') return 'nobody'
  // `drag` is movement with a button held; `any` is every movement, which is
  // more than the window ever sends and so is handed over as the same thing.
  return mouse === 'drag' || mouse === 'any' ? 'drag' : 'press'
}

type BufferLine = NonNullable<ReturnType<import('@xterm/headless').IBuffer['getLine']>>
type BufferCell = NonNullable<ReturnType<BufferLine['getCell']>>

/**
 * One row of the screen with its paint, as SGR.
 *
 * Built from the cells rather than kept from the byte stream: the stream is
 * full of cursor moves and clears that would scramble whatever draws it, and
 * the cells are what the screen actually shows. A new sequence is written
 * only where the paint changes, and trailing blank cells go.
 *
 * `cell` is the caller's one cell object, loaded in place by every `getCell`
 * and read before the next one overwrites it — never held on to.
 */
function styledLine(row: BufferLine, cols: number, cell: BufferCell): string {
  let out = ''
  let paint = ''
  let pending = ''
  /**
   * The blank cells held back, now that something follows them — and the run
   * before them closed first.
   *
   * A blank cell with no paint of its own is still a cell with no paint on
   * it. Written while the run before it is open, it takes that run's ground:
   * the gap between two buttons comes back as one band of colour with the
   * labels sitting in it, and so does every window drawn from a capture of
   * one. So the reset goes before the spaces, not after them.
   */
  const gap = () => {
    if (pending === '') return
    if (paint !== '') {
      out += '\x1b[0m'
      paint = ''
    }
    out += pending
    pending = ''
  }
  for (let x = 0; x < cols; x++) {
    // The answer is `cell` itself, so nothing is taken from the return but
    // whether there was a cell there at all.
    if (!row.getCell(x, cell) || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    const next = sgrOf(cell)
    if (chars === ' ' && next === '') {
      // Held back: blank cells only count if something follows them.
      pending += ' '
      continue
    }
    gap()
    if (next !== paint) {
      out += `\x1b[0${next}m`
      paint = next
    }
    out += chars
  }
  return paint === '' ? out : `${out}\x1b[0m`
}

function sgrOf(cell: BufferCell): string {
  const codes: string[] = []
  if (cell.isBold()) codes.push('1')
  if (cell.isDim()) codes.push('2')
  if (cell.isItalic()) codes.push('3')
  if (cell.isUnderline()) codes.push('4')
  if (cell.isInverse()) codes.push('7')
  if (cell.isFgPalette()) codes.push(`38;5;${cell.getFgColor()}`)
  else if (cell.isFgRGB()) codes.push(`38;2;${rgb(cell.getFgColor())}`)
  if (cell.isBgPalette()) codes.push(`48;5;${cell.getBgColor()}`)
  else if (cell.isBgRGB()) codes.push(`48;2;${rgb(cell.getBgColor())}`)
  return codes.length === 0 ? '' : `;${codes.join(';')}`
}

function rgb(colour: number): string {
  return `${(colour >> 16) & 255};${(colour >> 8) & 255};${colour & 255}`
}
