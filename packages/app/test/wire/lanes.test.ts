import { ECHO_CHILD } from '@tade/drivers-core/conformance'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A terminal opened in the window, and the wheel over one — which is the
// window's to answer, or the program's own, and never a guess.

describe('the window, and the lanes in it', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('scrolls a terminal with the wheel, by the lines the terminal counted', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    // Enough printed that there is scrollback to read back through.
    // Counted in the shell rather than with `seq`, which is one more program
    // to be missing on somebody's machine.
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    await client.write(opened.id, `${printing}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    // A real shell, starting and printing four hundred lines: on a machine
    // running the rest of this suite beside it that is not always quick.
    await until(
      'the terminal in front',
      () => screenOf(terminal.written).some((row) => row.includes('printed line 400')),
      20_000,
    )
    const rows = screenOf(terminal.written)
    const shell = rows.findIndex((row) => row.includes('printed line 400'))
    expect(shell).toBeGreaterThan(0)

    /** The newest line still on screen, which says how far back it has gone. */
    const newest = () => {
      const seen = screenOf(terminal.written).flatMap((row) => {
        const found = /printed line (\d+)/.exec(row)
        return found ? [Number(found[1])] : []
      })
      return seen.length === 0 ? 0 : Math.max(...seen)
    }

    // Twenty notches of the wheel up, as a terminal in SGR mouse mode sends
    // them. Arriving in a run they are a finger on a trackpad, which reports
    // a notch a line — so they are worth twenty-odd lines, not the sixty that
    // three rows a notch used to make of them.
    const wheelUp = `\x1b[<64;10;${shell + 1}M`
    for (let i = 0; i < 20; i++) terminal.press(wheelUp)
    await until('the terminal scrolled back', () => newest() < 400)
    expect(newest()).toBeGreaterThan(360)
    expect(newest()).toBeLessThan(390)

    // Sitting there scrolled back, the lane is not read again. Scrollback
    // above the live screen cannot change, and reading it back on every look
    // cost what it asked for — twelve milliseconds two thousand lines back,
    // four times a second, for lines that were the same every time.
    // Once it has stopped printing: a lane still growing has to be read
    // again, and that is the bottom being read, not the scrollback.
    await new Promise((resolve) => setTimeout(resolve, 200))
    let reads = 0
    const read = client.capture.bind(client)
    client.capture = (lane, lines, styled) => {
      reads++
      return read(lane, lines, styled)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(reads).toBeLessThan(2)

    // And it stops at the oldest line there is rather than counting on past
    // it: an offset that ran off the end used to buy a handful of notches
    // that did nothing on the way back.
    for (let i = 0; i < 900; i++) terminal.press(wheelUp)
    await until('the oldest line there is', () => newest() < 20)
    const top = newest()
    terminal.press(`\x1b[<65;10;${shell + 1}M`)
    await until('one notch down moving straight away', () => newest() > top)
  }, 30_000)

  // A program that takes the whole screen keeps no scrollback for the window
  // to move, and asks for the mouse so it can answer the wheel itself. This
  // is what Claude Code does, and what scrolling in its pane did nothing at
  // all before: nothing to move, and nobody sent the notch on.
  it('hands the wheel to a lane whose program took the screen for itself', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    // The driver suite's own child: it can take the screen on command, and
    // says what pointer reports it was sent.
    await client.write(opened.id, `${process.execPath} ${ECHO_CHILD}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the child running', () =>
      screenOf(terminal.written).some((row) => row.includes('ready')),
    )

    await client.write(opened.id, 'screen\r')
    await until('it to take the screen', () =>
      screenOf(terminal.written).some((row) => row.includes('own screen')),
    )
    const where = screenOf(terminal.written).findIndex((row) => row.includes('own screen'))
    expect(where).toBeGreaterThan(0)

    // Three notches up over its screen. Nothing here moves — there is no
    // scrollback to move through — and the program is told, so what it draws
    // in answer is its own scrolling.
    for (let i = 0; i < 3; i++) terminal.press(`\x1b[<64;10;${where + 1}M`)
    await until('the program told about the wheel', () =>
      screenOf(terminal.written).some((row) => row.includes('saw:<64;')),
    )
  }, 20_000)

  it('opens a terminal from the + beside the orchestrator, and types into it', async () => {
    await start()
    await until('the tabs', () =>
      screenOf(terminal.written).some((row) => row.includes('orchestrator')),
    )
    // The tab row, which the rule runs along.
    const rows = screenOf(terminal.written)
    const tabRow = rows.findIndex((line) => line.includes('orchestrator') && line.includes('━'))
    const row = rows[tabRow] ?? ''
    click(row.indexOf('+', row.indexOf('orchestrator')), tabRow)
    await until('a terminal', () => client.terminals('app').length === 1)
    await until('its tab', () => terminal.written.includes('terminal 1'))
    // The keyboard is in it now: typed keys are the shell's.
    for (const char of 'echo tade-$((6 * 7))') terminal.press(char)
    terminal.press('\r')
    const deadline = Date.now() + 20_000
    while (!(await client.readTerminal('1', 50, 'app')).includes('tade-42')) {
      if (Date.now() > deadline) throw new Error('the command never ran')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, 30_000)

  it('opens and names a terminal when told to in words', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00') // opens the line you type into
    for (const char of 'open a terminal called logs') terminal.press(char)
    terminal.press('\r')
    await until('the terminal', () => client.terminals('app').some((one) => one.name === 'logs'))
    await until('its tab', () => terminal.written.includes('logs'))
  }, 30_000)
})
