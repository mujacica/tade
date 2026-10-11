import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { RENDER_FLOOR_MS, WRITE_SHARE } from '../../src/pace.ts'
import { POINTS, probing, Timings } from '../../src/timing.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What the window costs to keep a lane on screen, and what it owes it.
//
// Two things are true at once here and each hid the other. The window must not
// read a lane oftener than anyone can read the result — the beat is four times
// a second, and a lane that prints asks to be looked at sooner, which is what
// puts a keystroke on screen as you type it. And it must not read it *less*
// often than the lane changes, which is the part that looks like a saving
// right up until the pane stops moving.
//
// A lane that redraws in place is where they meet. It prints flat out and the
// lane never gets any deeper, so the lines held of it always reach — and the
// window read one screen, drew it, and went on drawing it for as long as you
// watched. Cheapest possible loop, and a photograph. Not a rare shape either:
// it is every progress bar, every spinner, every `npm install`.
//
// So the ceiling is asserted, and so is the floor under it — never as a rate
// the machine has to hit, which a busy CI would miss for reasons of its own,
// but as the pane having moved at all.

/** A lane that redraws its screen in place as fast as it can, printing nothing new. */
const REPAINTER = `
const ROWS = 24
let n = 0
setInterval(() => {
  n++
  let out = ''
  for (let r = 0; r < ROWS; r++) {
    out += '\\x1b[' + (r + 1) + ';1H\\x1b[2K'
    out += 'REPAINTING ' + n + ' row ' + r + ' ' + 'x'.repeat(40)
  }
  process.stdout.write(out)
}, 8)
`

/**
 * A lane that writes the same screen over itself as fast as it can: printing
 * flat out, so the window looks as often as it ever does, and drawing nothing
 * new — every look reads exactly the screen the last one did.
 */
const STANDING_STILL = `
const ROWS = 24
setInterval(() => {
  let out = ''
  for (let r = 0; r < ROWS; r++) out += '\\x1b[' + (r + 1) + ';1HSTANDING STILL row ' + r
  process.stdout.write(out)
}, 8)
`

/** Every spinner frame the orchestrator's tab was drawn with in `written`. */
function turnsIn(written: string): Set<string> {
  return new Set(
    Array.from(written.matchAll(/orchestrator ([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/g), (one) => one[1] ?? ''),
  )
}

/** What the lane has repainted, as the window has drawn it. Null while nothing is. */
function repaintShown(terminal: FakeTerminal): number | null {
  for (const row of screenOf(terminal.written)) {
    const found = /REPAINTING (\d+) row 0/.exec(row)
    if (found) return Number(found[1])
  }
  return null
}

describe('what the frame loop costs', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let root: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    root = wired.repo.root
  })

  it('keeps up with a lane that repaints in place, without reading it away', async () => {
    // Every read of a lane's screen, counted where the window asks for one.
    // Frames drawn would say more about the renderer, which throttles its own
    // drawing; what a look costs is reading the lanes in front of you.
    let reads = 0
    const asked = client.capture.bind(client)
    client.capture = ((...args: Parameters<typeof asked>) => {
      reads++
      return asked(...args)
    }) as typeof client.capture

    const opened = await client.openTerminal({ project: 'app' })
    // Through a file rather than `node -e`: the program is full of escapes,
    // and a quoting mistake exits the shell instead of running anything —
    // which reads here as a window that simply never got busy.
    const script = join(root, 'repaint.cjs')
    writeFileSync(script, REPAINTER)
    await client.write(opened.id, `exec node ${script}\r`)
    // The beat the window really has. The harness runs it faster so tests do
    // not wait, and a probe about the beat has to use the one people get.
    await start({ frameMs: 250 })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the lane repainting in front of us', () => repaintShown(terminal) !== null)

    const was = repaintShown(terminal)
    const from = reads
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const now = repaintShown(terminal)
    const each = (reads - from) / ((Date.now() - started) / 1000)

    // The pane moved. Held lines answering for the live screen drew the same
    // number for the whole two seconds, however many times the lane repainted.
    expect(was).not.toBeNull()
    expect(now, 'the pane is drawing a photograph of the lane').toBeGreaterThan(was ?? 0)

    // And it did not read it flat out. One look reads the lane in front of you
    // once; thirty a second is the floor the loop keeps and four is the beat,
    // so forty-five leaves room for a look landing either side of a boundary.
    // A loop with nothing under it reads as fast as a look happens to cost,
    // which measured fifty-eight a second on a quiet machine — a rate that
    // depends on nothing anybody chose.
    expect(each, `${each.toFixed(1)} screen reads a second`).toBeLessThan(45)
  })

  // The other half of the same hazard, from the drawing's side. A look that
  // read nothing new used to be drawn anyway while anything worked — and with
  // a lane printing in front of you that was a frame every 33ms to move a
  // spinner that moves every 100. Asked instead whether the spinner on screen
  // is the one it would draw now, the window draws ten a second.
  //
  // So a ceiling, and a floor under it that fails loudly where a frame is
  // missed: the spinner has to have *turned* on screen while nothing else did.
  // The ceiling is a rate, never a rate the machine has to reach: a starved
  // runner looks less often and draws fewer frames, which passes, and the floor
  // is the spinner having moved at all over the wait, never how many times.
  it('draws a turning spinner as often as it turns, over a lane that prints nothing new', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      const opened = await client.openTerminal({ project: 'app' })
      const script = join(root, 'still.cjs')
      writeFileSync(script, STANDING_STILL)
      await client.write(opened.id, `exec node ${script}\r`)
      // A turn that never ends until the test is over: the spinner on the
      // orchestrator's tab turns for as long as this waits.
      await start({ frameMs: 250, thinker: { ask: () => new Promise<string>(() => {}) } })
      await until('the first frame', () => terminal.written.includes('refunds'))
      terminal.press('\x00')
      for (const char of 'what is going on') terminal.press(char)
      terminal.press('\r')
      await until('the orchestrator to be on a turn', () => turnsIn(terminal.written).size > 0)
      const tab = find('terminal 1')
      click(tab.col + 1, tab.row)
      await until('the lane standing still in front of us', () =>
        screenOf(terminal.written).some((row) => row.includes('STANDING STILL row 0')),
      )

      const from = timings.spans().draw?.count ?? 0
      const mark = terminal.written.length
      const started = Date.now()
      // The floor: it turns, on screen, while the lane in front says nothing
      // new — through every one of its ten frames. Not "it changed once": the
      // status beat redraws every two seconds on its own, and a frame drawn
      // only by that lands on the same glyph each time, twenty spinner frames
      // later. So a gate that never passes for the spinner waits here until
      // the deadline, and says what for.
      await until('the spinner to turn through all ten of its frames', () => {
        return turnsIn(terminal.written.slice(mark)).size === 10
      })
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 2_000 - Date.now())))
      const frames = ((timings.spans().draw?.count ?? 0) - from) / ((Date.now() - started) / 1000)
      // The ceiling: ten a second for the spinner, and room for the frames a
      // status beat and a git look ask for on their own. Thirty-three is what
      // the old gate drew here, one for every look.
      expect(frames, `${frames.toFixed(1)} frames a second`).toBeLessThan(16)
    } finally {
      stop()
    }
  })

  // The terminal as the one that cannot keep up. On POSIX a write to a TTY
  // blocks until the terminal has taken it, so a starved terminal emulator
  // puts its slowness on the window's own thread: a frame every thirty-three
  // milliseconds into a terminal that takes forty to accept each one is a
  // window doing nothing but waiting to be allowed to draw.
  //
  // Scripted here as a write that holds the thread, which is exactly what the
  // real one does. The ceiling is the window drawing less often than it would
  // have — never a rate it has to reach, so a starved runner passes — and the
  // floor under it is the lane still moving on screen while it backs off, then
  // the pace coming all the way back down once the terminal is quick again:
  // said once, over a wait.
  it('draws less often into a terminal that is slow to take a frame, and recovers', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      let slow = 0
      const write = terminal.write.bind(terminal)
      terminal.write = (data: string) => {
        const until = performance.now() + slow
        while (performance.now() < until) {
          // Holding the thread, as a blocking write(2) does.
        }
        write(data)
      }
      const opened = await client.openTerminal({ project: 'app' })
      const script = join(root, 'repaint.cjs')
      writeFileSync(script, REPAINTER)
      await client.write(opened.id, `exec node ${script}\r`)
      await start({ frameMs: 250 })
      await until('the first frame', () => terminal.written.includes('refunds'))
      const tab = find('terminal 1')
      click(tab.col + 1, tab.row)
      await until('the lane repainting in front of us', () => repaintShown(terminal) !== null)
      // A terminal that keeps up is given every frame it was given before.
      expect(timings.span('pace')?.worst).toBe(RENDER_FLOOR_MS)

      slow = 40
      await until(
        'the window to back off',
        () => (timings.span('pace')?.worst ?? 0) * WRITE_SHARE >= slow,
      )
      const was = repaintShown(terminal)
      const from = timings.span('doRender')?.count ?? 0
      const started = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const frames =
        ((timings.span('doRender')?.count ?? 0) - from) / ((Date.now() - started) / 1000)
      // Unpaced, a forty-millisecond write under a lane asking thirty times a
      // second draws about twenty frames a second and spends four fifths of
      // it in the write. Paced, the write gets half of each interval at most.
      expect(frames, `${frames.toFixed(1)} frames a second`).toBeLessThan(12)
      expect(repaintShown(terminal), 'the pane stopped moving').toBeGreaterThan(was ?? 0)

      slow = 0
      timings.clear()
      await until(
        'the pace back at the floor',
        () => timings.span('pace')?.best === RENDER_FLOOR_MS,
      )
    } finally {
      stop()
    }
  })

  // And what it cost, at the four points a frame passes through.
  //
  // The probes are off on every machine Tade is installed on, which means the
  // thing that breaks them is a refactor nobody notices: `Painted.render` is
  // where two of the four live, and a change that moved the fold or the
  // drawing out of it would leave the window working perfectly and the bench
  // reporting about a frame that no longer goes that way. So this drives the
  // real window and asks whether all four were reached.
  //
  // Never how long any of them took. What a frame costs is the bench's
  // business (`test/bench.ts`), run with the machine to itself; a number
  // measured here would be a number about a runner with two hundred other
  // files on it.
  it('reports what every frame cost, at each of the four points', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      await start({ frameMs: 50 })
      await until('the first frame', () => terminal.written.includes('refunds'))
      const spans = timings.spans()
      for (const point of POINTS) expect(spans[point], `nothing reached ${point}`).toBeDefined()
      // And one per subject, which is what says which of the twenty-two to
      // look at first — a single `frameOf` figure cannot.
      const subjects = Object.keys(spans).filter((point) => point.startsWith('subject:'))
      expect(subjects.length, 'no subject was timed inside the fold').toBeGreaterThan(10)
      // The floor, and the reason the probes may sit on the hot path at all:
      // the window drew exactly what it draws without them.
      expect(screenOf(terminal.written).join('\n')).toContain('refunds')
    } finally {
      stop()
    }
  })
})
