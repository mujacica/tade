import { CHECK_SHAPES } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { CHECKABLE } from '../src/questions.ts'
import { host, NOW, typesafe } from './harness.ts'

// Mistakes become checks, from the verdicts: the same question confirmed real
// about two changes in one project is proposed as a check, parked.
//
// Through the real tools, end to end — two changes read, two verdicts written,
// one look — because what counts as "confirmed twice" is the precision table's
// to say, and a test that wrote the table by hand would be testing itself.

const asked = { caller: { kind: 'orchestrator' } as const }

/** Two tasks' work in one project, each read against the pack and flagged for the same question. */
async function twoFlagged(answers: Record<string, number> = { test_missing: 0.88 }) {
  const repo = mkrepo()
  const refunds = repo.addTask('add-refunds', { project: 'shop', intent: 'add refunds' })
  repo.commit('refund', { 'src/refund.ts': 'export const refund = () => {}\n' }, refunds)
  const payouts = repo.addTask('add-payouts', { project: 'shop', intent: 'add payouts' })
  repo.commit('payout', { 'src/payout.ts': 'export const payout = () => {}\n' }, payouts)
  const loaded = await host({
    home: repo.home,
    projects: { shop: { root: repo.root } },
    env: { TYPESAFE_API_KEY: 'k' },
    fetch: typesafe(answers),
  })
  for (const task of ['shop/add-refunds', 'shop/add-payouts']) {
    await loaded.call('jev_review', { project: 'shop', task }, asked)
  }
  const judge = (task: string, was: 'confirmed' | 'false positive', question = 'test_missing') =>
    loaded.call(
      'jev_verdict',
      {
        finding: `${task}:${question}`,
        was,
        said: `${task === 'shop/add-refunds' ? 'src/refund.ts' : 'src/payout.ts'} has no test beside it`,
      },
      asked,
    )
  const look = () =>
    loaded.look('jev.mistakes', {
      project: 'shop',
      input: {},
      since: null,
      turnedOn: new Date(NOW - 86_400_000).toISOString(),
      tade: null,
    })
  return { loaded, judge, look }
}

describe('a mistake made twice', () => {
  it('is nothing until a verdict says so, and nothing at one', async () => {
    const { judge, look } = await twoFlagged()
    // Raised about both, judged about neither: an unresolved finding is
    // counted as nothing, however loudly it fired.
    expect((await look()).found).toEqual([])
    await judge('shop/add-refunds', 'confirmed')
    expect((await look()).found).toEqual([])
  })

  it('is proposed as a check once the verdicts say it was real about two changes', async () => {
    const { judge, look } = await twoFlagged()
    await judge('shop/add-refunds', 'confirmed')
    await judge('shop/add-payouts', 'confirmed')
    const looked = await look()
    expect(looked.found.map((one) => one.key)).toEqual(['test_missing'])
    expect(looked.found[0]?.title).toBe(
      'test_missing was confirmed real about shop/add-payouts, shop/add-refunds: a check is proposed',
    )
    const agent = await looked.agent(looked.found[0]!)
    // Parked: a judge only ever adds caution, and this is work for a person to agree to.
    expect(agent.parked).toBe(true)
    expect(agent.title).toBe('check for test_missing')
    expect(agent.prompt).toContain('shop/add-payouts and shop/add-refunds')
    expect(agent.prompt).toContain(CHECK_SHAPES)
    // What each verdict said goes to the context file as material, never the prompt.
    expect(agent.prompt).not.toContain('has no test beside it')
    expect(agent.context).toContain(
      '**shop/add-refunds** · src/refund.ts — src/refund.ts has no test',
    )
    expect(agent.context).toContain('without adding or changing a test that covers it')
    expect(agent.context).toContain('2 of 2, too few to call')
  })

  it('is not made by a false positive', async () => {
    const { judge, look } = await twoFlagged()
    await judge('shop/add-refunds', 'confirmed')
    await judge('shop/add-payouts', 'false positive')
    expect((await look()).found).toEqual([])
  })

  it('is never a question no linter can ask', async () => {
    expect(CHECKABLE).not.toContain('did_what_was_asked')
    expect(CHECKABLE).not.toContain('severity')
    const { judge, look } = await twoFlagged({ did_what_was_asked: 0.9 })
    await judge('shop/add-refunds', 'confirmed', 'did_what_was_asked')
    await judge('shop/add-payouts', 'confirmed', 'did_what_was_asked')
    expect((await look()).found).toEqual([])
  })
})

describe('the watch', () => {
  it('is on by itself where there is a key, and makes work rather than asking', async () => {
    const { loaded } = await twoFlagged()
    expect(loaded.watches().find((one) => one.id === 'jev.mistakes')).toMatchObject({
      standing: true,
      offers: 'agent',
      network: false,
      problem: null,
    })
  })

  it('is not offered at all with no key', async () => {
    const repo = mkrepo()
    const loaded = await host({ home: repo.home, projects: { shop: { root: repo.root } } })
    expect(loaded.watches().find((one) => one.id === 'jev.mistakes')?.problem).toMatch(
      /TYPESAFE_API_KEY/,
    )
  })
})
