import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Answer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Memory } from '../src/memory.ts'
import {
  answerNotes,
  GIVE_BYTES,
  type NotesAsk,
  NotesRefused,
  shareNotes,
} from '../src/notes-shared.ts'

// Notes shared between homes: `memory.jsonl` on each is the union of every
// one's lines, the same notes whatever order they arrived in, and each says
// where a note it took was taken. Two real homes on disk, the far half
// answered in-process with the request and its answer through JSON as the
// wire carries them; the route and the window are `@tade/web`'s and
// `@tade/app`'s tests.

const NOW = Date.parse('2026-10-17T09:00:00Z')

const file = (memory: Memory) => readFileSync(memory.path, 'utf8')
const linesOf = (memory: Memory) => file(memory).trim().split('\n')

/** What two homes hold, as notes: named, scoped, retired and where from. */
const held = (memory: Memory) =>
  memory
    .all({ retired: true })
    .map((one) => ({
      at: one.at,
      text: one.text,
      scope: one.scope,
      also: one.also ?? null,
      retired: one.retired?.at ?? null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.text.localeCompare(b.text))

/** The far side, as the wire carries it: every request and every answer through JSON. */
function farAt(far: Memory, name: string, asked: NotesAsk[] = []) {
  return async (ask: NotesAsk): Promise<Answer> => {
    const sent = JSON.parse(JSON.stringify(ask)) as NotesAsk
    asked.push(sent)
    const answer = answerNotes(far, sent, sent.from, name, NOW)
    return { status: 200, body: JSON.parse(JSON.stringify(answer)) }
  }
}

describe('the file, shared', () => {
  it('folds to the same notes whatever order its lines arrived in', () => {
    const one = Memory.open(tmp('tade-shared-'))
    const kept = one.remember('refunds go through the ledger', 'app/refunds', 'cli', NOW)
    const gone = one.remember('pause the queue', 'app', 'orchestrator', NOW + 1)
    one.remember('refunds go through the ledger', 'app/payouts', 'cli', NOW + 2)
    one.retire({ at: gone.at }, 'they said to let it run', 'orchestrator', NOW + 3)
    const forgot = one.remember('a slip of the tongue', null, 'voice', NOW + 4)
    one.forget(forgot, 'window', NOW + 5)

    // Every later word before the note it is about, as a union may write them.
    const other = Memory.open(tmp('tade-shared-'))
    writeFileSync(other.path, `${[...linesOf(one)].reverse().join('\n')}\n`)
    const reread = Memory.open(join(other.path, '..'))
    expect(held(reread)).toEqual(held(Memory.open(join(one.path, '..'))))
    expect(reread.all().map((n) => [n.text, n.scope, n.also])).toEqual([
      [kept.text, 'app/refunds', ['app/payouts']],
    ])
  })

  it('holds a note two homes both gave once, retired with the earlier of two retirements', () => {
    const home = tmp('tade-shared-')
    const note = {
      text: 'run nightly at two',
      scope: null,
      by: 'cli',
      at: '2026-10-01T00:00:00.000Z',
    }
    const named = { at: note.at, text: note.text }
    const retire = (at: string, by: string) => ({ retire: named, because: 'done', by, at })
    writeFileSync(
      join(home, 'memory.jsonl'),
      [
        note,
        retire('2026-10-05T00:00:00.000Z', 'vps'),
        note,
        retire('2026-10-04T00:00:00.000Z', 'mac'),
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    )
    const all = Memory.open(home).all({ retired: true })
    expect(all).toHaveLength(1)
    // Both homes come to the one that came first, whichever they read first.
    expect(all[0]?.retired).toEqual({ by: 'mac', at: '2026-10-04T00:00:00.000Z', because: 'done' })
  })

  it('gives every line but where a note came from, once each, and says where each note was taken', () => {
    const memory = Memory.open(tmp('tade-shared-'))
    const mine = memory.remember('mine', null, 'cli', NOW)
    const far = JSON.stringify({
      text: 'theirs',
      scope: null,
      by: 'cli',
      at: '2026-10-02T00:00:00.000Z',
    })
    memory.take([{ line: far }], 'vps', NOW)
    // A line written twice — two processes at once — is still one line given.
    appendFileSync(memory.path, `${linesOf(memory)[0]}\n`)
    const shared = memory.shared()
    expect(shared.map((one) => [JSON.parse(one.line).text, one.from ?? null])).toEqual([
      [mine.text, null],
      ['theirs', 'vps'],
    ])
    expect(file(memory)).toContain('"came"')
    expect(shared.some((one) => one.line.includes('"came"'))).toBe(false)
    expect(new Set(shared.map((one) => one.digest)).size).toBe(2)
  })

  it('takes only what is not there, refuses what is not a line of the file, and keeps a name it may draw', () => {
    const memory = Memory.open(tmp('tade-shared-'))
    const note = {
      text: 'theirs',
      scope: 'vps/x',
      by: 'orchestrator',
      at: '2026-10-02T00:00:00.000Z',
    }
    const retire = {
      retire: { at: note.at, text: note.text },
      because: 'done',
      by: 'cleanup',
      at: '2026-10-09T00:00:00.000Z',
    }
    const relayed = { text: 'from further', scope: null, by: 'cli', at: '2026-10-03T00:00:00.000Z' }
    const bad = {
      text: 'a name it may not draw',
      scope: null,
      by: 'cli',
      at: '2026-10-04T00:00:00.000Z',
    }
    const took = memory.take(
      [
        // Spaced as no Tade writes it: taken all the same, written on one line.
        { line: JSON.stringify(note, null, 2) },
        { line: JSON.stringify(note) },
        { line: JSON.stringify(retire) },
        { line: JSON.stringify(relayed), from: 'build-box' },
        { line: JSON.stringify(bad), from: '\u001b[31mred' },
        { line: '{"nothing":"like a note"}' },
        { line: 'not json' },
      ],
      'vps',
      NOW,
    )
    expect([took.lines, took.notes, took.refused]).toEqual([4, 3, 2])
    expect(linesOf(memory).every((line) => !line.includes('\n'))).toBe(true)
    const byText = new Map(memory.all({ retired: true }).map((one) => [one.text, one]))
    expect(byText.get('theirs')).toMatchObject({ from: 'vps', retired: { by: 'cleanup' } })
    expect(byText.get('from further')?.from).toBe('build-box')
    expect(byText.get('a name it may not draw')?.from).toBe('vps')
    // Taken again, nothing is written twice.
    const before = file(memory)
    expect(memory.take([{ line: JSON.stringify(note) }], 'vps', NOW).lines).toBe(0)
    expect(file(memory)).toBe(before)
    expect(() => memory.take([], 'not\na name', NOW)).toThrow(/not a name/)
  })
})

describe('an exchange between two homes', () => {
  it('leaves both holding every note, each saying where the other’s was taken, and the next is one look', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    mac.remember('deploys freeze on Fridays', null, 'voice', NOW)
    mac.remember('refunds go through the ledger', 'app/refunds', 'orchestrator', NOW + 1)
    vps.remember('the nightly runs at two', 'vps/nightly', 'orchestrator', NOW + 2)
    const asked: NotesAsk[] = []

    const done = await shareNotes(mac, farAt(vps, 'vps', asked), { from: 'mac', name: 'vps' })
    expect(done).toMatchObject({ same: false, took: 1, notes: 1, gave: 2, refused: 0, left: 0 })
    expect(held(mac)).toEqual(held(vps))
    expect(mac.all().find((n) => n.text.startsWith('the nightly'))?.from).toBe('vps')
    expect(vps.all().find((n) => n.text.startsWith('deploys'))?.from).toBe('mac')
    // Each side's own say nothing of where: they were taken there.
    expect(mac.all().find((n) => n.text.startsWith('deploys'))?.from).toBeUndefined()
    // Asked by digest: no request carried a note's words it was not giving.
    expect(JSON.stringify(asked[0])).not.toContain('Fridays')

    asked.length = 0
    const again = await shareNotes(mac, farAt(vps, 'vps', asked), { from: 'mac', name: 'vps' })
    expect(again).toMatchObject({ same: true, took: 0, gave: 0 })
    expect(asked).toHaveLength(1)
  })

  it('carries a retirement and a note taken back, either way', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    const kept = vps.remember('hover the purple too', 'app/purple', 'orchestrator', NOW)
    const slip = mac.remember('a slip of the tongue', null, 'voice', NOW + 1)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    vps.retire({ at: kept.at }, 'app/purple finished 4 days ago', 'cleanup', NOW + 2)
    mac.forget(slip, 'window', NOW + 3)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    for (const memory of [mac, vps]) {
      expect(memory.all().map((n) => n.text)).toEqual([])
      expect(memory.all({ retired: true }).map((n) => n.retired?.because)).toEqual([
        'app/purple finished 4 days ago',
      ])
    }
  })

  it('holds another machine’s retirement or taking back of a note taken here for a press, and the next is one look', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    const kept = mac.remember('deploys freeze on Fridays', null, 'voice', NOW)
    const also = mac.remember('refunds go through the ledger', null, 'orchestrator', NOW + 1)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    // What any agent on the box could write: its own Tade's word, never the Mac's.
    vps.retire({ at: kept.at }, 'not needed any more', 'orchestrator', NOW + 2)
    vps.forget(also, 'window', NOW + 3)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    const reread = Memory.open(join(mac.path, '..'))
    expect(reread.all().map((n) => n.text)).toEqual([also.text, kept.text])
    // Waiting for the person's press here, each saying what it would do and whose word it is.
    expect(reread.held().map((one) => [one.kind, one.note.text, one.from, one.by])).toEqual([
      ['retire', kept.text, 'vps', 'orchestrator'],
      ['forget', also.text, 'vps', 'window'],
    ])
    expect(reread.held()[0]?.because).toBe('not needed any more')
    // Held there, as that machine's own word, and the two files are one union.
    expect(vps.all({ retired: true }).map((n) => [n.text, n.retired?.because])).toEqual([
      [kept.text, 'not needed any more'],
    ])
    expect(file(mac)).toContain('"heard"')
    expect(mac.shared().some((one) => one.line.includes('"heard"'))).toBe(false)
    const asked: NotesAsk[] = []
    const again = await shareNotes(mac, farAt(vps, 'vps', asked), { from: 'mac', name: 'vps' })
    expect(again).toMatchObject({ same: true })
    expect(asked).toHaveLength(1)

    // This machine's own word still does it, and a retirement of a retired note is no longer offered.
    mac.retire({ at: kept.at }, 'the freeze was lifted', 'cli', NOW + 4)
    expect(mac.all().map((n) => n.text)).toEqual([also.text])
    expect(mac.held().map((one) => one.kind)).toEqual(['forget'])
  })

  it('takes a held retirement or taking back on the press, and leaves one on Leave', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    const kept = mac.remember('deploys freeze on Fridays', null, 'voice', NOW)
    const slip = mac.remember('a slip of the tongue', null, 'voice', NOW + 1)
    const stays = mac.remember('refunds go through the ledger', null, 'voice', NOW + 2)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })
    // The person, on their phone paired to the box.
    vps.retire({ at: kept.at }, 'the freeze was lifted', 'device phone', NOW + 3)
    vps.forget(slip, 'device phone', NOW + 4)
    vps.retire({ at: stays.at }, 'not needed', 'orchestrator', NOW + 5)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })
    const [retire, forget, leave] = mac.held()

    expect(mac.settle(retire?.digest ?? '', 'take', 'device mac-phone', NOW + 6).kind).toBe(
      'retire',
    )
    expect(mac.settle(forget?.digest ?? '', 'take', 'window', NOW + 7).kind).toBe('forget')
    expect(mac.settle(leave?.digest ?? '', 'leave', 'window', NOW + 8).kind).toBe('retire')

    const reread = Memory.open(join(mac.path, '..'))
    expect(reread.held()).toEqual([])
    expect(reread.all().map((n) => n.text)).toEqual([stays.text])
    expect(reread.all({ retired: true }).find((n) => n.text === kept.text)?.retired).toEqual({
      by: 'device phone',
      at: new Date(NOW + 3).toISOString(),
      because: 'the freeze was lifted',
    })
    // Taken or left once: a second press is refused, never written twice.
    expect(() => reread.settle(leave?.digest ?? '', 'take', 'window', NOW + 9)).toThrow(
      /not waiting/,
    )
    // The press is this home's own, never given, and the next exchange is one look.
    expect(mac.shared().some((one) => /"took"|"left"/.test(one.line))).toBe(false)
    const asked: NotesAsk[] = []
    expect(
      await shareNotes(mac, farAt(vps, 'vps', asked), { from: 'mac', name: 'vps' }),
    ).toMatchObject({
      same: true,
    })
  })

  it('holds a note taken here told about more by another machine, until the press takes it', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    const one = mac.remember('refunds go through the ledger', 'app/refunds', 'voice', NOW)
    const two = mac.remember('deploys freeze on Fridays', 'app', 'voice', NOW + 1)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })
    // Widened there: the same words said about more, which writes an `also` line.
    vps.remember(one.text, null, 'orchestrator', NOW + 2)
    vps.remember(two.text, 'api', 'device phone', NOW + 3)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    expect(mac.all().map((n) => [n.text, n.scope, n.also ?? null])).toEqual([
      [two.text, 'app', null],
      [one.text, 'app/refunds', null],
    ])
    expect(vps.all().find((n) => n.text === one.text)?.scope).toBeNull()
    const held = mac.held()
    expect(held.map((h) => [h.kind, h.note.text, h.scopes])).toEqual([
      ['also', one.text, null],
      ['also', two.text, ['api']],
    ])
    mac.settle(held[1]?.digest ?? '', 'take', 'window', NOW + 4)
    mac.settle(held[0]?.digest ?? '', 'leave', 'window', NOW + 5)
    const reread = Memory.open(join(mac.path, '..'))
    expect(reread.all().map((n) => [n.text, n.scope, n.also ?? null])).toEqual([
      [two.text, 'app', ['api']],
      [one.text, 'app/refunds', null],
    ])
    expect(reread.held()).toEqual([])
  })

  it('lets a note taken on the other machine take its changes freely, and holds nothing', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    const gone = vps.remember('the nightly runs at two', 'vps/nightly', 'orchestrator', NOW)
    const wide = vps.remember('pause the queue on deploys', 'vps', 'orchestrator', NOW + 1)
    const slip = vps.remember('a slip of the tongue', null, 'voice', NOW + 2)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })
    vps.retire({ at: gone.at }, 'the nightly moved', 'device phone', NOW + 3)
    vps.remember(wide.text, null, 'device phone', NOW + 4)
    vps.forget(slip, 'device phone', NOW + 5)
    await shareNotes(mac, farAt(vps, 'vps'), { from: 'mac', name: 'vps' })

    expect(mac.held()).toEqual([])
    expect(mac.all().map((n) => [n.text, n.scope])).toEqual([[wide.text, null]])
    expect(mac.all({ retired: true }).find((n) => n.text === gone.text)?.retired?.because).toBe(
      'the nightly moved',
    )
  })

  it('reaches a third machine through the one between, saying where it was taken', async () => {
    const one = Memory.open(tmp('tade-one-'))
    const mac = Memory.open(tmp('tade-mac-'))
    const two = Memory.open(tmp('tade-two-'))
    one.remember('said on the first box', null, 'voice', NOW)
    await shareNotes(mac, farAt(one, 'one'), { from: 'mac', name: 'box-one' })
    await shareNotes(mac, farAt(two, 'two'), { from: 'mac', name: 'box-two' })
    expect(two.all().map((n) => [n.text, n.from])).toEqual([['said on the first box', 'box-one']])
  })

  it('gives in rounds no bigger than the far side reads, until every line is across', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    const vps = Memory.open(tmp('tade-vps-'))
    // Twice what one request may carry, each way.
    const words = 'x'.repeat(600)
    for (let n = 0; n < 200; n++) mac.remember(`${n} ${words}`, null, 'cli', NOW + n)
    for (let n = 0; n < 200; n++) vps.remember(`far ${n} ${words}`, null, 'cli', NOW + n)
    const asked: NotesAsk[] = []
    const done = await shareNotes(mac, farAt(vps, 'vps', asked), { from: 'mac', name: 'vps' })
    expect(done).toMatchObject({ took: 200, gave: 200, left: 0 })
    expect(asked.length).toBeGreaterThan(3)
    for (const ask of asked) expect(JSON.stringify(ask).length).toBeLessThan(GIVE_BYTES + 8 * 1024)
    expect(held(mac)).toEqual(held(vps))
  })

  it('says why where the far side answered and would not', async () => {
    const mac = Memory.open(tmp('tade-mac-'))
    mac.remember('anything', null, 'cli', NOW)
    const older = async (): Promise<Answer> => ({ status: 404, body: { error: 'no_such' } })
    await expect(shareNotes(mac, older, { from: 'mac', name: 'vps' })).rejects.toThrow(
      /vps's Tade does not share notes: it is older than this one/,
    )
    const junk = async (): Promise<Answer> => ({ status: 200, body: { lines: 'all of them' } })
    const refused = shareNotes(mac, junk, { from: 'mac', name: 'vps' })
    await expect(refused).rejects.toBeInstanceOf(NotesRefused)
    await expect(refused).rejects.toThrow(/not its notes/)
    // Nothing was taken from either.
    expect(linesOf(mac)).toHaveLength(1)
  })
})
