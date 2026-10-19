import type { HistoryAsk, HistoryItem, HistoryPage } from '@tade/harnesses-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../src/model.ts'
import {
  type Entry,
  emptyTranscript,
  READ_FROM_END,
  type Transcript,
} from '../../src/transcript.ts'
import { Earlier } from '../../src/wire/earlier.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

type History = (ask: HistoryAsk) => Promise<HistoryPage>

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
    // The loop stops when the page before is *asked* for, which is a frame
    // before the top of this one is *drawn*: on a loaded machine that frame
    // has not landed yet, so wait for it rather than read it at once.
    await until(
      'the top of the last page drawn',
      () =>
        terminal.written.includes('❯ what is running?') &&
        terminal.written.includes('told the orchestrator: shop finished'),
    )
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

describe('reading back past what fell off the top', () => {
  /** Just enough of a window for `Earlier`: the conversation, and what puts it. */
  function windowOf(entries: Entry[], earlier: Transcript['earlier'], history: History) {
    let state = { transcript: { ...emptyTranscript(), entries, earlier } } as AppState
    const wire = {
      get state() {
        return state
      },
      put: (next: AppState) => {
        state = next
      },
      draw: () => {},
      now: () => 0,
      opts: { history, client: { events: async () => [] } },
    }
    return { earlier: new Earlier(wire as never), now: () => state.transcript }
  }
  const reply = (at: number): HistoryItem => ({ kind: 'reply', text: `r${at}`, at })
  const shown = (at: number): Entry => ({
    kind: 'said',
    text: `r${at}`,
    streaming: false,
    by: 'orchestrator',
    at,
  })

  it('reads the record from its end, passes over what is still shown, and puts only what is older above', async () => {
    // The record: r1…r9, a page of three at a time. Shown: r7…r9, with r1…r6 fallen off.
    const asked: (string | null)[] = []
    const history: History = async (ask) => {
      asked.push(ask.before ?? null)
      const end = ask.before === undefined || ask.before === null ? 9 : Number(ask.before)
      const from = Math.max(0, end - 3)
      const items = Array.from({ length: end - from }, (_, n) => reply(from + n + 1))
      return { items, earlier: from > 0 ? String(from) : null }
    }
    const held = windowOf(
      [shown(7), shown(8), shown(9)],
      { cursor: READ_FROM_END, asking: false },
      history,
    )
    expect(await held.earlier.more()).toBe(true)
    // r7…r9 were passed over on the way back; r4…r6 is the first page older than them.
    expect(asked).toEqual([null, '6'])
    expect(held.now().entries.map((one) => (one.kind === 'said' ? one.text : ''))).toEqual([
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
      'r9',
    ])
    expect(held.now().earlier).toEqual({ cursor: '3', asking: false })
    expect(await held.earlier.more()).toBe(true)
    expect(held.now().entries).toHaveLength(9)
    expect(held.now().earlier).toBeNull()
  })

  it('answers everybody asking while it reads with the one read, and says a record that could not be read', async () => {
    let reads = 0
    const history: History = async () => {
      reads += 1
      throw new Error('could not read /x.jsonl: EACCES')
    }
    const held = windowOf([shown(9)], { cursor: '4', asking: false }, history)
    const [one, two] = await Promise.all([held.earlier.more(), held.earlier.more()])
    expect([one, two]).toEqual([false, false])
    expect(reads).toBe(1)
    expect(held.now().earlier).toEqual({ cursor: '4', asking: false })
  })
})
