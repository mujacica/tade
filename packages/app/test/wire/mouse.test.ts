import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  }, 30_000)

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
  }, 30_000)
})
