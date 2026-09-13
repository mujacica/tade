import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Memory } from '../src/memory.ts'
import { Workbench } from '../src/workbench.ts'

// Notes cannot be re-derived from anything, so the two things that matter are
// that they survive a restart and that one bad line never costs you the rest.

const NOW = Date.parse('2026-09-12T10:00:00Z')

describe('Memory', () => {
  it('has nothing to say before it is told anything', () => {
    const memory = Memory.open(tmp('wilco-mem-'))
    expect(memory.all()).toEqual([])
    expect(memory.recall('checkout/refunds')).toEqual([])
  })

  it('keeps what it was told, and survives a restart', () => {
    const home = tmp('wilco-mem-')
    const memory = Memory.open(home)
    memory.remember('the staging key rotates on the 1st', 'checkout', 'test', NOW)

    // A new window, the same file: this is the only copy there is.
    const reopened = Memory.open(home)
    expect(reopened.all().map((n) => n.text)).toEqual(['the staging key rotates on the 1st'])
    expect(reopened.recall('checkout/refunds').map((n) => n.text)).toEqual([
      'the staging key rotates on the 1st',
    ])
  })

  it('is append-only, one note per line', () => {
    const home = tmp('wilco-mem-')
    const memory = Memory.open(home)
    memory.remember('first', null, 'test', NOW)
    memory.remember('second', null, 'test', NOW + 1000)
    const lines = readFileSync(join(home, 'memory.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').text).toBe('first')
  })

  it('scopes what it gives back', () => {
    const home = tmp('wilco-mem-')
    const memory = Memory.open(home)
    memory.remember('I work from home on Fridays', null, 'test', NOW)
    memory.remember('the webhook retries twice', 'checkout/refunds', 'test', NOW + 1000)
    memory.remember('cursor, not offset', 'search/pagination', 'test', NOW + 2000)

    expect(memory.recall('checkout/refunds').map((n) => n.text)).toEqual([
      'the webhook retries twice',
      'I work from home on Fridays',
    ])
    expect(memory.recall('search/pagination').map((n) => n.text)).not.toContain(
      'the webhook retries twice',
    )
  })

  it('skips a line it cannot read rather than losing the file', () => {
    const home = tmp('wilco-mem-')
    const memory = Memory.open(home)
    memory.remember('worth keeping', null, 'test', NOW)
    // A torn write, or someone editing the file by hand.
    appendFileSync(join(home, 'memory.jsonl'), '{"text":"half a lin\n')
    appendFileSync(join(home, 'memory.jsonl'), '{"nothing":"like a note"}\n')
    memory.remember('also worth keeping', null, 'test', NOW + 1000)

    const reopened = Memory.open(home)
    expect(reopened.all().map((n) => n.text)).toEqual(['also worth keeping', 'worth keeping'])
  })

  it('starts clean when the file is gibberish, instead of refusing to start', () => {
    const home = tmp('wilco-mem-')
    writeFileSync(join(home, 'memory.jsonl'), 'not json at all\n\n')
    expect(Memory.open(home).all()).toEqual([])
  })
})

// Ordering is not asserted here: the handler stamps the time itself, so two
// notes written in the same millisecond tie. The rules about order are pinned
// in the core tests, where the clock is supplied.
describe('memory over the socket', () => {
  let home: string
  let client: Workbench

  beforeEach(async () => {
    home = tmp('wilco-mem-rpc-')
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('keeps what it is told, and gives it back for the task it is about', async () => {
    await client.remember('the webhook retries twice', 'checkout/refunds')
    await client.remember('the staging key rotates on the 1st', 'checkout')
    await client.remember('I work from home on Fridays', null)
    await client.remember('cursor, not offset', 'search/pagination')

    const notes = (await client.recall('checkout/refunds')).map((n) => n.text)
    expect([...notes].sort()).toEqual(
      [
        'I work from home on Fridays',
        'the staging key rotates on the 1st',
        'the webhook retries twice',
      ].sort(),
    )
    expect(notes).not.toContain('cursor, not offset')
  })

  it('tells you only the general things when you ask generally', async () => {
    await client.remember('I work from home on Fridays', null)
    await client.remember('the webhook retries twice', 'checkout/refunds')
    expect((await client.recall(null)).map((n) => n.text)).toEqual(['I work from home on Fridays'])
  })

  it('can give back everything, whatever it was about', async () => {
    await client.remember('one', null)
    await client.remember('two', 'checkout/refunds')
    expect((await client.recallAll()).map((n) => n.text).sort()).toEqual(['one', 'two'])
  })

  it('keeps what it was told across a restart', async () => {
    await client.remember('the staging key rotates on the 1st', 'checkout')
    await client.close()

    // A note cannot be re-derived from anything, so this file is the only copy.
    client = await Workbench.open({ home })
    expect((await client.recall('checkout/refunds')).map((n) => n.text)).toEqual([
      'the staging key rotates on the 1st',
    ])
  })
})
