import { describe, expect, it } from 'vitest'
import { NOBODY_LOOKING, ON_ANOTHER_MACHINE, ON_THIS_MACHINE } from '../../src/faces.ts'
import { focusTask, initialState } from '../../src/model.ts'
import { copySaying, type Wiring } from '../../src/wire/context.ts'
import { FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A heart that takes faces (`Heart.attach`, `App.attach`): the window drawn
// again on another terminal, at its size and from its own place in the window,
// over the heart the machine's own window already beats.

/** The widest row a terminal shows, and how many rows have something on them. */
function extent(written: string): { columns: number; rows: number } {
  const rows = screenOf(written)
  return {
    columns: Math.max(0, ...rows.map((row) => row.trimEnd().length)),
    rows: rows.filter((row) => row.trim() !== '').length,
  }
}

/** A terminal of its own size, as a second face is drawn on. */
function sized(columns: number, rows: number): FakeTerminal {
  const terminal = new FakeTerminal()
  terminal.columns = columns
  terminal.rows = rows
  return terminal
}

describe('a second face on a running heart', () => {
  let terminal: FakeTerminal
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
  })

  it('draws the window at its own size while the first keeps drawing at its', async () => {
    const app = await start()
    const second = sized(132, 39)
    const attached = app.attach(second, { capabilities: ON_ANOTHER_MACHINE })
    await until('the second face to draw the agents', () =>
      screenOf(second.written).some((row) => row.includes('refunds')),
    )
    const drawn = extent(second.written)
    expect(drawn.columns, 'the second face is as wide as its own terminal').toBeGreaterThan(80)
    expect(drawn.columns).toBeLessThanOrEqual(132)
    expect(drawn.rows, 'and as tall').toBeGreaterThan(24)

    // The first keeps drawing, at a size of its own, with the second there.
    const from = terminal.written.length
    terminal.resize(100, 30)
    await until('the first face to draw again at its new size', () => {
      const rows = screenOf(terminal.written.slice(from))
      return rows.some((row) => row.includes('refunds'))
    })
    expect(extent(second.written).columns, 'and the second stays at its own').toBeGreaterThan(100)
    attached.detach()
  })

  it('looks where it looks, and the machine’s own window stays where it was', async () => {
    const app = await start()
    const second = sized(132, 39)
    const attached = app.attach(second, { capabilities: ON_ANOTHER_MACHINE })
    await until('the second face to draw', () => second.written.includes('refunds'))
    const here = attached.face.state.focused
    const elsewhere = attached.face.state.panes.find((pane) => pane.task !== here)?.task
    expect(elsewhere, 'two agents to stand at').toBeDefined()

    attached.face.put(focusTask(attached.face.state, elsewhere ?? ''))
    attached.draw()
    expect(attached.face.state.focused).toBe(elsewhere)
    // A face that comes now starts where the machine's own window is: which
    // is where it was, because the second face's focus was its own.
    const third = app.attach(sized(90, 30), { capabilities: ON_ANOTHER_MACHINE })
    expect(third.face.state.focused).toBe(here)
    // And the facts are the same objects on every face.
    expect(third.face.state.panes).toBe(attached.face.state.panes)
    third.detach()
    attached.detach()
  })

  it('is drawn no more once it has gone, and cannot be served', async () => {
    const app = await start()
    const second = sized(120, 36)
    const attached = app.attach(second, { capabilities: ON_ANOTHER_MACHINE })
    await until('the second face to draw', () => second.written.includes('refunds'))
    attached.detach()
    const after = second.written.length
    const from = terminal.written.length
    terminal.resize(90, 28)
    await until('the first face to draw again', () => terminal.written.length > from)
    // Left as it was found, and then nothing more.
    const cleared = second.written.length
    expect(cleared).toBeGreaterThanOrEqual(after)
    terminal.resize(96, 30)
    await until('the first face to draw once more', () => terminal.written.length > from + 1)
    expect(second.written.length).toBe(cleared)
    expect(() => attached.face.as(() => 0)).toThrow('that face has gone from this heart')
  })
})

describe('what a face can do on its machine', () => {
  /** A wire as one face sees it, recording what would have been copied. */
  function wireFor(face: Wiring['face']): { wire: Wiring; copied: string[] } {
    const copied: string[] = []
    let state = initialState()
    const wire = {
      face,
      opts: {
        clipboard: {
          write: async (text: string) => {
            copied.push(text)
            return true
          },
        },
      },
      get state() {
        return state
      },
      put: (next: typeof state) => {
        state = next
      },
      now: () => 0,
      draw: () => {},
    } as unknown as Wiring
    return { wire, copied }
  }

  it('copies to the clipboard only where that clipboard is in front of the face', async () => {
    const here = wireFor(ON_THIS_MACHINE)
    await copySaying(here.wire, 'a branch', () => {})
    expect(here.copied).toEqual(['a branch'])

    for (const face of [ON_ANOTHER_MACHINE, NOBODY_LOOKING]) {
      const there = wireFor(face)
      await copySaying(there.wire, 'a branch', () => {})
      expect(there.copied, 'nothing copied on a clipboard nobody there has').toEqual([])
      expect(there.wire.state.notice).toBe(face.why.clipboard)
    }
  })
})
