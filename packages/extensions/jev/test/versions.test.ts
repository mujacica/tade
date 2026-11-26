import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { findingsOf } from '../src/loop.ts'
import { findingsReport } from '../src/page.ts'
import { precisionOf } from '../src/precision.ts'
import { RUBRIC } from '../src/questions.ts'
import { versionSaid } from '../src/review.ts'
import { type Review, recordReview } from '../src/reviews.ts'
import { host, NOW, typesafe } from './harness.ts'

// Jev follows TypeSafe's latest rather than a pin, so three things have to be
// true at once: every reading keeps the version that actually answered and the
// record is counted by it; a change of version is said once; and a judge that
// cannot answer at all — the morning `jev-1.13.0` was retired, every ask was a
// 400 and the review watch read as though it had found nothing — is a look that
// could not look, every time, in words.

const DAY = 86_400_000

/** The harness's TypeSafe, answering as whichever version a test says. */
function answeringAs(version: () => string, answers: Record<string, number> = {}): typeof fetch {
  const inner = typesafe(answers)
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await inner(input as string, init)
    if (init?.method !== 'POST') return response
    return Response.json({ ...((await response.json()) as object), model: version() })
  }) as typeof fetch
}

/** A TypeSafe that has retired whatever it is asked for, as it answered that morning. */
const retired = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith('/v1/models')) return Response.json({ data: [{ id: 'jev-1.13.0' }] })
  const body = JSON.parse(String(init?.body)) as { model?: string }
  return new Response(`Unknown model: ${body.model ?? ''}`, { status: 400 })
}) as typeof fetch

function look(loaded: Awaited<ReturnType<typeof host>>, since: string | null = null) {
  return loaded.look('jev.review', {
    project: 'shop',
    input: { settle: '0m' },
    since,
    turnedOn: new Date(NOW - 60_000).toISOString(),
  })
}

describe('a judge that cannot answer at all', () => {
  it('is a look that could not look, never one that found nothing, beside a change it never had to ask about', async () => {
    const repo = mkrepo()
    const work = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = 1\n' }, work)
    // Nothing in this one a question could be about, so the judge is never
    // asked: it used to count as a change that was read, and with it a look in
    // which every ask was refused came back as having found nothing.
    const lock = repo.addTask('bump-lock', { project: 'shop', intent: 'bump the lockfile' })
    repo.commit('lock', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, lock)
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: retired,
      now: Date.now,
    })
    // The same sentence every look, so the window says it when it starts going
    // wrong and the strip and the brief carry it for as long as it stays wrong.
    for (let n = 0; n < 2; n++) {
      await expect(look(loaded)).rejects.toThrow(
        /^Jev cannot answer at all, so (the one change waiting was not reviewed|none of the 2 changes waiting were reviewed): .*not one it has.*Unknown model: jev-1\.13\.0/,
      )
    }
  })

  it('says a pin TypeSafe no longer has as the setting to change', async () => {
    const repo = mkrepo()
    const work = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = 1\n' }, work)
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      settings: { model: 'jev-1.12.0' },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: retired,
      now: Date.now,
    })
    await expect(look(loaded)).rejects.toThrow(
      /Jev cannot answer at all.*does not have jev-1\.12\.0, which extensions\.jev\.model pins/,
    )
  })

  it('goes first in the brief, counted back to the last look that looked', async () => {
    const repo = mkrepo()
    const home = repo.home
    const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
    writeFileSync(
      join(home, 'schedules.jsonl'),
      `${JSON.stringify({
        op: 'set',
        by: 'you',
        at: at(120),
        schedule: {
          id: 'jev-review',
          name: 'Review what agents change',
          project: 'shop',
          said: '',
          when: { every: '10m' },
          does: { kind: 'watch', watch: 'jev.review', input: {}, found: 'ask', most: 2 },
          missed: 'once',
          by: 'you',
          created: at(120),
        },
      })}\n`,
    )
    const problem =
      'Jev cannot answer at all, so the one change waiting was not reviewed: TypeSafe answered 400'
    const checked = (seq: number, minutes: number, detail: Record<string, unknown>) =>
      JSON.stringify({
        seq,
        ts: at(minutes),
        type: 'watch_checked',
        urgency: 'routine',
        detail: { schedule: 'jev-review', ...detail },
      })
    writeFileSync(
      join(home, 'events.jsonl'),
      `${[
        checked(1, 40, { found: 0, fresh: [], left: 0, since: '{}' }),
        checked(2, 30, { problem }),
        checked(3, 20, { problem }),
        checked(4, 10, { problem }),
      ].join('\n')}\n`,
    )
    const loaded = await host({ home, env: { TYPESAFE_API_KEY: 'k' } })
    const brief = await loaded.brief()
    expect(brief.items[0]?.said).toBe(`Jev could not look the last 3 times: ${problem}`)
    expect(brief.items[0]?.ask).toMatch(/what is stopping Jev/)
  })
})

describe('following the latest version', () => {
  it('says once that another version answers, and never about the first one heard', async () => {
    const repo = mkrepo()
    const work = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = 1\n' }, work)
    let version = 'jev-1.14.0'
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: answeringAs(() => version),
      now: Date.now,
    })
    const first = await look(loaded)
    expect(first.said ?? '').not.toMatch(/now answers/)

    version = 'jev-1.15.0'
    repo.commit('more', { 'src/more.ts': 'export const more = 1\n' }, work)
    const moved = await look(loaded, first.since)
    expect(moved.said).toMatch(/^Jev now answers as jev-1\.15\.0 \(it was jev-1\.14\.0\)/)

    repo.commit('again', { 'src/again.ts': 'export const again = 1\n' }, work)
    const again = await look(loaded, moved.since)
    expect(again.said ?? '').not.toMatch(/now answers/)
  })

  it('says nothing when nothing moved or nothing answered', () => {
    expect(versionSaid('', 'jev-1.14.0')).toBeNull()
    expect(versionSaid('jev-1.14.0', 'jev-1.14.0')).toBeNull()
    expect(versionSaid('jev-1.14.0', '')).toBeNull()
  })

  it('keeps the version that answered under the alias, not the alias', async () => {
    const repo = mkrepo()
    const work = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
    repo.commit('refund', { 'src/refund.ts': 'export const refund = 1\n' }, work)
    const seen: { model?: string }[] = []
    const inner = typesafe({}, seen)
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: inner,
      now: Date.now,
    })
    const answer = await loaded.call(
      'jev_review',
      { project: 'shop', task: 'shop/add-refunds' },
      { caller: { kind: 'orchestrator' } },
    )
    // Asked under TypeSafe's own alias, with nothing pinned.
    expect(seen[0]?.model).toBe('jev-latest')
    expect(answer.text).toMatch(/answered by jev-1\.14\.0/)
  })
})

describe('the record, by the version that answered', () => {
  const review = (at: number, unit: string, version: string, over: Partial<Review> = {}) =>
    ({
      at: new Date(at).toISOString(),
      project: 'shop',
      unit,
      tasks: [unit],
      base: 'main',
      head: 'head',
      version,
      rubric: RUBRIC,
      files: 1,
      part: null,
      requests: 1,
      cost_usd: 0.001,
      answers: { test_missing: 0.9 },
      where: { test_missing: 'src/a.ts' },
      raised: ['test_missing'],
      account: {},
      verdict: {},
      ...over,
    }) satisfies Review

  const reviews = [
    review(NOW - 3 * DAY, 'shop/old', 'jev-1.13.0'),
    review(NOW - DAY, 'shop/new', 'jev-1.14.0'),
    review(NOW - DAY / 2, 'shop/quiet', 'jev-1.14.0', { raised: [] }),
  ]

  it('counts each version on its own, newest first', () => {
    const found = precisionOf(findingsOf(reviews), reviews, {
      now: NOW,
      dayAt: (at) => at - (at % DAY),
    })
    expect(
      found.byVersion.map((row) => [row.version, row.read, row.tally.fired, row.tally.open]),
    ).toEqual([
      ['jev-1.14.0', 2, 1, 1],
      ['jev-1.13.0', 1, 1, 1],
    ])
    expect(findingsOf(reviews).map((one) => [one.key, one.version])).toEqual([
      ['shop/new:test_missing', 'jev-1.14.0'],
      ['shop/old:test_missing', 'jev-1.13.0'],
    ])
  })

  it('is what jev_findings says, to the orchestrator and to the agent whose change it was', async () => {
    const repo = mkrepo()
    for (const one of reviews) recordReview(repo.home, one)
    const loaded = await host({ home: repo.home, env: { TYPESAFE_API_KEY: 'k' } })
    const told = await loaded.call('jev_findings', {}, { caller: { kind: 'orchestrator' } })
    expect(told.text).toMatch(/## By version/)
    expect(told.text).toMatch(/jev-1\.14\.0 +2 +1/)
    expect(told.text).toMatch(/jev-1\.13\.0 +1 +1/)
    expect(told.text).toMatch(/counted on its own/)
    expect(
      findingsReport({ reviews, looks: [], findings: [], finished: new Set(), now: NOW }),
    ).toBe(told.text)
    const agent = await loaded.call(
      'jev_findings',
      {},
      { caller: { kind: 'agent' as const, task: 'shop/new', project: 'shop', cwd: repo.root } },
    )
    expect(agent.text).toMatch(/shop\/new:test_missing\*\* — 0\.90 from jev-1\.14\.0/)
  })
})
