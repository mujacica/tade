import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// A panel's page keys and arrows, pressed into a running window: what moves is
// what is on the screen. A panel that kept a scroll of its own past its last
// screen spent the presses on the way back that moved nothing, and one that
// paged from where it had been left — not from where its drawing had brought
// the keyboard's line — jumped back to somewhere nobody was reading.

const PAGE_DOWN = '\x1b[6~'
const PAGE_UP = '\x1b[5~'
const DOWN = '\x1b[B'
const F1 = '\x1bOP'

/** A file of numbered rows, each its own line, so a row on the screen says where it is. */
const rows = (count: number) =>
  `${Array.from({ length: count }, (_, i) => `row-${String(i + 1).padStart(3, '0')}`).join('\n')}\n`

describe('the window, paging a panel with its keys', () => {
  let terminal: FakeTerminal
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
  })

  /**
   * The body of the box with this title as it is on the screen now, a row a
   * line: inside its borders, without the two rows pinned at its foot, the
   * bar down its right or the mark on the keyboard's line.
   */
  function body(title: string): string[] {
    const screen = screenOf(terminal.written)
    const top = screen.findIndex((row) => row.includes(`─ ${title} `))
    if (top < 0) return []
    const left = screen[top]?.indexOf('╭') ?? -1
    const right = screen[top]?.indexOf('╮', left) ?? -1
    const bottom = screen.findIndex((row, i) => i > top && row[left] === '╰')
    if (left < 0 || right < 0 || bottom < 0) return []
    return screen.slice(top + 1, bottom - 2).map((row) =>
      row
        .slice(left + 1, right - 1)
        .replace('▶', ' ')
        .trimEnd(),
    )
  }

  it('pages the shortcuts sheet back a whole page from its end, however often it was paged down', async () => {
    terminal.rows = 24
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press(F1)
    await until('the sheet', () => body('Shortcuts').length > 10)
    const LAST = 'Everything else goes to the agent'
    expect(body('Shortcuts').some((row) => row.includes(LAST))).toBe(false)
    // Far more presses than there are pages: the sheet stops at its last screen.
    for (const _ of Array(12)) terminal.press(PAGE_DOWN)
    await until('its last screen', () => body('Shortcuts').at(-1)?.includes(LAST) === true)
    const end = body('Shortcuts')
    terminal.press(PAGE_UP)
    await until('a page back', () => body('Shortcuts')[0] !== end[0], 5_000)
    expect(body('Shortcuts')[10]).toBe(end[0])
  })

  it('pages the patch reader from where it is drawn while it follows the line the keyboard is on', async () => {
    repo.commit('a ledger', { 'ledger.ts': rows(3) })
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'the ledger is short' })
    writeFileSync(join(worktree, 'ledger.ts'), rows(123))
    terminal.rows = 44
    terminal.columns = 120
    await start()
    await until('its changed file in CHANGES', () =>
      screenOf(terminal.written).some((row) => row.includes('ledger.ts') && row.includes('+120')),
    )
    const changed = find('+120')
    terminal.press(`\x1b[<2;${changed.col + 1};${changed.row + 1}M`)
    terminal.press(`\x1b[<2;${changed.col + 1};${changed.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Read as a patch'))
    const item = find('Read as a patch')
    click(item.col, item.row)
    const reader = () => body('ledger.ts · ledger')
    await until('the patch', () => reader().some((row) => row.includes('row-004')))
    const opened = reader()
    // The first press lands on the first line added, and each after it a line
    // further: sixty of them is well past the foot of the view, which the
    // drawing follows the line down to.
    for (const _ of Array(60)) terminal.press(DOWN)
    await until('the view following the line', () => reader().at(-1)?.includes('row-063') === true)
    const shown = reader()
    expect(shown[0]).not.toBe(opened[0])
    terminal.press(PAGE_DOWN)
    await until('a page on', () => reader()[0] !== shown[0], 5_000)
    // From what was on the screen — not from the top, where it was left.
    expect(reader()[0]).toBe(shown[10])
  })
})
