import type { LaneId } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { GROWN_HOLD_MS, resolveLayout } from '../../src/layout.ts'
import { BAR } from '../../src/scrollbar.ts'
import type { ThinkerEvent } from '../../src/transcript.ts'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// What size each agent is made, and when it is told.
//
// Telling a lane its size is telling the program in it, which draws its whole
// screen again in answer. The agent in front was told twice a turn because
// somebody spoke to the orchestrator, and up to thirty times a second while
// the window was being dragged.

describe('the size each agent is made', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  /** An agent's lane for one of the fixture's tasks, saying its name and then nothing. */
  const agent = (name: string) =>
    client.spawn({
      id: `app/${name}/agent` as LaneId,
      task: `app/${name}`,
      kind: 'agent',
      cwd: repo.root,
      command: process.execPath,
      args: ['-e', `console.log('${name.toUpperCase()} OWN WORDS'); setInterval(() => {}, 60_000)`],
    })

  /** Every size a lane was told, in order. */
  const told = () => {
    const sizes: { lane: string; cols: number; rows: number }[] = []
    const resize = client.resize.bind(client)
    client.resize = (lane, cols, rows) => {
      sizes.push({ lane, cols, rows })
      return resize(lane, cols, rows)
    }
    return sizes
  }

  /** Waited out by looks rather than by a clock: what a look decides is per look. */
  const looks = async (count: number) => {
    let seen = 0
    const screen = client.screen.bind(client)
    client.screen = (lane) => {
      seen++
      return screen(lane)
    }
    await until(`${count} looks`, () => seen >= count, SPAWNING_MS)
    client.screen = screen
  }

  it('never tells the agent in front a size because somebody spoke to the orchestrator', async () => {
    await agent('refunds')
    // Tall enough that a conversation going on takes rows the pane had.
    terminal.resize(120, 45)
    const sizes = told()
    let emit: (event: ThinkerEvent) => void = () => {}
    let answer: (text: string) => void = () => {}
    let skew = 0
    await start({
      now: () => Date.now() + skew,
      thinker: {
        ask: () => new Promise<string>((resolve) => (answer = resolve)),
        onEvent: (listener) => {
          emit = listener
          return () => {}
        },
      },
    })
    const shown = () => screenOf(terminal.written)
    await until('refunds in front', () => shown().some((row) => row.includes('REFUNDS OWN')))
    await until('made the size of its pane', () =>
      sizes.some((one) => one.lane.includes('refunds')),
    )
    const before = sizes.length
    // Where the tabs below are, which is how tall the conversation is.
    const tabs = () => shown().findIndex((row) => row.includes('orchestrator') && row.includes('━'))
    const resting = tabs()

    terminal.press('\x00')
    for (const char of 'what is refunds doing') terminal.press(char)
    terminal.press('\r')
    await until('the conversation given room', () => tabs() < resting)
    emit({ type: 'message', text: 'It is retrying the charge.' })
    emit({ type: 'idle' })
    answer('It is retrying the charge.')
    await until('the answer', () => shown().some((row) => row.includes('retrying the charge')))
    // The turn is over and the answer is still being read: the room stays
    // while the line is open, and the agent's newest rows are what show.
    await looks(5)
    expect(tabs()).toBeLessThan(resting)
    expect(shown().some((row) => row.includes('REFUNDS OWN'))).toBe(true)

    // Off the line, and a while after the turn: the room goes back.
    terminal.press('\x1b')
    skew += GROWN_HOLD_MS
    await until('the room given back', () => tabs() === resting)
    await looks(5)
    // Over all of it, the agent was never told another size.
    expect(sizes.slice(before)).toEqual([])
  })

  it('tells every lane in the project its new size once, when the window holds still', async () => {
    await agent('refunds')
    await agent('search')
    // And a terminal below, with the orchestrator's tab in front of it.
    const below = await client.openTerminal({ project: 'app' })
    const sizes = told()
    await start()
    await until('refunds in front', () =>
      screenOf(terminal.written).some((row) => row.includes('REFUNDS OWN')),
    )
    // All of them made the size they are drawn at: the one in front at once,
    // and the ones behind it as well, so going to one is not watching it reflow.
    const lanes = ['app/refunds/agent', 'app/search/agent', below.id]
    const all = () => lanes.every((lane) => sizes.some((one) => one.lane === lane))
    await until('every lane made the size it is drawn at', all, SPAWNING_MS)
    await looks(3)
    sizes.length = 0

    // A window dragged by its corner: one size after another, faster than a look.
    terminal.resize(100, 30)
    terminal.resize(110, 36)
    terminal.resize(120, 40)
    await until('every lane told the new size', all, SPAWNING_MS)
    await looks(5)

    // Once each, and the size it came to rest at rather than one it passed through.
    const layout = resolveLayout({}, { width: 120, height: 40 })
    const pane = { cols: layout.mainWidth - BAR, rows: layout.bodyHeight - 2 }
    const strip = {
      cols: layout.sidebarWidth + layout.mainWidth + 1 - BAR,
      rows: layout.stripHeight - 2,
    }
    expect(sizes.map((one) => one.lane).sort()).toEqual([...lanes].sort())
    for (const one of sizes) {
      expect({ cols: one.cols, rows: one.rows }).toEqual(one.lane === below.id ? strip : pane)
    }
  })
})
