import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { RUBRIC } from '../src/questions.ts'
import { readingsToReplay, readJudgeReplays } from '../src/replay.ts'
import { readReviews, recordVerdict } from '../src/reviews.ts'
import { host, typesafe } from './harness.ts'

// A judge asked again: a reading Jev recorded, put to a candidate that answers
// differently, and the two counted beside each other and beside the verdict a
// person wrote — never a finding raised, never a reading recorded.

const asked = { caller: { kind: 'orchestrator' } as const }

/** A repository with one task's change, read once by the judge on record. */
async function readOnce() {
  const repo = mkrepo()
  const worktree = repo.addTask('add-refunds', {
    project: 'shop',
    intent: 'add refunds to the payouts page',
  })
  repo.commit(
    'refund by id\n\nTade-Task: shop/add-refunds',
    { 'src/refund.ts': 'export const refund = (id: string) => exec("refund " + id)\n' },
    worktree,
  )
  const recorded = await host({
    home: repo.home,
    projects: { shop: { root: repo.root } },
    env: { TYPESAFE_API_KEY: 'k' },
    fetch: typesafe({ shell_injection: 0.93, test_missing: 0.71, severity: 2 }),
  })
  await recorded.call('jev_review', { project: 'shop', task: 'shop/add-refunds' }, asked)
  // A person said the first was right and the second was not.
  for (const [question, was] of [
    ['shell_injection', 'confirmed'],
    ['test_missing', 'false positive'],
  ] as const) {
    recordVerdict(repo.home, {
      project: 'shop',
      unit: 'shop/add-refunds',
      question,
      verdict: {
        was,
        by: 'you',
        said: 'src/refund.ts',
        at: '2026-09-20T10:00:00Z',
        cited: 'src/refund.ts',
        rubric: RUBRIC,
      },
    })
  }
  return repo
}

describe('a judge asked again', () => {
  it('counts the candidate beside the recorded answers and the verdicts, and writes it down', async () => {
    const repo = await readOnce()
    const before = readReviews(repo.home).length
    const candidate = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      // Misses the confirmed finding, and raises the dismissed one again.
      fetch: typesafe({ shell_injection: 0.2, test_missing: 0.9 }),
    })
    const answer = await candidate.call(
      'jev_replay',
      { ceiling_usd: 2, model: 'jev-candidate' },
      asked,
    )
    expect(answer.text).toMatch(/asked again about 1 recorded change/)
    expect(answer.text).toMatch(
      /Of 1 finding people confirmed, it raised 0; of 1 they dismissed, it raised 1 again\./,
    )
    // Nothing was read into the record of findings: a replay raises nothing.
    expect(readReviews(repo.home)).toHaveLength(before)
    const [written] = readJudgeReplays(repo.home)
    expect(written).toMatchObject({
      judge: 'jev',
      rubric: RUBRIC,
      against: ['jev-1.13.0'],
      score: {
        read: 1,
        couldNot: 0,
        confirmed: { of: 1, caught: 0 },
        dismissed: { of: 1, raisedAgain: 1 },
      },
    })
    // And it is what the Evaluations page reads, out of the record and never by asking.
    const facts = await candidate.judgeReplays()
    expect(facts.replays).toEqual([
      expect.objectContaining({
        judge: 'jev',
        against: ['jev-1.13.0'],
        costUsd: written?.cost_usd,
      }),
    ])
    // Agreeing on everything but the one that crossed the threshold: the
    // dismissed finding was raised by both, which is agreement, and wrong twice.
    expect(written?.score.asked).toBeGreaterThan(10)
    expect(written?.score.agreed).toBe((written?.score.asked ?? 0) - 1)
  })

  it('will not spend without a ceiling, and is not offered to agents', async () => {
    const repo = await readOnce()
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}),
    })
    await expect(loaded.call('jev_replay', {}, asked)).rejects.toThrow(/ceiling_usd/)
    expect(loaded.specs('agent').map((one) => one.name)).not.toContain('jev_replay')
    expect(loaded.specs('orchestrator').map((one) => one.name)).toContain('jev_replay')
  })

  it('reads only today’s questions, the newest reading of each change', () => {
    const at = (unit: string, when: string, rubric = RUBRIC) => ({
      at: when,
      project: 'shop',
      unit,
      tasks: [unit],
      base: 'a',
      head: 'b',
      version: 'v',
      rubric,
      files: 1,
      part: null,
      requests: 1,
      cost_usd: 0,
      answers: {},
      where: {},
      raised: [],
      account: {},
      verdict: {},
    })
    const chosen = readingsToReplay(
      [at('shop/a', '1'), at('shop/a', '3'), at('shop/b', '2'), at('shop/c', '4', 'old')],
      { last: 5 },
    )
    expect(chosen.map((one) => [one.unit, one.at])).toEqual([
      ['shop/a', '3'],
      ['shop/b', '2'],
    ])
  })
})
