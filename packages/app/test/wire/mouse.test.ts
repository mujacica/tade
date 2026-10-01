import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTCH } from '../../src/scroll.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What a click, a drag and a right-click land on: the bar down a side, the
// edge between two panes, an agent dragged up the list.

describe('the window, under the pointer', () => {
  let terminal: FakeTerminal
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    home = wired.home
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
