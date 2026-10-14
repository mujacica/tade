import type { LaneId } from '@tade/core'
import { ECHO_CHILD } from '@tade/drivers-core/conformance'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// A terminal opened in the window, and the wheel over one — which is the
// window's to answer, or the program's own, and never a guess.

/**
 * The newest line the shell printed that is still on screen, which is how far
 * back the wheel has taken it. Nought where it has gone back past all of them.
 */
function newestPrinted(terminal: FakeTerminal): number {
  const seen = screenOf(terminal.written).flatMap((row) => {
    const found = /printed line (\d+)/.exec(row)
    return found ? [Number(found[1])] : []
  })
  return seen.length === 0 ? 0 : Math.max(...seen)
}

/**
 * The shell's last line is in front, and the window knows there are lines
 * above it: the terminal's bar, down the right edge below its tab, has a
 * thumb. A notch is clamped to what the last frame's bar said (`reachOf`),
 * and a look reads how deep the lane is before it reads the text — so the
 * first frame showing line 400 can carry a bar from before the shell printed,
 * and a notch turned at that frame goes nowhere. A flick on a loaded runner
 * did exactly that, and the test waited twenty seconds for it to come back up.
 */
function inFront(terminal: FakeTerminal, tab: number): boolean {
  const rows = screenOf(terminal.written)
  return (
    rows.some((row) => row.includes('printed line 400')) &&
    rows.slice(tab + 1).some((row) => row.endsWith('█'))
  )
}

describe('the window, and the lanes in it', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let opened: { command: string; args: readonly string[] }[]
  const { start, click, find, sidebar, headingRow } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
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
    await until('the terminal in front', () => inFront(terminal, tab.row), 20_000)
    const rows = screenOf(terminal.written)
    const shell = rows.findIndex((row) => row.includes('printed line 400'))
    expect(shell).toBeGreaterThan(0)

    const newest = () => newestPrinted(terminal)

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
    //
    // Once it has stopped printing: a lane still growing has to be read
    // again, and that is the bottom being read, not the scrollback. Waited
    // out by the lane's own depth rather than by a sleep — how long a shell
    // takes to finish four hundred lines and put its prompt back is the
    // machine's business, and a sleep long enough here is a sleep that was
    // guessed. Rested rather than merely equal, as `rested` above is: a shell
    // between two writes is as still as one that has finished.
    let deep = -1
    let still = 0
    await until(
      'the shell done printing',
      async () => {
        const now = (await client.screen(opened.id)).lines
        still = now === deep ? still + 1 : 0
        deep = now
        return still >= 20
      },
      SPAWNING_MS,
    )

    // And counted over looks rather than over milliseconds: what a read costs
    // is per look, so how many of them a machine fits into half a second says
    // nothing about whether the window is reading a lane it need not read.
    let reads = 0
    let looks = 0
    const read = client.capture.bind(client)
    client.capture = (lane, lines, styled) => {
      reads++
      return read(lane, lines, styled)
    }
    const looked = client.screen.bind(client)
    client.screen = (lane) => {
      looks++
      return looked(lane)
    }
    await until('a few looks with nothing to do', () => looks >= 5, SPAWNING_MS)
    expect(reads).toBe(0)

    // And it stops at the oldest line there is rather than counting on past
    // it: every notch is clamped to what the last frame said the region
    // reaches, so nine hundred of them leave nothing owed at the top — and
    // one notch the other way moves straight away rather than spending a
    // handful that do nothing.
    for (let i = 0; i < 900; i++) terminal.press(wheelUp)
    const top = await rested('the oldest line there is', (line) => line < 20)
    terminal.press(`\x1b[<65;10;${shell + 1}M`)
    await until('one notch down moving straight away', () => newest() > top)
  })

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
    // Notched again every time we look, rather than three times up front.
    // A wheel report the program has not yet asked for is dropped and not
    // queued, so a single burst races the moment it turns mouse reporting on
    // — and losing that race looks exactly like the window never handing the
    // wheel over. It was the most reliable failure in the suite and no
    // deadline could have fixed it: nothing was still coming.
    await until('the program told about the wheel', () => {
      terminal.press(`\x1b[<64;10;${where + 1}M`)
      return screenOf(terminal.written).some((row) => row.includes('saw:<64;'))
    })
  })

  // A flick arrives as one read of the terminal: a run of notches, every one
  // of them answered in turn before anything is drawn. To a program that
  // scrolls itself each notch was a call to the driver — a process each under
  // `tmux` — so the run is handed over as what it adds up to: one turn of the
  // wheel, worth every notch in it.
  it('hands a flick to a lane that scrolls itself as one turn of the wheel', async () => {
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
    const where = screenOf(terminal.written).findIndex((row) => row.includes('own screen'))
    const up = `\x1b[<64;10;${where + 1}M`
    // Until it is listening: see the test above for why this cannot be once.
    await until('the program told about the wheel', () => {
      terminal.press(up)
      return screenOf(terminal.written).some((row) => row.includes('saw:<64;'))
    })

    const turns: number[] = []
    const wheel = client.wheel.bind(client)
    client.wheel = (lane, turn) => {
      turns.push(turn.rows)
      return wheel(lane, turn)
    }
    terminal.type(up.repeat(12))
    await until('the flick handed over', () => turns.length > 0)
    // Long enough for a second call to have been made, were there one: the
    // turn is sent at the end of the read, and the read is long over.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(turns).toHaveLength(1)
    // Up, and every notch of it: a notch is never worth less than a row.
    expect(turns[0]).toBeLessThanOrEqual(-12)
  })

  // The same run over a terminal the window scrolls, where adding it up must
  // come to exactly what answering every notch would have: the same place,
  // a turn back the other way still a turn back, and a key that came after
  // the notches still coming after them.
  it('answers a flick in one read where its notches would have, and a key after it', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    await client.write(opened.id, `${printing}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the terminal in front', () => inFront(terminal, tab.row), 20_000)
    const shell = screenOf(terminal.written).findIndex((row) => row.includes('printed line 400'))
    const up = `\x1b[<64;10;${shell + 1}M`
    const down = `\x1b[<65;10;${shell + 1}M`
    const newest = () => newestPrinted(terminal)
    /** Where the screen came to rest, rather than a frame it was passing through. */
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

    // At the newest line, down and then back up, in one read. Down goes
    // nowhere — it is already there — and up is a move of its own: added to
    // the notches down before it, the two would come to nothing at all.
    terminal.type(down.repeat(5) + up.repeat(5))
    await rested('the turn back up answered', (line) => line < 400)

    // Back up a run, then a key, in one read: typing at a terminal takes it
    // back to its newest line, and the key came after the notches.
    terminal.type(`${up.repeat(20)}x`)
    await rested('the key answered after the flick', (line) => line === 400)
    await until('the key typed into the shell', async () =>
      (await client.readTerminal('1', 5, 'app')).includes('x'),
    )
  })

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
  })

  // A notch over a lane the window scrolls changes where the window is
  // looking, not what the lane holds — so as long as the lines already held
  // reach that far there is nothing to ask the driver at all. Asking anyway
  // cost a screen read a notch, in every lane in front of you: 81 ms of a
  // 735 ms flick spent being told that nothing had changed.
  //
  // What a flick costs is counted per look and never per millisecond. Thirty
  // notches ten milliseconds apart, against a beat, is a count of how many
  // looks the machine managed to fit in — which is a number about the
  // machine: it came out six on a quiet laptop and eight on a loaded CI
  // runner, against an assertion that allowed seven. So the notches are paced
  // by the looks themselves, one look to a notch however long a look takes,
  // and what is asserted is what those looks asked the driver for. A slow
  // machine takes longer to say the same thing rather than saying a different
  // one.
  it('asks the driver for nothing while a flick stays inside the lines it holds', async () => {
    const opened = await client.openTerminal({ project: 'app' })
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    await client.write(opened.id, `${printing}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the terminal in front', () => inFront(terminal, tab.row), 20_000)
    const shell = screenOf(terminal.written).findIndex((row) => row.includes('printed line 400'))

    // The two the window asks the driver for, counted apart. `screen` is how
    // deep the lane is, read once a look whether or not anything moved — the
    // beat's cost, not the wheel's, and so also this test's count of looks.
    // `capture` is the text, and holding the lines is about exactly that one.
    let looks = 0
    let captures = 0
    const capture = client.capture.bind(client)
    client.capture = (lane, lines, styled) => {
      captures++
      return capture(lane, lines, styled)
    }
    const screen = client.screen.bind(client)
    client.screen = (lane) => {
      looks++
      return screen(lane)
    }

    /** A notch, and the look that answers it: what the flick is made of. */
    const wheelUp = `\x1b[<64;10;${shell + 1}M`
    const notch = async () => {
      const was = looks
      terminal.press(wheelUp)
      await until('the look that answers a notch', () => looks > was, SPAWNING_MS)
    }

    // Back past the live rows first. Until the wheel is clear of them there is
    // nothing settled to cut from — the program is still rewriting the rows it
    // is on — so the lane is read again every look, which is the cheap end and
    // not what this is about. Counted in rows of the screen rather than in
    // notches, because how far a notch goes is the wheel's to say and how tall
    // the strip is, is the layout's: a whole window's height is past both.
    const started = newestPrinted(terminal)
    const clear = () => newestPrinted(terminal) <= started - terminal.rows
    for (let i = 0; i < 100 && !clear(); i++) await notch()
    expect(clear()).toBe(true)

    captures = 0
    const from = newestPrinted(terminal)
    for (let i = 0; i < 20; i++) await notch()

    // Twenty notches, each with a look of its own to be answered in, and the
    // screen further back than it started: the flick moved, and cost the
    // driver not one read of what it moved through. Before the lines were
    // held this was a read a look, every one of them for lines that had not
    // changed since the shell printed them.
    expect(newestPrinted(terminal)).toBeLessThan(from)
    expect(captures).toBe(0)
  })

  // The first screenful up from the newest line is the live rows, which the
  // program may still be rewriting, so a look reads them again behind every
  // notch — and the text used to wait for that look, twenty to fifty
  // milliseconds a notch with the bar beside it already moved. The lines held
  // are drawn at once instead, as new as the look that read them.
  it('draws a notch over the live rows from the lines it holds, before the driver answers', async () => {
    terminal.resize(120, 45)
    const opened = await client.openTerminal({ project: 'app' })
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    await client.write(opened.id, `${printing}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    await until('the terminal in front', () => inFront(terminal, tab.row), 20_000)
    const rows = screenOf(terminal.written)
    const shell = rows.findIndex((row) => row.includes('printed line 400'))
    // The lane's rows on screen: its live rows are at least that many.
    const live = rows.filter((row) => /printed line \d+/.test(row)).length
    const up = `\x1b[<64;10;${shell + 1}M`

    // The first notch has nothing above the screen to cut from, so it is read.
    terminal.press(up)
    await until('the first notch read', () => newestPrinted(terminal) < 400)
    const once = newestPrinted(terminal)

    // From here the driver answers nothing until it is let go.
    let letGo = () => {}
    const held = new Promise<void>((resolve) => (letGo = resolve))
    const capture = client.capture.bind(client)
    const asked: (number | undefined)[] = []
    client.capture = async (lane, lines, styled) => {
      asked.push(lines)
      await held
      return capture(lane, lines, styled)
    }
    try {
      terminal.press(up)
      // Red once on macOS with nothing to say why. Whether the driver was asked
      // splits it: asked, the held lines were refused for the notch; not
      // asked, the notch itself went nowhere.
      await until('the second notch drawn', () => newestPrinted(terminal) < once).catch(
        (error: Error) => {
          const screen = screenOf(terminal.written).join('\n')
          throw new Error(
            `${error.message}, first notch at ${once}, driver asked for ${JSON.stringify(asked)} lines, on screen:\n${screen}`,
          )
        },
      )
      // Still over the live rows, which is the whole of what this is about.
      expect(400 - newestPrinted(terminal)).toBeLessThan(live)
    } finally {
      letGo()
    }
  })

  // Only as new as the last look that read them, though. A lane that went on
  // rewriting its live rows while the looks answered from above them has rows
  // nobody has read since, so coming back down onto them waits for a look
  // rather than drawing old ones. Meanwhile the driver is told, once a look,
  // that the bottom is still being looked at — so that look finds a frame of
  // it ready rather than one let lapse during the read.
  it('never draws live rows older than the last look, and keeps them watched', async () => {
    terminal.resize(120, 45)
    const opened = await client.openTerminal({ project: 'app' })
    const printing = 'i=1; while [ $i -le 400 ]; do echo "printed line $i"; i=$((i+1)); done'
    // Then the last row rewritten in place, as a spinner does: never any deeper.
    const ticking = "j=0; while true; do printf '\\rtick %s ' $j; j=$((j+1)); sleep 0.2; done"
    await client.write(opened.id, `${printing}; ${ticking}\r`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    const ticks = () => screenOf(terminal.written).some((row) => /tick \d+/.test(row))
    await until('the terminal ticking in front', ticks, 20_000)
    const shell = screenOf(terminal.written).findIndex((row) => row.includes('printed line 400'))
    const up = `\x1b[<64;10;${shell + 1}M`
    const down = `\x1b[<65;10;${shell + 1}M`

    let looks = 0
    let asked: (number | undefined)[] = []
    let held: Promise<void> | null = null
    let letGo = () => {}
    const capture = client.capture.bind(client)
    client.capture = async (lane, lines, styled) => {
      asked.push(lines)
      if (held) await held
      return capture(lane, lines, styled)
    }
    const screen = client.screen.bind(client)
    // A look is counted when it is answered, which is when it reads the lines
    // held and the driver may be told once more (`Held.read`) — not when it
    // asks. Counted at the ask, a look asked before the count began and
    // answered inside it let one run of notches tell the driver twice with no
    // look counted for the second: 11 against 10 on a loaded runner. And only
    // this terminal's looks, which are the only ones that tell it anything.
    client.screen = async (lane) => {
      const answer = await screen(lane)
      if (lane === opened.id) looks++
      return answer
    }
    /** A notch, and the look that answers it. */
    const notch = async (bytes: string) => {
      const was = looks
      terminal.press(bytes)
      await until('the look that answers a notch', () => looks > was, SPAWNING_MS)
    }

    // Back past the live rows, as far as a whole window's height.
    const clear = () => newestPrinted(terminal) <= 400 - terminal.rows
    for (let i = 0; i < 100 && !clear(); i++) await notch(up)
    expect(clear()).toBe(true)

    // Through the lines held while the lane ticks on, three moves to a look:
    // the driver is asked nothing about them, and told no more than once a
    // look that the bottom is still looked at, always for the same lines.
    asked = []
    const from = looks
    for (let i = 0; i < 10; i++) {
      for (let move = 0; move < 2; move++) {
        terminal.press(up)
        // A run of notches is one move until the turn it arrived in is over.
        await new Promise((resolve) => setImmediate(resolve))
      }
      await notch(up)
    }
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.length).toBeLessThanOrEqual(looks - from)
    expect(new Set(asked).size).toBe(1)

    // And back down onto the live rows with the driver held: nothing of them
    // is drawn from what was read before the ticking went on.
    held = new Promise<void>((resolve) => (letGo = resolve))
    try {
      terminal.type(down.repeat(200))
      let was = -1
      let quiet = 0
      await until('the screen at rest', () => {
        const now = newestPrinted(terminal)
        quiet = now === was ? quiet + 1 : 0
        was = now
        return quiet >= 20
      })
      expect(ticks()).toBe(false)
    } finally {
      held = null
      letGo()
    }
    await until('the live rows, read', ticks)
  })

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
    // The `+` offers a shell or an agent with no task now, and a terminal is
    // the first item, which is where a menu opens.
    await until('the menu', () =>
      screenOf(terminal.written).some((line) => line.includes('Terminal')),
    )
    terminal.press('\r')
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
  })

  // A new terminal's tab is read off the lane registry, which had it before the
  // open answered: it was waited for from up to ten looks at status, a tenth of
  // a second apart, before anything was drawn. Here no look can finish at all —
  // and the one already under way when it opened, which began before there was
  // a terminal to find, must not take its tab away when it does.
  it('shows a new terminal’s tab at once, and a look begun before it keeps it', async () => {
    await start()
    await until('the tabs', () =>
      screenOf(terminal.written).some((row) => row.includes('orchestrator')),
    )
    let release = () => {}
    const stuck = new Promise<void>((resolve) => {
      release = resolve
    })
    let began = 0
    const asked = client.pendingApprovals.bind(client)
    // What every look asks, and only a look: held until the terminal is open.
    client.pendingApprovals = ((task?: string) => {
      if (task !== undefined) return asked(task)
      began++
      return stuck.then(() => asked())
    }) as never
    try {
      await until('a look under way', () => began === 1)
      terminal.press('\x14')
      await until('a terminal', () => client.terminals('app').length === 1)
      await until('its tab, in front', () =>
        screenOf(terminal.written).some((row) => row.includes('terminal 1')),
      )
    } finally {
      release()
    }
    // A look starts only once the last has finished: the stale one has landed.
    await until('the next look', () => began >= 2)
    expect(screenOf(terminal.written).some((row) => row.includes('terminal 1'))).toBe(true)
  })

  // A key into a lane asks for no look of its own: its echo is the lane
  // printing, and a print is what looks (`Looks.printed`). So every lane that
  // can be typed into is watched — the second half of a split as much as the
  // first, which nothing watched while each key still asked for its own look.
  it('watches both halves of a split terminal, and draws what is typed into the second', async () => {
    const watched = new Set<string>()
    const watch = client.watch.bind(client)
    client.watch = ((...args: Parameters<typeof watch>) => {
      watched.add(args[0])
      return watch(...args)
    }) as typeof client.watch
    const first = await client.openTerminal({ project: 'app' })
    await start()
    await until('its tab', () => terminal.written.includes('terminal 1'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    terminal.press(`\x1b[<2;${tab.col + 2};${tab.row + 1}M`)
    terminal.press(`\x1b[<2;${tab.col + 2};${tab.row + 1}m`)
    await until('its menu', () => terminal.written.includes('Split: a new terminal beside'))
    const item = find('Split: a new terminal beside')
    click(item.col + 1, item.row)
    await until('a second terminal', () => client.terminals('app').length === 2)
    const second = client.terminals('app').find((one) => one.id !== first.id)?.id ?? ''
    await until('both halves watched', () => watched.has(first.id) && watched.has(second))
    // The keyboard is on the new half: what is typed there is drawn there.
    for (const char of 'echo split-$((6 * 7))') terminal.press(char)
    terminal.press('\r')
    await until('the second half answering', () =>
      screenOf(terminal.written).some((row) => row.includes('split-42')),
    )
  })

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
  })

  it('opens and names a terminal when told to in words', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00') // opens the line you type into
    for (const char of 'open a terminal called logs') terminal.press(char)
    terminal.press('\r')
    await until('the terminal', () => client.terminals('app').some((one) => one.name === 'logs'))
    await until('its tab', () => terminal.written.includes('logs'))
  })

  // A lane's screen is that lane's. Going to another agent drew the one you
  // had left, under the name of the one you had gone to, until the next look
  // read the right one — and a look already part-way through reading the old
  // one put it back when it finished.
  it("never draws one agent's screen under another's name", async () => {
    for (const name of ['refunds', 'search']) {
      const words = `${name.toUpperCase()} OWN WORDS`
      await client.spawn({
        id: `app/${name}/agent` as LaneId,
        task: `app/${name}`,
        kind: 'agent',
        cwd: repo.root,
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(words)}); setInterval(() => {}, 60_000)`],
      })
    }
    await start()
    const shown = () => screenOf(terminal.written).join('\n')
    await until('refunds in front', () => shown().includes('REFUNDS OWN WORDS'), SPAWNING_MS)

    // From here the driver answers nothing until it is let go, so whatever a
    // switch draws is what the window already had — or nothing at all.
    let letGo = () => {}
    const holding = () => new Promise<void>((resolve) => (letGo = resolve))
    let held: Promise<void> | null = holding()
    const capture = client.capture.bind(client)
    client.capture = async (lane, lines, styled) => {
      if (held) await held
      return capture(lane, lines, styled)
    }
    const agent = (name: string) => {
      const lines = sidebar().split('\n')
      const from = headingRow('AGENTS').row
      const row = lines.findIndex((line, at) => at > from && line.includes(name))
      click((lines[row] ?? '').indexOf(name) + 1, row)
    }
    try {
      agent('search')
      await until('search in front', () => shown().includes('│ search '))
      // Never read, so nothing: not refunds' words under search's name.
      expect(shown()).not.toContain('REFUNDS OWN WORDS')

      held = null
      letGo()
      await until('search, read', () => shown().includes('SEARCH OWN WORDS'), SPAWNING_MS)

      // Back, with the driver answering nothing again: refunds' own last
      // screen, at once, and none of search's.
      held = holding()
      agent('refunds')
      await until('refunds in front again', () => shown().includes('│ refunds '))
      await until('its own last screen', () => shown().includes('REFUNDS OWN WORDS'))
      expect(shown()).not.toContain('SEARCH OWN WORDS')
    } finally {
      held = null
      letGo()
    }
  })
})
