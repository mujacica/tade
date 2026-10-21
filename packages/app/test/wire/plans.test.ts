import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import { describe, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// The Plans screen through the whole window: the task files name two efforts,
// and the key, the heading down the side, search and the button back each get
// you to what they say — out of the same folds the away view reads, over a real
// workbench and real task files.

describe('the Plans screen, in the window', () => {
  let terminal: FakeTerminal
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    home = wired.home
  })

  /** Each task file names an effort, the way a plan the orchestrator made does. */
  const effort = (task: string, name: string) => {
    const file = join(taskDir(home, task), 'task.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}effort: ${name}\n`)
  }

  const screen = () => screenOf(terminal.written).join('\n')

  it('opens on its key, every plan in it, and one plan from its name', async () => {
    effort('app/refunds', 'refund-flow')
    effort('app/search', 'search-speed')
    // Room for both plans' cards at once.
    terminal.columns = 140
    terminal.rows = 60
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // ctrl+shift+p, as a terminal that speaks kitty's protocol sends it.
    terminal.press('\x1b[112;6u')
    await until('every plan', () => screen().includes('plans  2 plans'))
    await until('both of them', () => screen().includes('search-speed'))
    const name = find('refund-flow')
    click(name.col, name.row)
    await until('that one plan', () => screen().includes('‹ plans'))
    await until('its stages', () => screen().includes('STAGE BY STAGE'))
    const back = find('‹ plans')
    click(back.col + 1, back.row)
    await until('every plan again', () => screen().includes('plans  2 plans'))
  })

  it('opens a plan from its heading down the side', async () => {
    effort('app/refunds', 'refund-flow')
    effort('app/search', 'search-speed')
    await start()
    await until('the headings', () => screen().includes('SEARCH-SPEED ›'))
    const heading = find('SEARCH-SPEED ›')
    click(heading.col, heading.row)
    await until('that plan', () => screen().includes('‹ plans'))
    await until('its name over it', () => /‹ plans[\s\]]+search-speed/.test(screen()))
  })

  it('finds a plan in search, and opens it', async () => {
    effort('app/refunds', 'refund-flow')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'flow') terminal.press(char)
    // Its agent is found too, by the plan it is part of; the plan is the row under it.
    await until('the plan in it', () => /PLANS \(1\)[\s\S]*refund-flow/.test(screen()))
    terminal.press('\x1b[B')
    await until('the plan chosen', () => /▌ ◌ refund-flow/.test(screen()))
    terminal.press('\r')
    await until('that plan', () => /‹ plans[\s\]]+refund-flow/.test(screen()))
  })
})
