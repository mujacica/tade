import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../src/model.ts'
import { NOTCH } from '../../src/scroll.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What a click, a drag and a right-click land on: the bar down a side, the
// edge between two panes, an agent dragged up the list.

describe('the window, under the pointer', () => {
  let terminal: FakeTerminal
  let home: string
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    home = wired.home
    client = wired.client
  })

  it('scrolls the sidebar by dragging the bar down its right', async () => {
    // Short of room, so there is more in the sidebar than fits and the bar has
    // a thumb to take hold of.
    terminal.columns = 100
    terminal.rows = 14
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    const lines = screenOf(terminal.written)
    const top = lines.findIndex((line) => line.includes('AGENTS'))
    const bar = (lines[top] ?? '').indexOf('\u2502') - 1
    expect(bar).toBeGreaterThan(10)
    const thumb = lines.findIndex((line) => line[bar] === '\u2588')
    expect(thumb).toBeGreaterThanOrEqual(top)
    // Pressed on the thumb, dragged to the foot of the track, let go.
    terminal.press(`\x1b[<0;${bar + 1};${thumb + 1}M`)
    terminal.press(`\x1b[<32;${bar + 1};${thumb + 6}M`)
    terminal.press(`\x1b[<0;${bar + 1};${thumb + 6}m`)
    await until(
      'the sidebar scrolled',
      () => !(screenOf(terminal.written)[top] ?? '').includes('AGENTS'),
    )
  })

  it('scrolls a panel with the wheel, by rows and not by rows of its list', async () => {
    // The whole of what was reported about Settings: the wheel over it was
    // answered by pressing the panel's own down key, so a notch moved *what is
    // chosen* — a setting at a time, jumping over the ones between — instead
    // of the page, and there was no bar beside it because nothing knew how
    // long the form was. Short of room, so there is more of it than fits.
    terminal.columns = 100
    terminal.rows = 20
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x1b[44;5u')
    await until('the settings panel', () =>
      screenOf(terminal.written).some((row) => row.includes('Saved as you change it')),
    )
    /**
     * The form's own column of the panel, row by row: what is between the rule
     * that divides the categories from it and the column its scrollbar takes.
     * The marker down the left of the chosen setting is dropped, because where
     * that is, is the other half of what this test asks.
     */
    const form = () => {
      const lines = screenOf(terminal.written)
      const top = lines.findIndex((row) => row.includes('\u256d\u2500 Settings'))
      const bottom = lines.findIndex((row, at) => at > top && row.includes('\u2570'))
      return lines.slice(top + 1, bottom).map((row) => {
        const rule = row.indexOf('\u2502', row.indexOf('\u2502') + 1)
        return row
          .slice(rule + 1, row.lastIndexOf('\u2502') - 1)
          .replace(/^\u258c/, ' ')
          .trimEnd()
      })
    }
    const before = form()
    expect(before.length).toBeGreaterThan(6)
    // One notch over the form, a few rows above its foot.
    const lines = screenOf(terminal.written)
    const foot = lines.findIndex((row) => row.includes('Saved as you change it'))
    expect(foot).toBeGreaterThan(4)
    const at = foot - 3
    const row = lines[at] ?? ''
    const column = row.indexOf('\u2502', row.indexOf('\u2502') + 1) + 6
    terminal.press(`\x1b[<65;${column};${at + 1}M`)
    await until('the form to scroll', () => form().join('\n') !== before.join('\n'))
    // Three rows of the page, which is what a notch on its own is worth —
    // never one row of a list, and never the next setting chosen. Counted from
    // the third row of the panel, since the heading and the blank under it
    // stay put, as the two at the foot do.
    const after = form()
    expect(after.slice(2, 5)).toEqual(before.slice(2 + NOTCH, 5 + NOTCH))
  })

  // What Ghostty sent for a swipe up or down on a trackpad: the wheel that
  // way, two to a read as often as not, with a notch sideways on its own every
  // three or four — 66 left, 67 right — because no swipe is straight. pi-tui
  // read 66 as the right button, so a swipe over the agents or the files
  // opened the menu of whatever it crossed, and every notch after it went to
  // that menu instead of the list under it.
  const swipe = (at: { col: number; row: number }, way: 64 | 65) => {
    const report = (button: number) => `\x1b[<${button};${at.col + 2};${at.row + 1}M`
    terminal.type(`${report(way)}${report(way)}`)
    terminal.type(report(66))
    terminal.type(`${report(way)}${report(way)}`)
    terminal.type(report(67))
    terminal.type(report(way))
  }
  /**
   * A chain five deep behind an agent that has not started, so nothing in it
   * starts and the side is wider than its pane: a bar along its bottom, and
   * the chain's picture beside it with one of its own.
   */
  const chainFiveDeep = async () => {
    let before = 'app/refunds'
    for (const slug of ['look-first', 'then-reproduce', 'then-fix-it', 'then-test', 'then-ship']) {
      const after = [{ task: before, why: 'it needs that first' }]
      const made = await client.createTask({
        project: 'app',
        slug,
        intent: slug,
        start: { after, prompt: '', touches: [] },
      })
      before = made.id
    }
    terminal.columns = 100
    terminal.rows = 30
    await start()
    await until('the chain', () => terminal.written.includes('then-reproduce'))
  }
  const rightClick = (at: { col: number; row: number }) => {
    terminal.press(`\x1b[<2;${at.col + 2};${at.row + 1}M`)
    terminal.press(`\x1b[<2;${at.col + 2};${at.row + 1}m`)
  }

  it('scrolls an agent swiped over on a trackpad, and opens no menu for it', async () => {
    // Short of room, so the side has somewhere to scroll to.
    terminal.columns = 100
    terminal.rows = 20
    await start()
    // The agent's own row in the side, drawn, as the file swipe below waits
    // for it: at this width the header says `search` beside ctrl+k.
    await until('both agents', () =>
      screenOf(terminal.written).some((row) => row.includes('○ search')),
    )
    const heading = screenOf(terminal.written).findIndex((row) => row.includes('AGENTS'))
    const atTop = () => (screenOf(terminal.written)[heading] ?? '').includes('AGENTS')
    const said = terminal.written.length
    const agent = find(' search')
    swipe(agent, 65)
    await until('the side to scroll under the swipe', () => !atTop())
    // And back up it, as far as it goes, drifting the same way.
    await until('the side back at its top', () => {
      swipe(agent, 64)
      return atTop()
    })
    expect(terminal.written.slice(said)).not.toContain('Mark finished')
    // The right button is still the right button.
    rightClick(find(' search'))
    await until('the menu', () => terminal.written.includes('Mark finished'))
  })

  it('scrolls a file swiped over on a trackpad, and opens no menu for it', async () => {
    terminal.columns = 100
    terminal.rows = 20
    await start()
    // The agent's own row in the side, drawn: the header says `search` beside
    // ctrl+k from its first frame, while AGENTS can still say *looking…*, and
    // a side found on the header is a notch that moves nothing.
    await until('both agents', () =>
      screenOf(terminal.written).some((row) => row.includes('○ search')),
    )
    // Down the side a notch at a time until a file comes into view at its foot,
    // by the wheel and nothing else.
    const side = find(' search')
    const fileRow = () => screenOf(terminal.written).findIndex((row) => row.includes('README.md'))
    for (let notch = 0; notch < 20 && fileRow() < 0; notch++) {
      const was = screenOf(terminal.written).join('\n')
      terminal.press(`\x1b[<65;${side.col + 2};${side.row + 1}M`)
      await until('the side to move', () => screenOf(terminal.written).join('\n') !== was)
    }
    const file = find('README.md')
    const said = terminal.written.length
    swipe(file, 65)
    await until('the side to scroll on under the swipe', () => {
      const now = fileRow()
      return now >= 0 && now < file.row
    })
    expect(terminal.written.slice(said)).not.toContain('Copy relative path')
    rightClick(find('README.md'))
    await until('the menu', () => terminal.written.includes('Copy relative path'))
  })

  it('scrolls a queue that slides up and down under a swipe, and never slides it', async () => {
    // The notches a swipe drifts sideways are the hand, not a way to go: each
    // slid the side a column under somebody only scrolling up and down it.
    await chainFiveDeep()
    const queued = find('then-reproduce')
    swipe(queued, 65)
    await until('the side to scroll under the swipe', () => find('then-reproduce').row < queued.row)
    expect(find('then-reproduce').col).toBe(queued.col)
  })

  it('slides the queue and its picture for a notch sideways, and moves nothing else', async () => {
    await chainFiveDeep()
    const queued = find('then-reproduce')
    const agent = find(' refunds')
    const said = terminal.written.length
    const notch = (button: number, at: { col: number; row: number }) =>
      terminal.press(`\x1b[<${button};${at.col + 2};${at.row + 1}M`)
    // Left, with nothing to the left: nowhere to go, and never up instead.
    notch(66, queued)
    // Right: the side slides, the chain with it.
    notch(67, queued)
    await until('the queue to slide', () => find('then-reproduce').col < queued.col)
    expect(find(' refunds').row).toBe(agent.row)
    expect(terminal.written.slice(said)).not.toContain('Do this one first')
    // The picture slides under it too, the boxes with the names in them.
    const box = find('\u2502 \u25cb refunds')
    notch(67, box)
    notch(67, box)
    await until(
      'the picture to slide',
      () => !screenOf(terminal.written)[box.row]?.includes('\u2502 \u25cb refunds'),
    )
    // And left comes back.
    notch(66, find('then-reproduce'))
    await until('the queue to slide back', () => find('then-reproduce').col === queued.col)
  })

  it('asks for a caret over words and fields and a hand over controls, where it can', async () => {
    // Ghostty puts the arrow up once a program reports the mouse, and keeps it
    // until it is asked for another: what the window never asks for there is
    // an arrow — which over the conversation, an agent's screen and a search
    // box was everything that was not the line itself. Read when the window
    // opens, so it is only set for that.
    terminal.columns = 100
    terminal.rows = 30
    const was = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'ghostty'
    try {
      await start()
    } finally {
      if (was === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = was
    }
    await until('the first frame', () => terminal.written.includes('Ask Tade anything'))
    const caret = '\x1b]22;text\x1b\\'
    const hand = '\x1b]22;pointer\x1b\\'
    /** Moved over a label with no button held, and what the terminal was asked for after. */
    const over = async (label: string, shape: string) => {
      const at = find(label)
      const said = terminal.written.length
      terminal.press(`\x1b[<35;${at.col + 2};${at.row + 1}M`)
      await until(`${shape === caret ? 'a caret' : 'a hand'} over ${label}`, () =>
        terminal.written.slice(said).includes(shape),
      )
    }
    await over('Settings', hand)
    await over('Ask Tade anything', caret)
    await over('Extensions', hand)
    // A box you type a search into is a control and a field at once: a caret.
    terminal.press('\x1b[44;5u')
    await until('the settings panel', () => terminal.written.includes('search settings'))
    await over('search settings', caret)
    await over('Models', hand)
  })

  it('moves an agent to where it is dragged in the list, and remembers it there', async () => {
    await start()
    await until('both agents', () => {
      const lines = screenOf(terminal.written)
      return (
        lines.some((row) => row.includes('refunds')) && lines.some((row) => row.includes('search'))
      )
    })
    const from = find('refunds')
    const to = find('search')
    expect(from.row).toBeLessThan(to.row)
    // Pressed, moved with the button held, and let go over the other agent.
    terminal.press(`\x1b[<0;${from.col + 1};${from.row + 1}M`)
    terminal.press(`\x1b[<32;${from.col + 1};${from.row + 2}M`)
    terminal.press(`\x1b[<32;${from.col + 1};${to.row + 1}M`)
    terminal.press(`\x1b[<0;${from.col + 1};${to.row + 1}m`)
    await until('the new order on screen', () => find('search').row < find('refunds').row)
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.order.app.indexOf('app/search')).toBeLessThan(kept.order.app.indexOf('app/refunds'))
  })

  it('types to the orchestrator when clicked, and leaves the agent in view', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const strip = find('orchestrator')
    terminal.written = ''
    click(strip.col + 2, strip.row)
    await until('the line to open', () => terminal.written.includes('here'))
    // The pane still says whose agent it is.
    expect(screenOf(terminal.written).join('\n')).not.toContain('Nothing is running')
  })

  it('counts a click as somebody here, as a key is', async () => {
    const running = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const state = () => (running as unknown as { wire: { state: AppState } }).wire.state
    expect(state().lastKeyAt).toBeNull()
    const before = Date.now()
    const strip = find('orchestrator')
    click(strip.col + 2, strip.row)
    // A click reaches the pointer and never `Keyboard.onInput`, which is what
    // stamps a key: presence and push read this, not `presses`.
    expect(state().lastKeyAt).toBeGreaterThanOrEqual(before)
  })

  it('keeps what was half-written at the orchestrator while focus is elsewhere', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const strip = find('orchestrator')
    click(strip.col + 2, strip.row)
    await until('the line to open', () => terminal.written.includes('here'))
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )
    // Off to an agent: the line closes, and the words on it are not the
    // window's to throw away.
    terminal.press('\t')
    await until('the line to close', () =>
      screenOf(terminal.written).every((row) => !row.includes('why is refunds slow')),
    )
    click(strip.col + 2, strip.row)
    await until('the half-written line, exactly where it was left', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )
  })

  it('moves the sidebar edge where it is dragged, and remembers it', async () => {
    terminal.columns = 120
    terminal.rows = 40
    const running = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('AGENTS'))
    const edge = (lines[row] ?? '').indexOf('│')
    expect(edge).toBeGreaterThan(10)
    // Press on the edge, move with the button held, let go.
    terminal.press(`\x1b[<0;${edge + 1};${row + 1}M`)
    terminal.press(`\x1b[<32;${edge + 11};${row + 1}M`)
    terminal.press(`\x1b[<0;${edge + 11};${row + 1}m`)
    await until('the new edge', () => {
      const after = screenOf(terminal.written)[row] ?? ''
      return after.indexOf('│') === edge + 10 || after.indexOf('┃') === edge + 10
    })
    await running.stop()
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.sidebarWidth).toBe(edge + 10)
  })
})
