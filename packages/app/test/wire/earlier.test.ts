import type { HistoryAsk, HistoryItem, HistoryPage } from '@tade/harnesses-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// Opening the window again on a conversation that never ended: the
// orchestrator takes it up where it stopped, and now so does the screen.

/** The record's two pages, newest last, as an adapter would hand them over. */
const NEWEST: HistoryPage = {
  items: [
    {
      kind: 'sent',
      text: 'Since you last heard from Tade:\n- 13:51 shop finished\n\nWhat they said:\nwhat is running?',
      images: [],
      at: 3,
    },
    { kind: 'tool', id: 't1', tool: 'tade_status', input: {}, ok: true, result: '', at: 4 },
    { kind: 'reply', text: 'Two agents are working.', at: 5 },
    { kind: 'sent', text: 'check the build', images: [], at: 6 },
    { kind: 'reply', text: 'The build is green.', at: 7 },
  ],
  earlier: '2048',
}
const OLDEST: HistoryItem[] = [
  { kind: 'sent', text: 'What they said:\nthe very first question', images: [], at: 1 },
  { kind: 'reply', text: 'The very first answer.', at: 2 },
]

describe('the conversation, when the window opens again', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })
  const screen = () => screenOf(terminal.written).join('\n')

  /** A record that answers each page once, and says which it was asked for. */
  function record(asked: (string | null)[]): (ask: HistoryAsk) => Promise<HistoryPage> {
    return async (ask) => {
      asked.push(ask.before ?? null)
      return ask.before === '2048' ? { items: OLDEST, earlier: null } : NEWEST
    }
  }

  it('shows what was said before it closed, newest at the bottom, and reads further back from the top', async () => {
    const asked: (string | null)[] = []
    await start({ history: record(asked) })
    await until('the last page on screen', () => screen().includes('The build is green.'))
    expect(asked).toEqual([null])
    // Scrolled to its newest line, as a conversation always opens.
    expect(screen()).toContain('Two agents are working.')
    // Never said by the person as far as the journal knows, so Tade's.
    expect(screen()).toContain('told the orchestrator: check the build')

    // The wheel up over the conversation goes back through it, and past its
    // top reads the page before.
    const rows = screenOf(terminal.written)
    const row = rows.findIndex((line) => line.includes('The build is green.'))
    for (let notch = 0; notch < 40 && asked.length < 2; notch++) {
      terminal.press(`\x1b[<64;10;${row + 1}M`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(terminal.written).toContain('❯ what is running?')
    expect(terminal.written).toContain('told the orchestrator: shop finished')
    await until('the page before it read', () => asked.length === 2)
    expect(asked).toEqual([null, '2048'])
    await until('the first answer on screen', () => screen().includes('The very first answer.'))
    expect(screen()).not.toContain('said before this')
  })

  it("draws a sentence under no heading as the person's when the journal says they said it", async () => {
    await client.log.append({ type: 'said', task: null, detail: { text: 'check the build' } })
    await start({ history: record([]) })
    await until('the last page on screen', () => screen().includes('The build is green.'))
    expect(screen()).toContain('❯ check the build')
    expect(screen()).not.toContain('told the orchestrator: check the build')
  })

  it('says a record it could not read, rather than drawing an empty conversation', async () => {
    await start({
      history: async () => {
        throw new Error('could not read /x.jsonl: EACCES')
      },
    })
    await until('the reason in the conversation', () =>
      screen().includes('could not read what was said before'),
    )
  })

  it('starts empty, as it always did, with no record to read', async () => {
    await start()
    expect(screen()).not.toContain('said before this')
  })
})
