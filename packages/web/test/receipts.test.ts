import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Outcome } from '../src/acting.ts'
import { boundDigest, KEPT, Receipts, receiptsIn, receiptsPath } from '../src/receipts.ts'
import { homeFor } from './harness.ts'

// What a device asked for and what came of it, as a file.
//
// **The whole point of these is the case nobody can test by hand**: a window
// that died between starting an act and recording what came of it. The answer
// there is `unsure` — Tade does not know and will not do it again — and it is
// the one answer that cannot be arrived at by being careful, because the
// evidence is on disk and the process that wrote it is gone.

const BOUND = '00112233445566aa\npark\ntade/away-action-gate\nparked=true'
const OTHER = '00112233445566aa\npark\ntade/away-action-gate\nparked=false'
const DONE: Outcome = { did: true, rev: 'p1', said: 'set aside' }

function asking(over: Partial<Parameters<Receipts['claim']>[0]> = {}) {
  return {
    key: 'abcdefgh12345678',
    bound: BOUND,
    device: '00112233445566aa',
    verb: 'park',
    task: 'tade/away-action-gate',
    now: Date.parse('2026-10-09T09:00:00.000Z'),
    ...over,
  }
}

async function store(home: string, epoch = 'one'): Promise<Receipts> {
  const made = new Receipts({ home, epoch })
  await made.open()
  return made
}

describe('claiming a key', () => {
  it('is fresh the first time, and the same answer every time after', async () => {
    const home = await homeFor('receipts-again')
    const kept = await store(home)
    expect((await kept.claim(asking())).kind).toBe('fresh')
    await kept.while('abcdefgh12345678', () => Promise.resolve(DONE))
    await kept.came('abcdefgh12345678', BOUND, DONE, 1)
    const again = await kept.claim(asking())
    expect(again).toEqual({ kind: 'again', outcome: DONE })
  })

  it('runs the verb once for concurrent repeats, and answers both the same', async () => {
    // **The load case.** Two presses of one button, or a phone that retried
    // while the first request was still in flight: the second awaits the
    // first's promise rather than starting a second act.
    const home = await homeFor('receipts-load')
    const kept = await store(home)
    let ran = 0
    expect((await kept.claim(asking())).kind).toBe('fresh')
    const work = kept.while(
      'abcdefgh12345678',
      () =>
        new Promise<Outcome>((done) => {
          ran += 1
          setTimeout(() => done(DONE), 5)
        }),
    )
    const second = await kept.claim(asking())
    expect(second.kind).toBe('running')
    if (second.kind !== 'running') return
    expect(await second.outcome).toEqual(DONE)
    expect(await work).toEqual(DONE)
    expect(ran).toBe(1)
  })

  it('refuses the same key bound to a different payload, and runs nothing', async () => {
    // **The altered-replay case.** Somebody captured a request and changed
    // `parked`, keeping the key. A key is not a licence: the record says what
    // it was for, and this is not it.
    const home = await homeFor('receipts-altered')
    const kept = await store(home)
    await kept.claim(asking())
    expect((await kept.claim(asking({ bound: OTHER }))).kind).toBe('reused')
  })

  it('refuses an altered payload even while the first is still going', async () => {
    // The ordering that matters: `bound` is compared **before** the in-flight
    // promise is handed over, so a different act cannot be answered with the
    // first one's outcome and look like idempotency.
    const home = await homeFor('receipts-altered-running')
    const kept = await store(home)
    await kept.claim(asking())
    kept.while(
      'abcdefgh12345678',
      () => new Promise<Outcome>((done) => setTimeout(() => done(DONE), 20)),
    )
    expect((await kept.claim(asking({ bound: OTHER }))).kind).toBe('reused')
  })

  it('tells one key from another', async () => {
    const home = await homeFor('receipts-two')
    const kept = await store(home)
    expect((await kept.claim(asking())).kind).toBe('fresh')
    expect((await kept.claim(asking({ key: 'second0012345678' }))).kind).toBe('fresh')
  })
})

describe('across a restart', () => {
  it('answers a finished key from the record, and runs nothing', async () => {
    const home = await homeFor('receipts-restart-done')
    const first = await store(home, 'one')
    await first.claim(asking())
    await first.while('abcdefgh12345678', () => Promise.resolve(DONE))
    await first.came('abcdefgh12345678', BOUND, DONE, 2)

    // A different lifetime, reading the same file. The record is what makes a
    // repeat an answer rather than a second act.
    const next = await store(home, 'two')
    expect(await next.claim(asking())).toEqual({ kind: 'again', outcome: DONE })
  })

  it('is unsure about a key whose act was never recorded as finished', async () => {
    // **Fail closed, and this is the case the whole file exists for.** The
    // window died between the `asked` line and the `came` line, so Tade cannot
    // tell whether the task was parked. It will not do it again and it says
    // so — the alternative is the duplicate mutation DESIGN §9.3's LRU would
    // have allowed.
    const home = await homeFor('receipts-restart-unsure')
    const first = await store(home, 'one')
    await first.claim(asking())

    const next = await store(home, 'two')
    expect((await next.claim(asking())).kind).toBe('unsure')
    // And again, because an `unsure` is not consumed by being read: nothing
    // about asking twice makes the answer knowable.
    expect((await next.claim(asking())).kind).toBe('unsure')
  })

  it('is unsure inside one lifetime too, once an act has failed', async () => {
    // The act threw, so nothing recorded what came of it and nothing is in
    // flight any more. Tade cannot say whether the file moved, so a repeat is
    // the same answer it would get after a restart.
    const home = await homeFor('receipts-unsure-here')
    const kept = await store(home)
    await kept.claim(asking())
    await kept
      .while('abcdefgh12345678', () => Promise.reject(new Error('the window went')))
      .catch(() => {})
    expect((await kept.claim(asking())).kind).toBe('unsure')
  })

  it('answers a repeat that arrived while the first was still writing its line', async () => {
    // **The tick the whole claim is ordered for.** Two requests in one tick:
    // the decision and the marks that record it are synchronous, so the second
    // finds the first rather than an empty map it can be told it is first in.
    const home = await homeFor('receipts-same-tick')
    const kept = await store(home)
    const both = await Promise.all([kept.claim(asking()), kept.claim(asking())])
    expect(both.map((one) => one.kind).sort()).toEqual(['fresh', 'running'])
  })

  it('treats a key with no record at all as fresh, which is the honest limit', async () => {
    // **Nothing here promises exactly-once.** A key whose record is gone —
    // past `KEPT`, or a file somebody deleted — is a new act, and what stops
    // it being a duplicate is the state re-check (DECISIONS §4.6). Said as a
    // test so that nobody reads the store as stronger than it is.
    const home = await homeFor('receipts-gone')
    const first = await store(home)
    await first.claim(asking())
    await first.while('abcdefgh12345678', () => Promise.resolve(DONE))
    await first.came('abcdefgh12345678', BOUND, DONE, 3)
    await writeFile(receiptsPath(home), '')
    const next = await store(home, 'two')
    expect((await next.claim(asking())).kind).toBe('fresh')
  })
})

describe('the file', () => {
  it('is append-only, two lines per act, and `0600`', async () => {
    const home = await homeFor('receipts-file')
    const kept = await store(home)
    await kept.claim(asking())
    await kept.while('abcdefgh12345678', () => Promise.resolve(DONE))
    await kept.came('abcdefgh12345678', BOUND, DONE, 4)
    const text = await readFile(receiptsPath(home), 'utf8')
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => line.kind)).toEqual(['asked', 'came'])
    const mode = (await stat(receiptsPath(home))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('keeps the digest of what a key was bound to, and never the string', async () => {
    // The string holds a device id, a verb and a task id. The digest is what
    // a comparison needs, and the file is the audit — so what it carries is
    // the id, the verb and the task as their own fields, and the binding as a
    // digest rather than a second copy of them.
    const home = await homeFor('receipts-digest')
    const kept = await store(home)
    await kept.claim(asking())
    const text = await readFile(receiptsPath(home), 'utf8')
    expect(text).toContain(boundDigest(BOUND))
    expect(text).not.toContain('parked=true')
  })

  it('skips a line it cannot read rather than throwing the lot over', async () => {
    const home = await homeFor('receipts-damaged')
    await writeFile(receiptsPath(home), `{"kind":"asked"\nnot json\n`)
    const read = receiptsIn(await readFile(receiptsPath(home), 'utf8'))
    expect(read.receipts).toEqual([])
    expect(read.skipped).toBe(2)
  })

  it('says once that lines were skipped, where a person can read it', async () => {
    const home = await homeFor('receipts-said')
    await writeFile(receiptsPath(home), 'not json\n')
    const told: string[] = []
    const kept = new Receipts({ home, epoch: 'one', tell: (said) => told.push(said) })
    await kept.open()
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('could not be read')
  })

  it('ignores a `came` for a key no `asked` introduced, and one bound elsewhere', async () => {
    const read = receiptsIn(
      [
        JSON.stringify({
          kind: 'came',
          key: 'nobody0012345678',
          bound: boundDigest(BOUND),
          did: true,
          rev: 'p1',
          said: 'x',
          at: 'now',
        }),
        JSON.stringify({
          kind: 'asked',
          key: 'abcdefgh12345678',
          bound: boundDigest(BOUND),
          epoch: 'one',
          device: '00112233445566aa',
          verb: 'park',
          task: 'tade/x',
          at: 'now',
        }),
        JSON.stringify({
          kind: 'came',
          key: 'abcdefgh12345678',
          bound: boundDigest(OTHER),
          did: true,
          rev: 'p0',
          said: 'x',
          at: 'now',
        }),
      ].join('\n'),
    )
    expect(read.skipped).toBe(0)
    expect(read.receipts).toHaveLength(1)
    // The `came` was about something else, so the record is still unfinished.
    expect(read.receipts[0]?.outcome).toBeNull()
  })
})

describe('what is kept in memory', () => {
  it('is bounded, so a stream of made-up keys is not a leak', async () => {
    const home = await homeFor('receipts-bounded')
    const kept = await store(home)
    for (let at = 0; at < KEPT + 20; at++) {
      const key = `k${String(at).padStart(15, '0')}`
      await kept.claim(asking({ key }))
      await kept.while(key, () => Promise.resolve(DONE))
      await kept.came(key, BOUND, DONE, at)
    }
    expect(kept.size).toBe(KEPT)
    // The oldest fell out, which is the fast path going and not the guarantee:
    // a repeat of it meets the state re-check instead.
    expect((await kept.claim(asking({ key: 'k000000000000000' }))).kind).toBe('fresh')
    expect(
      (await kept.claim(asking({ key: `k${String(KEPT + 19).padStart(15, '0')}` }))).kind,
    ).toBe('again')
  })
})

describe('an act that fails', () => {
  it('answers a concurrent repeat rather than holding it open for ever', async () => {
    // **The reason `while` takes a thunk and not a promise.** Handed a promise,
    // it is never reached when the verb throws *synchronously* — and then the
    // thing a concurrent repeat is awaiting is settled by nothing, which is a
    // request held open until the phone gives up.
    const home = await homeFor('receipts-sync-throw')
    const kept = await store(home)
    await kept.claim(asking())
    const second = await kept.claim(asking())
    expect(second.kind).toBe('running')
    const going = kept.while('abcdefgh12345678', () => {
      throw new Error('the window went')
    })
    await expect(going).rejects.toThrow('the window went')
    if (second.kind === 'running') await expect(second.outcome).rejects.toThrow('the window went')
  })

  it('is unsure afterwards, because nothing recorded what came of it', async () => {
    const home = await homeFor('receipts-failed-then')
    const kept = await store(home)
    await kept.claim(asking())
    await kept.while('abcdefgh12345678', () => Promise.reject(new Error('no'))).catch(() => {})
    expect((await kept.claim(asking())).kind).toBe('unsure')
  })
})

describe('what the kept window may never drop', () => {
  it('never forgets a key that is still going, however many arrive after it', async () => {
    // **The one eviction that would be a double act.** Dropping an in-flight
    // key would make a concurrent repeat of it look fresh, so the window is
    // `KEPT` plus whatever is in flight — which the socket caps already bound.
    const home = await homeFor('receipts-inflight-kept')
    const kept = await store(home)
    await kept.claim(asking({ key: 'inflight00000000' }))
    for (let at = 0; at < KEPT + 5; at++) {
      const key = `k${String(at).padStart(15, '0')}`
      await kept.claim(asking({ key }))
      await kept.while(key, () => Promise.resolve(DONE))
      await kept.came(key, BOUND, DONE, at)
    }
    expect((await kept.claim(asking({ key: 'inflight00000000' }))).kind).toBe('running')
  })
})

describe('when the line cannot be written', () => {
  it('drops the in-flight mark, so a repeat is answered rather than held open', async () => {
    // **The hang this closes.** The mark that makes a concurrent repeat wait
    // is set before the append; if the append fails and the mark stays, the
    // next request with that key awaits a promise nothing will ever settle.
    // The record stays, so the repeat is `unsure` — Tade cannot say whether
    // the act ran, and here it never started.
    //
    // A home *under a regular file* is the shape a read-only or broken home
    // has from here: `mkdir` answers `ENOTDIR`, which is a real failure of the
    // real call rather than a stub of one.
    const base = await homeFor('receipts-nowrite')
    const file = join(base, 'not-a-folder')
    await writeFile(file, '')
    const kept = new Receipts({ home: join(file, 'under'), epoch: 'one' })
    await kept.open()
    await expect(kept.claim(asking())).rejects.toThrow()
    expect((await kept.claim(asking())).kind).toBe('unsure')
  })
})

describe('the lifetime on a line', () => {
  it('is audit and never a decision, so a new one cannot make a key run again', () => {
    // The file says which window asked, which is how a person tells *it
    // failed* from *the window died under it*. What refuses a repeat is the
    // record existing at all — so a record written under any epoch, read back
    // under any other, is the same answer. Asserted over the fold rather than
    // through a store, because the claim never looks at an epoch to compare.
    const line = (epoch: string) =>
      JSON.stringify({
        kind: 'asked',
        key: 'abcdefgh12345678',
        bound: boundDigest(BOUND),
        epoch,
        device: '00112233445566aa',
        verb: 'park',
        task: 'tade/x',
        at: 'now',
      })
    for (const epoch of ['one', 'two', '']) {
      const read = receiptsIn(line(epoch))
      expect(read.receipts, epoch).toHaveLength(1)
      // Nothing of the lifetime reaches the record a claim is decided from.
      expect(Object.keys(read.receipts[0] ?? {}).sort()).toEqual(['bound', 'key', 'outcome'])
    }
  })
})
