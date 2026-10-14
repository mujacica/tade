import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { NEWS_MS, RENDER_FLOOR_MS, WRITE_SHARE } from '../../src/pace.ts'
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

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/**
 * How many glyphs the orchestrator's tab turned between each two frames that
 * drew it in `written`. A frame that drew it again on the glyph it already
 * showed drew it for something else, and says nothing about the turning.
 */
function stepsIn(written: string): number[] {
  const seen = Array.from(written.matchAll(/orchestrator ([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/g), (one) =>
    SPINNER.indexOf(one[1] ?? ''),
  )
  const steps: number[] = []
  for (let at = 1; at < seen.length; at++) {
    const step = ((seen[at] ?? 0) - (seen[at - 1] ?? 0) + SPINNER.length) % SPINNER.length
    if (step > 0) steps.push(step)
  }
  return steps
}

/** The most frames in a row that each turned the spinner one glyph on, and no further. */
function evenRun(steps: readonly number[]): number {
  let best = 0
  let run = 0
  for (const step of steps) {
    run = step === 1 ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}

/**
 * Both ends of a spinner turning, from here on in what the window writes.
 *
 * The floor is what a person sees: a whole turn, one glyph a frame. Not "every
 * glyph appeared" — a spinner drawn five times a second jumping two or three
 * at a time shows all ten within a second or two and reads as a stutter — and
 * not "it changed once": the status beat redraws every two seconds on its own.
 * Said once over a wait rather than counted, so a starved runner that drops a
 * frame here and there passes as soon as it draws ten in a row, and a window
 * that never does waits until the deadline and says what for.
 *
 * The ceiling: ten a second for the spinner, and room for the frames a status
 * beat and a git look ask for on their own. Thirty-three is what the old gate
 * drew with a lane printing in front, one for every look.
 */
async function turnsEvenly(terminal: FakeTerminal, timings: Timings): Promise<void> {
  const from = timings.spans().draw?.count ?? 0
  const mark = terminal.written.length
  const started = Date.now()
  await until('a whole turn of the spinner, one glyph a frame', () => {
    return evenRun(stepsIn(terminal.written.slice(mark))) >= SPINNER.length
  })
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 2_000 - Date.now())))
  const frames = ((timings.spans().draw?.count ?? 0) - from) / ((Date.now() - started) / 1000)
  expect(frames, `${frames.toFixed(1)} frames a second`).toBeLessThan(16)
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
  const { start, click, find, sidebar } = windowUnderTest((wired) => {
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
  // missed: the spinner has to have *turned* on screen while nothing else did,
  // one glyph a frame (`turnsEvenly`). The ceiling is a rate, never a rate the
  // machine has to reach: a starved runner draws fewer frames, which passes,
  // and the floor is a run of them said once over the wait, never a count.
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

      // It turns, on screen, while the lane in front says nothing new.
      await turnsEvenly(terminal, timings)
    } finally {
      stop()
    }
  })

  // And with nothing printing in front at all, which is most of the time: the
  // orchestrator thinking with its own tab in front, agents working out of
  // view. Looks come every quarter second then, and the spinner moved only
  // when one did — about five frames a second, two or three glyphs at a jump,
  // `0, 2, 5, 7, 0…`. The spinner has a clock of its own now (`Window.drew`).
  it('turns one glyph a frame with nothing in front printing', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      await start({ frameMs: 250, thinker: { ask: () => new Promise<string>(() => {}) } })
      await until('the first frame', () => terminal.written.includes('refunds'))
      terminal.press('\x00')
      for (const char of 'what is going on') terminal.press(char)
      terminal.press('\r')
      await until('the orchestrator to be on a turn', () => turnsIn(terminal.written).size > 0)
      await turnsEvenly(terminal, timings)
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

  // A key typed into a lane is drawn by the lane: out to the program, back as
  // output, read by a look and drawn by it. That frame is the key's as much as
  // the line's own echo is, and a terminal slow to take frames is no reason to
  // show somebody what they typed later — but it was paced like news, held for
  // the terminal's interval behind the frame before it, and the slower the
  // terminal the longer every echo waited.
  //
  // So a terminal taking forty milliseconds a frame, which puts the pace three
  // steps up, `cat` to type into, and each key typed as soon as the last one's
  // echo is on screen: just after a frame, where anything paced waits most of
  // its interval. Counted against the keys, never a sleep — how many of their
  // echoes the pace held — with room for a runner so starved an echo came back
  // later than `ECHO_OWED_MS`, which makes it an ordinary frame and is the
  // rule working. Every one held is the old window.
  it('a frame owed to a key is not paced', async () => {
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
      await client.write(opened.id, 'exec cat\r')
      await start({ frameMs: 250 })
      await until('the first frame', () => terminal.written.includes('refunds'))
      // Clicked until it is in front, found afresh each time: a click aimed off
      // a frame the next one moved focuses something else, and every key then
      // goes where nothing echoes it — "E" passes on any capital E on screen,
      // and "EC" waits out the deadline, which is how ubuntu failed it once.
      // The shell's echo of `exec cat` is drawn only once the lane is in front.
      let aimed = 0
      await until('terminal 1 in front', () => {
        if (screenOf(terminal.written).some((row) => row.includes('exec cat'))) return true
        if (performance.now() - aimed > 500) {
          const tab = find('terminal 1')
          click(tab.col + 1, tab.row)
          aimed = performance.now()
        }
        return false
      })
      const tab = find('terminal 1')
      // What `cat` echoes, found by content: a run nothing else on screen has.
      let line = ''
      const type = async (keys: string): Promise<void> => {
        for (const key of keys) {
          line += key
          terminal.press(key)
          await until(`"${line}" echoed`, () =>
            screenOf(terminal.written).some((row) => row.includes(line)),
          )
        }
      }
      await type('ECHO>')

      slow = 40
      while ((timings.span('pace')?.worst ?? 0) * WRITE_SHARE < slow) await type('z')
      const KEYS = 6
      const from = timings.span('held')?.count ?? 0
      await type('z'.repeat(KEYS))
      const held = (timings.span('held')?.count ?? 0) - from
      expect(held, `${held} of ${KEYS} echoes held for the terminal's pace`).toBeLessThan(KEYS / 2)
      // The floor under it, so a pass is not a probe gone quiet: frames the
      // window asks for that nobody typed — clicks — are still held.
      const clicked = timings.span('held')?.count ?? 0
      await until('a click held for the pace', () => {
        click(tab.col + 1, tab.row)
        return (timings.span('held')?.count ?? 0) > clicked
      })
    } finally {
      stop()
    }
  })

  // An event is news, not necessarily a new picture. Every line the journal
  // hears changes something the window may draw, and every one of them used to
  // ask for a frame of its own: a storm of them was a frame every sixteen
  // milliseconds, pi-tui's ceiling, which is thirteen agents working all day.
  //
  // So a ceiling counted against the storm itself — a frame for each spinner
  // interval it lasted, and a few for the status beat and a look landing in
  // it — which a starved runner meets by drawing less. And a floor that is
  // the end of the storm on screen: spread out is not dropped.
  it('draws a storm of events no oftener than the spinner turns, and the end of it', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      await start({ frameMs: 250 })
      await until('the first frame', () => terminal.written.includes('Settings'))
      const from = timings.span('doRender')?.count ?? 0
      const started = performance.now()
      for (let i = 0; i < 300; i++) {
        await client.log.append({
          type: 'usage',
          task: 'app/refunds',
          detail: { model: 'anthropic/claude-sonnet-5', tokens: 10, usd: 0.01 },
        })
        // Spread over most of a second, so the storm is long enough to say
        // something about a rate: a storm over in ten milliseconds is one frame
        // whatever the window does.
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      const took = performance.now() - started
      const frames = (timings.span('doRender')?.count ?? 0) - from
      expect(frames, `${frames} frames for a storm of ${took.toFixed(0)}ms`).toBeLessThanOrEqual(
        Math.ceil(took / NEWS_MS) + 4,
      )
      await until('the whole storm on screen', () => terminal.written.includes('$3.00'))
    } finally {
      stop()
    }
  })

  // A window nobody is touching: nothing printing, nothing turning. It drew a
  // frame on every status beat whatever status said — with the extensions'
  // own beat, about 0.7 a second — and every one made every answer kept on
  // `Live.revision` again. A beat is news only where it found something new.
  //
  // So a ceiling counted against the beats themselves, at the place the window
  // asks status for one, never against a sleep: a starved runner takes fewer
  // beats and draws fewer frames, which passes. And a floor that a window
  // which stopped looking along with drawing would fail: a file saved in the
  // checkout in front of you, with nothing else happening, reaches CHANGES.
  it('draws nothing on a beat that found what the last did, and still sees a file saved', async () => {
    let beats = 0
    const asked = client.pendingApprovals.bind(client)
    client.pendingApprovals = (() => {
      beats++
      return asked()
    }) as typeof client.pendingApprovals
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      terminal.resize(160, 60)
      await start({ frameMs: 250 })
      await until('the first frame', () => terminal.written.includes('refunds'))
      // The first looks at everything land and are drawn, and then it is quiet:
      // a frame a beat is what it drew before, so two beats tell the two apart.
      const settling = beats + 1
      await until('the window to settle', () => beats >= settling)
      const from = timings.span('doRender')?.count ?? 0
      const quiet = beats + 2
      await until('two quiet beats', () => beats >= quiet)
      const frames = (timings.span('doRender')?.count ?? 0) - from
      expect(frames, `${frames} frames over two beats that found nothing`).toBeLessThanOrEqual(1)

      // The agent in front of you is the first one, in its own worktree.
      writeFileSync(join(dirname(root), 'worktrees', 'app-refunds', 'teapot.yaml'), 'stout\n')
      await until('the saved file in CHANGES', () => sidebar().includes('teapot.yaml'))
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
