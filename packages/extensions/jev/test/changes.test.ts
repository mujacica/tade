import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CHARS_PER_TOKEN, cutTo, partSaid } from '../src/changes.ts'
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
