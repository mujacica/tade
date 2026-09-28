import { join } from 'node:path'
import type { RunId } from '@tade/harnesses-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { continueRun } from '../src/sleep.ts'
import { FakeAdapter, logged } from './workers-harness.ts'

// An agent the machine cut off, told to carry on — the act, and the record
// that it was told.
//
// Who gets told is `core/src/sleep.ts` and when is `app/src/wire/sleep.ts`;
// what is under test here is the one thing that reaches an agent, so the
// agent is fake, nothing is spawned and the journal is a real one in a temp
// directory.

const HOUR = 60 * 60_000

/** A fake agent, a real journal, and the run about to be told to carry on. */
async function woken() {
  const log = await EventLog.open({ path: join(tmp('tade-sleep-'), 'events.jsonl') })
  onTestFinished(() => log.close())
  const adapter = new FakeAdapter()
  return { log, adapter, on: { adapter, task: 'app/refunds', log } }
}

describe('telling an agent the machine cut off to carry on', () => {
  it('is a nudge, and never its opening instruction again', async () => {
    // The whole of the rule that keeps a sleep from costing the work twice:
    // what goes is the nudge, and the instruction it was started with stays
    // where it was said — at its launch, once.
    const { adapter, on } = await woken()
    await continueRun('r1' as RunId, 3 * HOUR, on)
    expect(adapter.prompted).toHaveLength(1)
    expect(adapter.prompted[0]?.message).toContain('Carry on from where you stopped')
    expect(adapter.prompted[0]?.message).toContain('do not start the task over')
  })

  it('waits for a turn that turns out to be running rather than cutting across it', async () => {
    // A harness may have reconnected and picked its own turn back up while
    // the lid was still shut. Steered, this would land in the middle of that.
    const { adapter, on } = await woken()
    await continueRun('r1' as RunId, 90 * 60_000, on)
    expect(adapter.prompted[0]?.whenBusy).toBe('queue')
    expect(adapter.steered).toEqual([])
  })

  it('writes down that it was told, and how long the machine was away', async () => {
    // The one record that a gap in an agent's transcript was the machine and
    // not the agent: its own session cannot tell the two apart afterwards.
    const { log, on } = await woken()
    await continueRun('r1' as RunId, 90 * 60_000, on)
    const [written] = await logged(log, 'agent_continued')
    expect(written?.task).toBe('app/refunds')
    expect(written?.run).toBe('r1')
    expect(written?.detail).toMatchObject({ slept: '1h 30m', sleptMs: 90 * 60_000 })
  })

  it('writes nothing when the nudge did not land', async () => {
    // An `agent_continued` for a nudge that never reached an agent is worse
    // than none: whoever called this is what decides what to do about the
    // throw, and it cannot decide anything if the journal already said it
    // went fine.
    const { log, adapter, on } = await woken()
    adapter.prompt = async () => {
      throw new Error('the channel had gone')
    }
    await expect(continueRun('r1' as RunId, HOUR, on)).rejects.toThrow('the channel had gone')
    expect(await logged(log, 'agent_continued')).toEqual([])
  })
})
