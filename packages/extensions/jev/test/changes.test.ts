import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CHARS_PER_TOKEN, cutTo, inBatches, partSaid, whoseWork } from '../src/changes.ts'
import { roomFor } from '../src/review.ts'
import { readReviews } from '../src/reviews.ts'
import { host, NOW, typesafe } from './harness.ts'

// How much of a change is read, and what is said about the rest.
//
// A change too big to read whole is not a review that cannot happen: it is a
// review of part of it, said as one. What that was before is the thing these
// hold the line on — a whole reading lost to a 400, reaching somebody as one
// red line with a provider's JSON in it, which told them nothing and taught
// nobody anything.

const asked = { caller: { kind: 'orchestrator' } as const }

/** A TypeSafe that refuses whatever mentions something, the way it refuses a state too long. */
function refusing(about: RegExp, otherwise: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    about.test(String(init?.body ?? ''))
      ? new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })
      : otherwise(input as string, init)) as typeof fetch
}

describe('how much of a change is read', () => {
  const patch = (file: string, size: number) => ({ file, patch: 'x'.repeat(size) })

  it('reads a change whole when it fits, and says nothing about it', () => {
    const change = cutTo([patch('a.ts', 100), patch('b.ts', 200)])
    expect(change.files.map((one) => one.file)).toEqual(['a.ts', 'b.ts'])
    expect(change).toMatchObject({ unread: [], cut: 0 })
    // Nothing to say is said as nothing: a note under every review would be
    // read four hundred times and mean nothing on the four hundred and first.
    expect(partSaid(change)).toBeNull()
  })

  it('stops at the budget, names what it did not read, and never throws over it', () => {
    const change = cutTo(Array.from({ length: 40 }, (_, at) => patch(`src/page-${at}.ts`, 20_000)))
    // Fifteen files of twenty thousand is the budget exactly, so the
    // sixteenth is the first one there is no room for.
    expect(change.files.length).toBe(15)
    expect(change.unread.length).toBe(25)
    expect(partSaid(change)).toMatch(
      /^Read in part: 25 of 40 files were not read \(src\/page-15\.ts, src\/page-16\.ts, src\/page-17\.ts, and others\)\./,
    )
  })

  it('counts a file cut down to its first half as read in part too', () => {
    const change = cutTo([patch('src/generated.ts', 50_000)])
    expect(change.files[0]?.patch.length).toBe(20_000)
    expect(change).toMatchObject({ unread: [], cut: 30_000 })
    expect(partSaid(change)).toMatch(/30000 characters of patch were left behind/)
  })

  it('names the files it was never offered as unread, not as read', () => {
    // What is past the file limit is known to have changed and known not to
    // have been read, which is exactly what a reader needs to hear about it.
    const change = cutTo([patch('a.ts', 10)], ['b.ts', 'c.ts'])
    expect(change.unread).toEqual(['b.ts', 'c.ts'])
    expect(partSaid(change)).toMatch(/2 of 3 files were not read \(b\.ts, c\.ts\)/)
  })
})

describe('reading a change that will not fit', () => {
  it('reads a change far over budget in part, says so, and never asks for more than one ask takes', async () => {
    // Forty files of three hundred lines: about half a million characters of
    // patch, which is what "sixty files at twenty thousand characters each"
    // looks like on disk. All of it was read, in as many asks as it took, each
    // one sized off an estimate that is wrong about a diff.
    const repo = mkrepo()
    const worktree = repo.addTask('big-rewrite', {
      project: 'shop',
      intent: 'move the payouts page onto the new client',
    })
    const files: Record<string, string> = {}
    for (let file = 0; file < 40; file++) {
      files[`src/page-${file}.ts`] = Array.from(
        { length: 300 },
        (_, line) => `export const value${line} = compute(${line}, 'a rather long argument here')`,
      ).join('\n')
    }
    repo.commit('the whole page', files, worktree)

    const home = tmp('tade-jev-')
    const seen: unknown[] = []
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }, seen),
    })
    // It comes back. Losing the whole reading to a refusal is what this is
    // about: a judge that cannot look at everything can still look at
    // something, and silence is the one answer that teaches nobody.
    const answer = await loaded.call(
      'jev_review',
      { project: 'shop', task: 'shop/big-rewrite' },
      asked,
    )
    expect(answer.text).toMatch(/\| test_missing \| 0\.90 \|/)
    // And it says plainly that it read part of it, rather than letting a table
    // of probabilities about half a change read as a table about the change.
    expect(answer.text).toMatch(/Read in part: \d+ of 40 files were not read/)
    expect(answer.said).toMatch(/^Read part of shop\/big-rewrite/)

    const [review] = readReviews(home)
    expect(review?.part).toMatch(/of 40 files were not read/)
    expect(review?.files).toBeLessThan(40)
    expect(review?.files).toBeGreaterThan(0)

    // And no ask carries more than one ask takes — the judge's own state
    // budget, counted at the rate a diff tokenises at rather than at the four
    // characters a token that prose does. Measured at about 44,000 of the
    // 80,000 there is: the room left over is for the estimate being an
    // estimate, which is the whole of what went wrong.
    expect(seen.length).toBeGreaterThan(1)
    const biggest = Math.max(...seen.map((body) => JSON.stringify(body).length))
    expect(biggest).toBeLessThan(32_000 * CHARS_PER_TOKEN)
  })

  it('reads the changes it can when one of them is refused, and tries that one again', async () => {
    const repo = mkrepo()
    const good = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = 1\n' }, good)
    const bad = repo.addTask('regenerate', { project: 'shop', intent: 'regenerate the client' })
    repo.commit('regenerate', { 'src/generated.ts': 'export const client = 1\n' }, bad)

    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      // One change nothing will answer about, which is what a refusal looks
      // like from up here whatever the reason for it was.
      fetch: refusing(/src\/generated\.ts/, typesafe({ authz_removed: 0.88 })),
      now: Date.now,
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    // The one it could read is read. A whole look lost to the first branch in
    // the list is what this is about.
    expect(look.found.map((finding) => finding.key)).toEqual(['shop/add-refunds:authz_removed'])
    // And the one it could not keeps its old cursor, so the next look finds it
    // again rather than marking it read.
    const since = JSON.parse(look.since ?? '{}') as Record<string, string>
    expect(Object.keys(since)).toEqual(['shop/add-refunds'])
  })

  it('says it could not look only when it could read nothing at all', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('regenerate', { project: 'shop', intent: 'regenerate' })
    repo.commit('regenerate', { 'src/generated.ts': 'export const client = 1\n' }, worktree)
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: refusing(/./, typesafe({})),
      now: Date.now,
    })
    // In words somebody can act on, and once — the window says a watch's
    // problem when it starts going wrong, not at every look while it stays
    // wrong, and it can only do that with a sentence that stays the same.
    await expect(
      loaded.look('jev.review', {
        project: 'shop',
        input: { settle: '0m' },
        since: null,
        turnedOn: new Date(NOW - 60_000).toISOString(),
      }),
    ).rejects.toThrow(
      /the one change it found could not be read: shop\/regenerate .*longer than one ask takes/,
    )
  })
})

describe('an ask refused for its size', () => {
  /**
   * A TypeSafe that refuses whatever is longer than it takes, which is the real
   * rule, and keeps the length of every ask it was sent — refused ones included,
   * because what is being held here is how many doomed asks get made.
   */
  function refusingOver(bytes: number, otherwise: typeof fetch, tried: number[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const length = String(init?.body ?? '').length
      tried.push(length)
      return length > bytes
        ? new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })
        : otherwise(input as string, init)
    }) as typeof fetch
  }

  it('is asked again for less, rather than losing the whole reading', async () => {
    // `roomFor` sizes an ask in characters standing in for tokens, so it is
    // wrong sometimes by construction — and a one-file change is one batch,
    // which had nowhere to go but a lost reading. `max_tokens_exceeded` was
    // the whole of what this watch said for two days because of it.
    const repo = mkrepo()
    const worktree = repo.addTask('regenerate', { project: 'shop', intent: 'regenerate' })
    repo.commit(
      'regenerate',
      { 'src/generated.ts': `const c = 1\n${'y'.repeat(40_000)}` },
      worktree,
    )
    const seen: unknown[] = []
    const tried: number[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: refusingOver(20_000, typesafe({ authz_removed: 0.91 }, seen), tried),
      now: Date.now,
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    // It read it, and every ask it settled on was one the other end would take.
    expect(look.found.map((finding) => finding.key)).toEqual(['shop/regenerate:authz_removed'])
    expect(Math.max(...seen.map((body) => JSON.stringify(body).length))).toBeLessThanOrEqual(20_000)
    // Halving, so what it spends getting there is a handful of asks and not a
    // walk down from the budget one file at a time.
    const doomed = tried.filter((length) => length > 20_000).length
    expect(doomed).toBeGreaterThan(0)
    expect(doomed).toBeLessThan(4)
    // And it says it read part of it, because it did: what a question did not
    // see, it cannot have answered about.
    expect(look.found[0]?.detail).toMatch(/Read in part: .*characters of patch were left behind/)
  })

  it('is named as unread, not asked five times, when the refusal was not about size', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('regenerate', { project: 'shop', intent: 'regenerate' })
    repo.commit('regenerate', { 'src/generated.ts': 'export const client = 1\n' }, worktree)
    const tried: number[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      // A change small enough that halving it could not make it fit, which is
      // the case where asking again only spends somebody's money to be told no.
      fetch: refusingOver(10, typesafe({}), tried),
      now: Date.now,
    })
    await expect(
      loaded.look('jev.review', {
        project: 'shop',
        input: { settle: '0m' },
        since: null,
        turnedOn: new Date(NOW - 60_000).toISOString(),
      }),
    ).rejects.toThrow(/could not be read/)
    expect(tried).toHaveLength(1)
  })
})

describe('an ask is built to fit, rather than sent to be refused', () => {
  const asking = { judge: { capabilities: { stateTokens: 32_000 } } } as Parameters<
    typeof roomFor
  >[0]
  const unit = { intent: 'add refunds', branch: 'tade/add-refunds', tasks: ['shop/add-refunds'] }
  const file = (name: string, size: number) => ({ file: name, patch: 'x'.repeat(size), cut: 0 })

  it('never puts more in a batch than the budget, one oversized file included', () => {
    // The check used to be `batch.length > 0`, so the first file of a batch was
    // never measured at all: a file bigger than the budget went in whole and the
    // ask came back `max_tokens_exceeded`, taking the whole reading with it.
    const { batches, cut } = inBatches(
      [file('src/huge.ts', 9_000), file('src/small.ts', 100)],
      1000,
    )
    for (const batch of batches) {
      const size = batch.reduce((sum, one) => sum + one.patch.length + one.file.length, 0)
      expect(size).toBeLessThanOrEqual(1000)
    }
    // And what it had to leave behind is counted, because a reading of part of a
    // file is different evidence from a reading of the whole of it.
    expect(cut).toBeGreaterThan(8_000)
    expect(batches.flat().map((one) => one.file)).toEqual(['src/huge.ts', 'src/small.ts'])
  })

  it('leaves a change that fits exactly as it was, with nothing cut', () => {
    const { batches, cut } = inBatches([file('a.ts', 100), file('b.ts', 200)], 10_000)
    expect(cut).toBe(0)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.[0]?.patch.length).toBe(100)
  })

  it('takes the state around the patches off the budget, measured rather than guessed', () => {
    // The 0.6 this replaces was a ratio standing in for the intent, the branch,
    // the task names and every file name — the part that varies most. An agent
    // whose intent is three paragraphs puts thousands of characters into every
    // ask before a line of diff.
    const small = roomFor(asking, unit, { files: [file('a.ts', 10)], unread: [], cut: 0 }, [])
    const wordy = roomFor(
      asking,
      { ...unit, intent: 'x'.repeat(20_000) },
      { files: [file('a.ts', 10)], unread: [], cut: 0 },
      [],
    )
    expect(small - wordy).toBeGreaterThan(19_000)
    // And the file names are all of them, whichever batch a file lands in.
    const many = roomFor(
      asking,
      unit,
      {
        files: Array.from({ length: 40 }, (_, at) => file(`packages/app/src/page-${at}.ts`, 10)),
        unread: [],
        cut: 0,
      },
      [],
    )
    expect(small - many).toBeGreaterThan(1_000)
  })

  it('leaves room for the estimate being an estimate, and never goes over the budget', () => {
    const room = roomFor(asking, unit, { files: [file('a.ts', 10)], unread: [], cut: 0 }, [])
    expect(room).toBeLessThan(32_000 * CHARS_PER_TOKEN)
    expect(room).toBeGreaterThan(50_000)
  })

  it('reads the rest of a change when one batch of it is refused', async () => {
    // One refused ask is not a change nobody could read. The whole reading used
    // to go with it, reaching somebody as a provider's JSON.
    const repo = mkrepo()
    const worktree = repo.addTask('many-files', { project: 'shop', intent: 'change five things' })
    const lines = (word: string) =>
      Array.from(
        { length: 300 },
        (_, at) => `export const ${word}${at} = compute(${at}, 'a rather long argument here')`,
      ).join('\n')
    // Five files of three hundred lines: more than one ask takes, so the change
    // is read in two, and the file the judge refuses is in the second of them.
    repo.commit(
      'five things',
      {
        'src/a1.ts': lines('one'),
        'src/a2.ts': lines('two'),
        'src/a3.ts': lines('three'),
        'src/a4.ts': lines('four'),
        'src/zrefused.ts': lines('five'),
      },
      worktree,
    )
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: refusing(/src\/zrefused\.ts/, typesafe({ test_missing: 0.9 })),
    })
    const answer = await loaded.call(
      'jev_review',
      { project: 'shop', task: 'shop/many-files' },
      asked,
    )
    expect(answer.text).toMatch(/\| test_missing \| 0\.90 \|/)
    // And it names what it could not read, because what it did not read it
    // cannot have answered about — **with what was said about it**, since "was
    // not read" is an absence and this is a failure, and telling those two apart
    // is the whole of what a reader of a partial answer needs.
    expect(answer.text).toMatch(/Read in part:.*src\/zrefused\.ts/)
    expect(answer.text).toMatch(
      /could not read because: .*longer than one ask takes: read it in pieces/,
    )
  })
})

// A range somebody named is whatever is in it, and in a checkout everybody
// shares `HEAD` is whoever committed last — so a review of "this change" can
// be a review of somebody else's. Whose a commit is is already read back out
// of the `Tade-Task:` trailer; what was missing was saying so.
describe('whose work a named range holds', () => {
  const asking = {
    ref: 'HEAD~3..HEAD',
    read: true,
    commits: 3,
    mine: 0,
    others: [] as { task: string; commits: number }[],
    unsigned: 0,
  }

  it('says nothing when every commit in it is the asker’s own', () => {
    expect(whoseWork({ ...asking, mine: 3 })).toBeNull()
  })

  it('says plainly that none of it is the asker’s, and whose it is', () => {
    const said = whoseWork({ ...asking, others: [{ task: 'tade/other', commits: 3 }] })
    expect(said).toContain(
      'None of the 3 commits in `HEAD~3..HEAD` carry your `Tade-Task:` trailer',
    )
    expect(said).toContain('tade/other (3)')
    expect(said).toContain('Ask with no ref')
  })

  it('says how much of it is the asker’s when only some of it is', () => {
    const said = whoseWork({
      ...asking,
      mine: 1,
      others: [{ task: 'tade/other', commits: 1 }],
      unsigned: 1,
    })
    expect(said).toContain('1 of the 3 commits in `HEAD~3..HEAD` are yours')
    expect(said).toContain('tade/other (1)')
    // Unattributed is always an allowed answer, and is said as itself rather
    // than given to whoever was nearest.
    expect(said).toContain('1 nobody signed')
  })

  it('says a range nobody signed is nobody’s, rather than naming a task', () => {
    const said = whoseWork({ ...asking, unsigned: 3 })
    expect(said).toContain('not your own change')
    expect(said).toContain('3 nobody signed')
  })

  it('never claims a range with nothing in it is anybody’s', () => {
    expect(whoseWork({ ...asking, commits: 0 })).toContain('holds no commits at all')
  })

  it('says a log it could not read as that, never as a range that is nobody’s', () => {
    // A probe that could not look is not a probe that found nothing: git
    // failing leaves every count at zero, which reads exactly like a range
    // with nothing in it, and the one thing it may never come out as is the
    // confident sentence about whose the commits are.
    const said = whoseWork({ ...asking, read: false, commits: 0 })
    expect(said).toContain('could read whose the commits in `HEAD~3..HEAD` are')
    expect(said).not.toContain('holds no commits at all')
    // And it still says the reading below is not known to be the asker's,
    // because it may only ever add caution.
    expect(said).toContain('not known to be your own change')
  })
})
