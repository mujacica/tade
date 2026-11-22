import { join } from 'node:path'
import { compareStamps, MAX_DRIFT_MS, StampAhead, stampOf, stampText } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog, readJournal } from '../src/events.ts'

// Every `config_changed` line is stamped by the journal that writes it
// (`setting-stamps.ts`): later than every stamp before it, the stamp the
// setting held when it changed beside it, and another machine's stamp kept as
// it came — which is what two machines settle a setting by (`settle`).

describe('a setting’s stamp', () => {
  const open = (path: string) => EventLog.open({ path, indexPath: null, machine: 'mac' })
  const change = (path: string, extra: Record<string, string> = {}) => ({
    type: 'config_changed' as const,
    detail: { path, was: '', now: 'x', by: 'window', ...extra },
  })

  it('is later than every one before it, and says what it was made over', async () => {
    const path = join(tmp('tade-stamps-'), 'events.jsonl')
    const log = await open(path)
    const first = await log.append(change('agents.commit'))
    const second = await log.append(change('agents.commit'))
    const block = await log.append(change('agents'))
    await log.append({ type: 'warning', detail: { message: 'not a setting' } })
    await log.close()
    const one = stampOf(first.detail.hlc)
    const two = stampOf(second.detail.hlc)
    expect(one?.machine).toBe('mac')
    expect(compareStamps(two, one)).toBeGreaterThan(0)
    expect(first.detail.over).toBeUndefined()
    expect(second.detail.over).toBe(first.detail.hlc)
    // A block written whole is made over the newest stamp inside it.
    expect(block.detail.over).toBe(second.detail.hlc)
  })

  it('keeps another machine’s stamp as it came, and writes nothing earlier after it', async () => {
    const path = join(tmp('tade-stamps-'), 'events.jsonl')
    const log = await open(path)
    // A machine whose clock is four minutes ahead, carried here: inside the bound.
    const ahead = stampText({ wall: Date.now() + 4 * 60_000, count: 4, machine: 'vps' })
    const carried = await log.append(
      change('queue.holds', { carried: 'vps', hlc: ahead, origin: 'window' }),
    )
    expect(carried.detail.hlc).toBe(ahead)
    const after = await log.append(change('agents.push'))
    expect(compareStamps(stampOf(after.detail.hlc), stampOf(ahead))).toBeGreaterThan(0)
    await log.close()
  })

  it('refuses a stamp from a clock further ahead than the bound, and moves nothing', async () => {
    const path = join(tmp('tade-stamps-'), 'events.jsonl')
    const log = await open(path)
    // A machine whose clock is a day ahead: taking it would drag this clock,
    // and every machine this one carries to, a day ahead for good.
    const wrong = stampText({
      wall: Date.now() + MAX_DRIFT_MS + 86_400_000,
      count: 0,
      machine: 'vps',
    })
    await expect(
      log.append(change('queue.holds', { carried: 'vps', hlc: wrong })),
    ).rejects.toBeInstanceOf(StampAhead)
    const after = await log.append(change('agents.push'))
    await log.close()
    expect(stampOf(after.detail.hlc)?.wall ?? Number.POSITIVE_INFINITY).toBeLessThan(
      Date.now() + MAX_DRIFT_MS,
    )
    const written = (await readJournal(join(path, '..'), { types: ['config_changed'] })).map(
      (one) => one.detail.path,
    )
    expect(written).toEqual(['agents.push'])
  })

  it('carries on from the journal it is opened on, rather than from its own clock', async () => {
    const path = join(tmp('tade-stamps-'), 'events.jsonl')
    let log = await open(path)
    const ahead = stampText({ wall: Date.now() + 4 * 60_000, count: 0, machine: 'vps' })
    await log.append(change('queue.holds', { carried: 'vps', hlc: ahead }))
    await log.close()
    log = await open(path)
    const next = await log.append(change('queue.holds'))
    await log.close()
    expect(compareStamps(stampOf(next.detail.hlc), stampOf(ahead))).toBeGreaterThan(0)
    expect(next.detail.over).toBe(ahead)
  })
})
