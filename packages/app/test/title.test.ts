import { describe, expect, it } from 'vitest'
import { COLOUR, markLabel, PLAIN } from '../src/skin.ts'
import { type TitleFacts, titleMark, windowTitle } from '../src/title.ts'

// What the terminal window calls itself, and the corner mark it is drawn
// beside: both are read at a glance and neither may depend on a terminal.

const quiet: TitleFacts = {
  working: 0,
  waiting: 0,
  failed: 0,
  agents: 0,
  orchestrator: 'quiet',
  where: null,
  now: 0,
}

describe('the window title', () => {
  it('says nothing is running when nothing is', () => {
    expect(windowTitle(quiet)).toBe('· tade · nothing running')
  })

  it('counts the agents in the sidebar’s own words', () => {
    const title = windowTitle({ ...quiet, working: 2, waiting: 1, failed: 1, agents: 4 })
    expect(title).toContain('2 working')
    expect(title).toContain('1 waiting')
    expect(title).toContain('1 failed')
  })

  it('says the agents are idle rather than saying nothing about them', () => {
    expect(windowTitle({ ...quiet, agents: 3 })).toBe('● tade · 3 idle')
  })

  it('says what the orchestrator is doing, not only the agents', () => {
    expect(windowTitle({ ...quiet, agents: 1, orchestrator: 'thinking' })).toContain('thinking')
    expect(windowTitle({ ...quiet, orchestrator: 'listening' })).toContain('listening')
  })

  it('turns while anything works, so the title itself shows movement', () => {
    const working = { ...quiet, working: 1, agents: 1 }
    const frames = new Set([0, 100, 200, 300].map((now) => titleMark({ ...working, now })))
    expect(frames.size).toBe(4)
    // And stands still when nothing does: an indicator that always spins says nothing.
    expect(titleMark({ ...quiet, agents: 1, now: 100 })).toBe(
      titleMark({ ...quiet, agents: 1, now: 900 }),
    )
  })

  it('shows the microphone above everything else: that is never inferred', () => {
    expect(titleMark({ ...quiet, working: 3, orchestrator: 'listening' })).toBe('⏺')
    expect(titleMark({ ...quiet, waiting: 1, failed: 1 })).toBe('!')
    expect(titleMark({ ...quiet, failed: 1 })).toBe('✕')
  })

  it('drops where you are before what is happening, and never overflows a tab', () => {
    const facts = { ...quiet, working: 2, agents: 2, where: 'tade › ui-chrome' }
    expect(windowTitle(facts)).toContain('tade › ui-chrome')

    const long = windowTitle({ ...facts, where: 'a-very-long-project › '.repeat(4) })
    expect(long).toContain('2 working')
    expect(long).not.toContain('a-very-long-project')
    expect(long.length).toBeLessThanOrEqual(72)
  })
})

describe('the corner mark', () => {
  it('takes the same room painted as plain, so the top row never shifts', () => {
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
    expect(COLOUR.mark('TADE').replace(ansi, '')).toBe(PLAIN.mark('TADE'))
  })

  it('is the tab you are on, spelt out: one drawing, so the two cannot drift', () => {
    const mark = COLOUR.mark('TADE')
    // Bright amber ground, dark ink — the project button beside it, to the byte.
    expect(mark).toContain('48;5;214m')
    expect(mark).toContain('38;5;233m')
    expect(mark).toBe(COLOUR.tabbed(markLabel('TADE'), true, false))
    // Capitals, a space between each: the whole of what makes it a mark.
    expect(mark).toContain('T A D E')
  })
})
