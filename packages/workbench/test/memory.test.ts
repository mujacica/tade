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
  it('forgets a note it is asked to, after a restart too, and keeps both lines', () => {
    const home = tmp('tade-mem-')
    const memory = Memory.open(home)
    const kept = memory.remember('deploys freeze on Fridays', null, 'test', NOW)
    const taken = memory.remember('the staging key rotates on the 1st', 'checkout', 'test', NOW + 1)

    expect(memory.forget({ at: taken.at, text: taken.text }, 'window', NOW + 2)).toBe(true)
    expect(memory.all().map((n) => n.text)).toEqual([kept.text])
    // A note that is not there is not forgotten twice.
    expect(memory.forget({ at: taken.at, text: taken.text }, 'window', NOW + 3)).toBe(false)

    expect(
      Memory.open(home)
        .all()
        .map((n) => n.text),
    ).toEqual([kept.text])
    // Nothing rewritten: what was once said is still in the record.
    expect(readFileSync(join(home, 'memory.jsonl'), 'utf8')).toContain('rotates on the 1st')
  })

  it('has nothing to say before it is told anything', () => {
    const memory = Memory.open(tmp('tade-mem-'))
    expect(memory.all()).toEqual([])
    expect(memory.recall('checkout/refunds')).toEqual([])
  })

  it('keeps what it was told, and survives a restart', () => {
    const home = tmp('tade-mem-')
    const memory = Memory.open(home)
    memory.remember('the staging key rotates on the 1st', 'checkout', 'test', NOW)

    // A new window, the same file: this is the only copy there is.
    const reopened = Memory.open(home)
    expect(reopened.all().map((n) => n.text)).toEqual(['the staging key rotates on the 1st'])
    expect(reopened.recall('checkout/refunds').map((n) => n.text)).toEqual([
      'the staging key rotates on the 1st',
    ])
  })

  it('keeps a headline beside a note, and a note that never had one', () => {
    const home = tmp('tade-mem-')
    const memory = Memory.open(home)
    memory.remember(
      'refunds go through the ledger service',
      'checkout/refunds',
      'orchestrator',
      NOW,
      'Refunds via the ledger',
    )
    memory.remember('we pin major versions', 'checkout', 'window', NOW + 1000)

    const reopened = Memory.open(home).all()
    expect(reopened.map((n) => [n.text, n.summary])).toEqual([
      ['we pin major versions', undefined],
      ['refunds go through the ledger service', 'Refunds via the ledger'],
    ])
    // A headline is written beside the words, never over them.
    const line = JSON.parse(readFileSync(join(home, 'memory.jsonl'), 'utf8').split('\n')[0] ?? '{}')
    expect(line.text).toBe('refunds go through the ledger service')
    expect(line.summary).toBe('Refunds via the ledger')
  })

  it('loads a note written before headlines existed', () => {
    const home = tmp('tade-mem-')
    // Exactly the line an older Tade wrote: nothing in it about a headline.
    appendFileSync(
      join(home, 'memory.jsonl'),
      `${JSON.stringify({ text: 'never force-push to main', scope: null, by: 'voice', at: '2026-09-04T09:00:00.000Z' })}\n`,
    )
    const notes = Memory.open(home).all()
    expect(notes.map((n) => n.text)).toEqual(['never force-push to main'])
    expect(notes[0]?.summary).toBeUndefined()
  })

  it('is append-only, one note per line', () => {
    const home = tmp('tade-mem-')
    const memory = Memory.open(home)
    memory.remember('first', null, 'test', NOW)
    memory.remember('second', null, 'test', NOW + 1000)
    const lines = readFileSync(join(home, 'memory.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').text).toBe('first')
  })

  it('scopes what it gives back', () => {
    const home = tmp('tade-mem-')
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
    const home = tmp('tade-mem-')
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
    const home = tmp('tade-mem-')
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
    home = tmp('tade-mem-rpc-')
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
