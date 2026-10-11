import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
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
