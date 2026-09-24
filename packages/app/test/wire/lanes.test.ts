import { ECHO_CHILD } from '@tade/drivers-core/conformance'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A terminal opened in the window, and the wheel over one — which is the
// window's to answer, or the program's own, and never a guess.

describe('the window, and the lanes in it', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let opened: { command: string; args: readonly string[] }[]
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    opened = wired.opened
  })

  it('scrolls a terminal with the wheel, a line a notch in a run and never past the end', async () => {
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

    /**
     * Where a flick came to rest, rather than where it was passing through.
     *
     * Notches are answered one at a time, and the ones that reach above the
     * lines the window holds are answered by asking the driver, which lands a
     * frame or two later. `until` answers on the first look that passes, so
     * that look can be a screen the notches behind it are about to move
     * again — which is what read as a notch that did nothing on the way back.
     * Only a screen that has stopped moving, and stopped where it was going,
     * says where a flick ended.
     */
    const rested = async (what: string, there: (line: number) => boolean) => {
      let was = -1
      let quiet = 0
      await until(
        what,
        () => {
          const now = newest()
          quiet = now === was ? quiet + 1 : 0
          was = now
          return quiet >= 20 && there(now)
        },
        20_000,
      )
      return was
    }

    // Twenty notches of the wheel up, as a terminal in SGR mouse mode sends
    // them. What a terminal reports is a notch and nothing else — pi-tui
    // counts every one of them as one line — so how far one goes is the
    // rate's to say, and arriving in a run this fast they are a finger
    // travelling: a line each, twenty-odd lines, not the sixty that three
    // rows a notch used to make of them.
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
    // it: every notch is clamped to what the last frame said the region
    // reaches, so nine hundred of them leave nothing owed at the top — and
    // one notch the other way moves straight away rather than spending a
    // handful that do nothing.
    for (let i = 0; i < 900; i++) terminal.press(wheelUp)
    const top = await rested('the oldest line there is', (line) => line < 20)
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

  // And what it draws in answer has to be read back, which is the other half
  // of handing it the wheel. A lane that paints its own screen was read once
  // and never again: the lines held are keyed by how deep the lane is, and a
  // program that repaints in place never gets any deeper — so every look
  // found the lines it already had and the pane froze on the first screen it
  // ever read. Which is what "the Claude pane does not scroll" was, once the
  // notch was reaching the program: it scrolled, and the window went on
  // drawing a photograph of it.
  it('keeps reading a lane that paints its own screen, because it holds nothing', async () => {
    const opened = await client.openTerminal({ project: 'app' })
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
    // `repaint` fills every row of it, the bottom one included — which is
    // what a screen a program draws for itself looks like, and what the
    // fixture used to be too kind to do.
    await client.write(opened.id, 'repaint first\r')
    await until('the first painting', () =>
      screenOf(terminal.written).some((row) => row.includes('first on row')),
    )
    await client.write(opened.id, 'repaint second\r')
    await until(
      'the second painting',
      () => screenOf(terminal.written).some((row) => row.includes('second on row')),
      5_000,
    )
  }, 20_000)

  // A notch over a lane the window scrolls changes where the window is
  // looking, not what the lane holds — so as long as the lines already held
  // reach that far there is nothing to ask the driver at all. Asking anyway
  // cost a screen read a notch, in every lane in front of you: 81 ms of a
  // 735 ms flick spent being told that nothing had changed.
  it('asks the driver for nothing while a flick stays inside the lines it holds', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    await client.write(opened.id, `${printing}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until(
      'the terminal in front',
      () => screenOf(terminal.written).some((row) => row.includes('printed line 400')),
      20_000,
    )
    const shell = screenOf(terminal.written).findIndex((row) => row.includes('printed line 400'))
    // One notch first, so the lines behind the screen have been sent for.
    terminal.press(`\x1b[<64;10;${shell + 1}M`)
    await new Promise((resolve) => setTimeout(resolve, 400))

    let asked = 0
    const capture = client.capture.bind(client)
    client.capture = (lane, lines, styled) => {
      asked++
      return capture(lane, lines, styled)
    }
    const screen = client.screen.bind(client)
    client.screen = (lane) => {
      asked++
      return screen(lane)
    }
    for (let i = 0; i < 30; i++) {
      terminal.press(`\x1b[<64;10;${shell + 1}M`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The beat of the window itself is 250 ms, so a flick of a third of a
    // second is one or two looks. Thirty notches used to be thirty.
    expect(asked).toBeLessThan(8)
  }, 40_000)

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

  // A URL a program printed is a link like any other on screen: it lights up
  // under the pointer and a click opens it. Where it opens is the seam — the
  // window hands the opener to whatever it was started with, and a test is
  // handed one that records the command instead of running it, because a
  // suite that opened a browser on somebody's machine is what that is for.
  it('opens a link a terminal printed, through the opener it was given', async () => {
    const terminalLane = await client.openTerminal({ project: 'app' })
    await client.write(terminalLane.id, 'echo see https://example.com/found\r')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('what it printed', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('https://example.com/found') && !row.includes('echo'),
      ),
    )
    const rows = screenOf(terminal.written)
    const row = rows.findLastIndex(
      (one) => one.includes('https://example.com/found') && !one.includes('echo'),
    )
    click((rows[row] ?? '').indexOf('https://'), row)
    await until('the link opened', () =>
      opened.some((one) => one.args.includes('https://example.com/found')),
    )
    // And through the seam, not past it: nothing was spawned on this machine.
    expect(opened.every((one) => ['open', 'xdg-open', 'cmd'].includes(one.command))).toBe(true)
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
