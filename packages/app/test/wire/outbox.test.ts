import type { LaneId } from '@tade/core'
import type { PointerReport, WheelTurn } from '@tade/drivers-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { probing, Timings } from '../../src/timing.ts'
import { type LaneDoor, Outbox } from '../../src/wire/outbox.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What the window sends a lane, in the order it was sent — and what arrives in
// one read of the terminal sent once.
//
// A paste the terminal did not bracket is one read and two thousand sequences,
// and every one of them was a write of its own: a syscall each under `pty`, a
// whole process each under `tmux`. Joined, it is one write — and the order is
// the thing that may never change for it, so that is asserted first and on its
// own: every write, press and notch, in exactly the order it was sent.

/** A door that writes down what came through it, and when it was asked. */
function recorded() {
  const went: string[] = []
  const door: LaneDoor = {
    write: async (lane: LaneId, data: Uint8Array | string) => {
      went.push(`write ${lane} ${String(data)}`)
    },
    point: async (lane: LaneId, report: PointerReport) => {
      went.push(`point ${lane} ${report.did}`)
    },
    wheel: async (lane: LaneId, turn: WheelTurn) => {
      went.push(`wheel ${lane} ${turn.rows}`)
    },
  }
  return { went, outbox: new Outbox(door) }
}

const press: PointerReport = {
  did: 'press',
  button: 'left',
  column: 1,
  row: 1,
  shift: false,
  alt: false,
  ctrl: false,
}

describe('what the window sends a lane', () => {
  const a = 'app/a/agent' as LaneId
  const b = 'app/b/agent' as LaneId

  it('sends a turn’s typing as one write, once the turn is over', async () => {
    const { went, outbox } = recorded()
    for (const char of 'echo hello\r') outbox.write(a, char)
    // Nothing yet: the rest of the read may still be on its way.
    expect(went).toEqual([])
    await Promise.resolve()
    expect(went).toEqual(['write app/a/agent echo hello\r'])
  })

  it('keeps every write, press and notch in the order it was sent', async () => {
    const { went, outbox } = recorded()
    outbox.write(a, 'l')
    outbox.write(a, 's')
    // A click on the lane after typing at it lands after the typing.
    outbox.point(a, press)
    outbox.write(a, ' -la')
    // Another lane between two writes to this one keeps them apart.
    outbox.write(b, 'pwd')
    outbox.write(a, '\r')
    outbox.wheel(b, { rows: -3, column: 1, row: 1 })
    outbox.write(b, '\r')
    await Promise.resolve()
    expect(went).toEqual([
      'write app/a/agent ls',
      'point app/a/agent press',
      'write app/a/agent  -la',
      'write app/b/agent pwd',
      'write app/a/agent \r',
      'wheel app/b/agent -3',
      'write app/b/agent \r',
    ])
  })

  it('sends at once when asked, and the next turn starts again from nothing', async () => {
    const { went, outbox } = recorded()
    outbox.write(a, 'one')
    outbox.flush()
    expect(went).toEqual(['write app/a/agent one'])
    outbox.write(a, 'two')
    await Promise.resolve()
    expect(went).toEqual(['write app/a/agent one', 'write app/a/agent two'])
  })

  it('says nothing about a lane that went away, and goes on to the next', async () => {
    const went: string[] = []
    const outbox = new Outbox({
      write: async (lane: LaneId, data: Uint8Array | string) => {
        if (lane === a) throw new Error('gone')
        went.push(String(data))
      },
      point: async () => {},
      wheel: async () => {},
    })
    outbox.write(a, 'lost')
    outbox.write(b, 'kept')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(went).toEqual(['kept'])
  })
})

describe('a paste the terminal did not bracket', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  // Two kilobytes in one read, into a terminal — the shape of a dictation tool
  // typing on somebody's behalf, or a terminal with bracketed paste off. It
  // reaches the lane whole, as one write, and in the order it was typed: the
  // shell runs what it was handed and prints what that comes to.
  it('reaches the lane as one write, whole and in order', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    const writes: string[] = []
    const write = client.write.bind(client)
    client.write = (lane: LaneId, data: Uint8Array | string) => {
      if (lane === opened.id) writes.push(String(data))
      return write(lane, data)
    }
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    // A line whose output says it arrived whole: the length of a long word,
    // and the end of it, which is where a dropped or a reordered run shows.
    const word = Array.from({ length: 400 }, (_, i) => String(i).padStart(4, '0')).join('-')
    const line = `x=${word}; echo "got-\${#x}-\${x: -9}"`
    expect(line.length).toBeGreaterThan(2_000)
    writes.length = 0
    terminal.type(line)
    await until('the paste sent', () => writes.length > 0)
    terminal.type('\r')

    // Read back from the terminal itself rather than off the screen, where a
    // command two thousand characters long wraps over every row there is.
    await until('the shell to run what it was handed', async () =>
      (await client.readTerminal('1', 50, 'app')).includes(`got-${word.length}-0398-0399`),
    )
    // Two reads, two writes: the line, and the enter that came after it.
    expect(writes).toEqual([line, '\r'])
  })

  // The same two kilobytes at the line you type to Tade on, which is pi's
  // editor and so has to be handed every key a person would press. They are
  // still one read, and one read is one frame — not one a character.
  it('is one frame at the line you type to Tade on, however many keys it was', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      await start()
      await until('the first frame', () => terminal.written.includes('refunds'))
      terminal.press('\x00') // opens the line you type into
      await until('the dictation line', () => terminal.written.includes('◉'))
      const before = timings.span('doRender')?.count ?? 0
      const said = 'and '.repeat(500)
      terminal.type(said)
      await until('what was typed on the line', () =>
        screenOf(terminal.written).some((row) => row.includes('and and and')),
      )
      // The ceiling, and room in it for a look or the status beat landing in
      // the same moment. Per character it was two thousand.
      expect((timings.span('doRender')?.count ?? 0) - before).toBeLessThan(5)
    } finally {
      stop()
    }
  })
})
