import type { Note, TadeEvent } from '@tade/core'
import { ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { FakeAdapter } from '../../workbench/test/workers-harness.ts'
import { ORCHESTRATOR_RUN, Orchestrator } from '../src/orchestrator.ts'

// What the orchestrator was told, what its conversation holds, and making that
// conversation shorter without losing it — against a scripted harness, so what
// is under test is the bookkeeping and never a model.

const note = (text: string, by = 'you'): Note => ({
  text,
  scope: null,
  by,
  at: new Date().toISOString(),
})

/** A harness that takes Tade's tools as a server, and comes back to a conversation if asked to. */
function harness(over: { pins?: boolean; going?: boolean } = {}): FakeAdapter {
  const adapter = new FakeAdapter()
  adapter.capabilities.mcp = true
  adapter.capabilities.pins = over.pins ?? false
  if (over.pins) adapter.capabilities.why.pins = 'declares what a conversation was first told'
  adapter.hasConversation = async () => over.going ?? true
  return adapter
}

/** The line a window writes once it has started, saying what its conversation holds. */
const toldLine = (detail: Record<string, unknown>): TadeEvent =>
  ({
    seq: 1,
    ts: new Date().toISOString(),
    type: 'orchestrator_told',
    urgency: 'routine',
    task: null,
    lane: null,
    detail,
  }) as TadeEvent

describe('what the orchestrator was told, and what it holds', () => {
  const started: Orchestrator[] = []
  afterEach(async () => {
    for (const one of started.splice(0)) await one.stop()
  })

  const start = async (
    adapter: FakeAdapter,
    over: Partial<Parameters<typeof Orchestrator.start>[0]> = {},
  ) => {
    const runDir = tmp('tade-keeping-run-')
    const one = await Orchestrator.start({
      home: tmp('tade-keeping-'),
      socket: '/nowhere.sock',
      runDir,
      cwd: runDir,
      config: ConfigSchema.parse({}),
      adapter,
      ...over,
    })
    started.push(one)
    return one
  }

  it('tells the harness what it composed, and fingerprints it in three parts', async () => {
    const adapter = harness()
    const one = await start(adapter, { notes: [note('ship on fridays')] })
    expect(adapter.starts[0]?.extras?.instructions).toContain('ship on fridays')
    const told = one.told?.told
    expect(Object.keys(told ?? {})).toEqual(['tools', 'instructions', 'notes'])
    // Another note changes the notes, and only the notes.
    const again = await start(harness(), { notes: [note('ship on fridays'), note('not mondays')] })
    expect(again.told?.told.notes).not.toBe(told?.notes)
    expect(again.told?.told.instructions).toBe(told?.instructions)
    expect(again.told?.told.tools).toBe(told?.tools)
  })

  it('holds whatever a harness that pins nothing is told at each launch', async () => {
    const before = (await start(harness(), { notes: [note('a')] })).told?.told
    const one = await start(harness({ pins: false }), {
      notes: [note('a'), note('b')],
      toldBefore: [toldLine({ ...before, holds: true })],
    })
    expect(one.told?.stale).toEqual([])
  })

  it('under a harness that pins, holds what it held — so a new note is not in it', async () => {
    const before = (await start(harness(), { notes: [note('a')] })).told?.told
    const one = await start(harness({ pins: true }), {
      notes: [note('a'), note('b')],
      toldBefore: [toldLine({ ...before, holds: true })],
    })
    expect(one.told?.stale).toEqual(['notes'])
    expect(one.told?.known).toBe(true)
  })

  it('cannot say what a pinned conversation holds when nothing was written down', async () => {
    const one = await start(harness({ pins: true }), { toldBefore: [] })
    expect(one.told?.stale).toEqual(['tools', 'instructions', 'notes'])
    expect(one.told?.known).toBe(false)
  })

  it('holds what a new conversation is told, pinned or not: it was told nothing before', async () => {
    const one = await start(harness({ pins: true, going: false }), { toldBefore: [] })
    expect(one.told?.stale).toEqual([])
  })

  it('compacts through its harness, holds what it was told after, and says how full it is', async () => {
    const adapter = harness({ pins: true })
    const one = await start(adapter, { toldBefore: [] })
    adapter.emit(ORCHESTRATOR_RUN, { type: 'context', tokens: 170_000, percent: 85 })
    expect(one.context).toBe(85)
    await one.compact()
    expect(adapter.compacted).toEqual([ORCHESTRATOR_RUN])
    expect(one.context).toBe(12)
    expect(one.told?.stale).toEqual([])
    expect(one.busy).toBe(false)
  })

  it('never compacts across a turn', async () => {
    const adapter = harness()
    const one = await start(adapter)
    await one.ask('where are we')
    await expect(one.compact()).rejects.toThrow('compacts only between turns')
    expect(adapter.compacted).toEqual([])
  })

  it('says why a compaction failed, keeps what it did not do, and is free again', async () => {
    const adapter = harness({ pins: true })
    const one = await start(adapter, { toldBefore: [] })
    adapter.compactFails = 'Not enough messages to compact.'
    await expect(one.compact()).rejects.toThrow('Not enough messages to compact.')
    expect(one.told?.stale).toHaveLength(3)
    expect(one.busy).toBe(false)
  })
})
