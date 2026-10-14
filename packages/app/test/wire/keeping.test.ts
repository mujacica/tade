import type { Holding, ToldPrint } from '@tade/core'
import { ConfigSchema } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { ThinkerEvent } from '../../src/transcript.ts'
import type { Thinker } from '../../src/wire/context.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The orchestrator's conversation, kept in shape by the window so nobody has
// to: compacted before it fills, brought up to date when what it is told
// changed — never across a turn and never while somebody is typing to it —
// and each said in one line and written down.

const told: ToldPrint = { tools: 't1', instructions: 'i1', notes: 'n1' }

/** A thinker that does what it is asked and remembers it, and says what the test says it says. */
function scripted(over: Partial<Thinker> = {}) {
  const listeners: Array<(event: ThinkerEvent) => void> = []
  const state = {
    percent: 40 as number | null,
    holding: { told, stale: [], known: true, since: 1_000 } as Holding,
    compacted: 0,
    fails: null as string | null,
    /** What was on the line each time it was compacted, as the test last set it. */
    typingWhen: [] as boolean[],
    typing: false,
  }
  const thinker: Thinker = {
    ask: async () => 'ok',
    onEvent: (listener) => {
      listeners.push(listener)
      return () => {}
    },
    busy: () => false,
    offers: {
      harness: 'pi',
      interrupt: { support: 'live', shown: true, note: null },
      levels: [],
      compact: { support: 'idle', shown: true, note: 'compacts only between turns' },
    },
    compact: async () => {
      state.typingWhen.push(state.typing)
      if (state.fails) throw new Error(state.fails)
      state.compacted++
      state.percent = 9
      state.holding = { ...state.holding, stale: [], known: true }
    },
    context: () => state.percent,
    told: () => state.holding,
    ...over,
  }
  /** A turn ended: the moment the window looks first. */
  const turnEnded = () => {
    for (const listener of listeners) listener({ type: 'idle' })
  }
  return { thinker, state, turnEnded }
}

describe('the orchestrator’s conversation, kept by the window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  /** What is on screen, a wrapped line read as one: the transcript wraps at the window's width. */
  const shown = () =>
    screenOf(terminal.written)
      .map((row) => row.replace(/[│┃▕▏█▌]/g, ' ').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
  const logged = (type: 'orchestrator_told' | 'orchestrator_compacted') =>
    client.events({ types: [type] })
  const config = (compactAt: number) =>
    ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      orchestrator: { compact_at: compactAt },
    })

  it('writes down what it was told when it starts, and whether its conversation holds it', async () => {
    const { thinker } = scripted()
    await start({ thinker })
    await until(
      'the line about what it was told',
      async () => (await logged('orchestrator_told')).length === 1,
    )
    const [line] = await logged('orchestrator_told')
    expect(line?.detail).toMatchObject({ ...told, holds: true })
  })

  it('compacts it once its context is past the threshold, and says so in one line', async () => {
    const { thinker, state, turnEnded } = scripted()
    state.percent = 85
    await start({ thinker, config: config(80) })
    turnEnded()
    await until('the compaction', () => state.compacted === 1)
    await until('the line saying so', () => shown().includes('compacted the orchestrator at 85%'))
    await until('the journal', async () => (await logged('orchestrator_compacted')).length === 1)
    const [line] = await logged('orchestrator_compacted')
    expect(line?.detail).toMatchObject({ ...told, why: 'context', percent: 85, at: 80, after: 9 })
    // Shorter now: the next turn's end finds nothing to do.
    turnEnded()
    await until('another look', () => state.typingWhen.length === 1)
    expect(state.compacted).toBe(1)
  })

  it('waits while something is on the line, and compacts once it is empty', async () => {
    const { thinker, state, turnEnded } = scripted()
    await start({ thinker, config: config(80) })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Opening the line and typing: what is on it is somebody's question.
    terminal.press('\x00')
    for (const char of 'how is') terminal.press(char)
    state.typing = true
    // Full only now, so nothing could have been done before the typing began.
    // A compaction is asked for in the same breath as the look that decides
    // it, so one that happened here would already be written down.
    state.percent = 90
    turnEnded()
    expect(state.typingWhen).toEqual([])
    // Thrown away, and only now is the window free to act.
    terminal.press('\x03')
    state.typing = false
    turnEnded()
    await until('the compaction', () => state.compacted === 1)
    expect(state.typingWhen).toEqual([false])
  })

  it('leaves it to the harness at 0', async () => {
    const { thinker, state, turnEnded } = scripted()
    state.percent = 99
    await start({ thinker, config: config(0) })
    turnEnded()
    await until(
      'the line about what it was told',
      async () => (await logged('orchestrator_told')).length === 1,
    )
    turnEnded()
    expect(state.typingWhen).toEqual([])
  })

  it('brings a pinned conversation up to date by compacting it, and says what changed', async () => {
    const { thinker, state, turnEnded } = scripted()
    state.holding = { told, stale: ['tools'], known: true, since: 1_000 }
    await start({ thinker })
    turnEnded()
    await until('the line saying so', () =>
      shown().includes('refreshed the orchestrator: tools changed'),
    )
    const [line] = await logged('orchestrator_compacted')
    expect(line?.detail).toMatchObject({ ...told, why: 'told', changed: ['tools'], known: true })
    // It wrote down that it did not hold it when it started.
    expect((await logged('orchestrator_told'))[0]?.detail.holds).toBe(false)
  })

  it('says it cannot, once, where its harness cannot be asked to compact', async () => {
    const { thinker, state, turnEnded } = scripted({
      offers: {
        harness: 'codex',
        interrupt: { support: 'live', shown: true, note: null },
        levels: [],
        compact: { support: 'none', shown: false, note: 'has /compact only in its own terminal' },
      },
    })
    state.percent = 95
    await start({ thinker, config: config(80) })
    turnEnded()
    await until('the line saying it cannot', () =>
      shown().includes('codex has /compact only in its own terminal'),
    )
    expect(state.typingWhen).toEqual([])
  })

  it('says why a compaction failed, and does not try again at once', async () => {
    const { thinker, state, turnEnded } = scripted()
    state.percent = 95
    state.fails = 'Nothing to compact (session too small)'
    await start({ thinker, config: config(80) })
    turnEnded()
    await until('the line saying why', () => shown().includes('session too small'))
    turnEnded()
    turnEnded()
    expect(state.typingWhen).toHaveLength(1)
  })

  it('starts it again on the same conversation when a note it never heard changes what it is told', async () => {
    const { thinker, state } = scripted()
    const asked: number[] = []
    let restarted = 0
    let now: ToldPrint = told
    const app = await start({
      thinker,
      toldNow: async (since) => {
        asked.push(since)
        return now
      },
      restartThinker: async () => {
        restarted++
        app.attachThinker(scripted().thinker)
      },
    })
    await until(
      'the line about what it was told',
      async () => (await logged('orchestrator_told')).length === 1,
    )
    // A note it wrote itself changes nothing it would be told (`unheardNotes`).
    client.remember('its own note', null, 'orchestrator')
    await until('asked what it would be told', () => asked.length === 1)
    expect(asked).toEqual([state.holding.since])
    expect(restarted).toBe(0)
    // One somebody else wrote does.
    now = { ...told, notes: 'n2' }
    client.remember('not on fridays', null, 'you')
    await until('started again', () => restarted === 1)
    await until('the line saying so', () =>
      shown().includes('refreshed the orchestrator: notes changed'),
    )
    await until(
      'the line from the start after',
      async () => (await logged('orchestrator_told')).length === 2,
    )
    expect((await logged('orchestrator_told'))[1]?.detail.refreshed).toEqual(['notes'])
  })
})
