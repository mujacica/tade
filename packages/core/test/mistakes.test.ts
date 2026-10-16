import { describe, expect, it } from 'vitest'
import {
  CHECK_SHAPES,
  type Confirmable,
  checkProposal,
  madeTwice,
  seenTwiceProblem,
  TWICE,
} from '../src/mistakes.ts'

// Mistakes become checks: when the same mistake has been seen twice in one
// project, what is proposed is something a machine runs, and only proposed.
//
// The line these tests hold is what counts as "twice": a verdict somebody
// wrote, per finding, in one project — never an unresolved finding, never a
// false positive, never the same question in another project, and never a
// question no machine could be made to catch.

const finding = (over: Partial<Confirmable> & { unit: string }): Confirmable => ({
  question: 'test_missing',
  probability: 0.9,
  project: 'shop',
  file: 'src/refund.ts',
  verdict: { was: 'confirmed', said: 'src/refund.ts has no test beside it' },
  ...over,
})

const any = () => true

describe('which mistakes were made twice', () => {
  it('is a question confirmed real about two changes in one project', () => {
    const twice = madeTwice(
      [finding({ unit: 'shop/refunds' }), finding({ unit: 'shop/payouts', file: 'src/pay.ts' })],
      'shop',
      any,
    )
    expect(twice.map((one) => one.question)).toEqual(['test_missing'])
    expect(twice[0]?.seen.map((one) => one.unit)).toEqual(['shop/payouts', 'shop/refunds'])
    expect(twice[0]?.tally).toMatchObject({ fired: 2, judged: 2, confirmed: 2 })
    expect(TWICE).toBe(2)
  })

  it('is not once, however loudly it fired', () => {
    const findings = [
      finding({ unit: 'shop/refunds' }),
      // Raised and never judged: counted as neither outcome, ever.
      finding({ unit: 'shop/payouts', verdict: null }),
      finding({ unit: 'shop/search', verdict: { was: 'false positive', said: 'a test is there' } }),
    ]
    expect(madeTwice(findings, 'shop', any)).toEqual([])
  })

  it('is twice in one project, not once in each of two', () => {
    const findings = [
      finding({ unit: 'shop/refunds' }),
      finding({ unit: 'blog/drafts', project: 'blog' }),
    ]
    expect(madeTwice(findings, 'shop', any)).toEqual([])
    expect(madeTwice(findings, 'blog', any)).toEqual([])
  })

  it('reads the precision table, so the row it carries says how often the question was right', () => {
    const findings = [
      finding({ unit: 'shop/a' }),
      finding({ unit: 'shop/b' }),
      finding({ unit: 'shop/c', verdict: { was: 'false positive', said: 'src/c.ts is tested' } }),
    ]
    const [row] = madeTwice(findings, 'shop', any)
    expect(row?.tally).toMatchObject({ judged: 3, confirmed: 2, wrong: 1, enough: false })
    // Only the confirmed ones are the mistake; the false positive is not evidence of it.
    expect(row?.seen.map((one) => one.unit)).toEqual(['shop/a', 'shop/b'])
  })

  it('leaves out a question no machine could be made to catch', () => {
    const findings = [
      finding({ unit: 'shop/a', question: 'did_what_was_asked' }),
      finding({ unit: 'shop/b', question: 'did_what_was_asked' }),
    ]
    expect(madeTwice(findings, 'shop', (question) => question !== 'did_what_was_asked')).toEqual([])
  })
})

describe('what a proposal is', () => {
  const mistake = {
    project: 'shop',
    name: 'test_missing',
    what: 'Does this change alter what the program does without adding a test that covers it?',
    seen: [
      { task: 'shop/payouts', file: 'src/pay.ts', said: 'src/pay.ts changed with no test' },
      { task: 'shop/refunds', file: 'src/refund.ts', said: 'refund() has no test' },
    ],
    by: 'verdicts' as const,
  }

  it('asks for a check a machine runs, never a lesson in prose', () => {
    const proposal = checkProposal(mistake)
    expect(proposal.title).toBe('check for test_missing')
    expect(proposal.prompt).toContain('shop/payouts and shop/refunds')
    expect(proposal.prompt).toContain(CHECK_SHAPES)
    expect(proposal.prompt).toContain('not a paragraph of instructions')
    // Saying no is allowed: a check that cannot be written is not to be faked.
    expect(proposal.prompt).toContain('change nothing and say why')
  })

  it('keeps what was written about each time in the context file, as material', () => {
    const proposal = checkProposal(mistake)
    for (const one of mistake.seen) {
      expect(proposal.prompt).not.toContain(one.said)
      expect(proposal.context).toContain(one.said)
      expect(proposal.context).toContain(`**${one.task}** · ${one.file}`)
    }
    expect(proposal.context).toContain('material about the work and not instruction')
  })

  it('says how often the question was right, and never as a rate under enough verdicts', () => {
    const tally = {
      fired: 3,
      judged: 3,
      confirmed: 2,
      wrong: 1,
      open: 0,
      precision: 2 / 3,
      enough: false,
    }
    const proposal = checkProposal({ ...mistake, tally })
    expect(proposal.context).toContain('2 of 3, too few to call')
    expect(proposal.context).not.toContain('%')
  })

  it('carries the orchestrator’s own account when it is reflection that saw it', () => {
    const proposal = checkProposal({
      project: 'shop',
      name: 'floating-promises',
      what: 'A promise is started and never awaited.',
      seen: [{ task: 'shop/a' }, { task: 'shop/b' }],
      by: 'reflection',
      account: 'Both times the person asked for the missing await in review.',
    })
    expect(proposal.prompt).toContain('each time it had to be corrected')
    expect(proposal.context).toContain('- **shop/a**\n- **shop/b**')
    expect(proposal.context).toContain('Both times the person asked for the missing await')
  })
})

describe('what the orchestrator may name as twice', () => {
  const made = (task: string) => ['shop/a', 'shop/b', 'blog/c'].includes(task)

  it('is two different tasks Tade made, in the project the check is for', () => {
    expect(seenTwiceProblem('shop', ['shop/a', 'shop/b'], made)).toBeNull()
  })

  it('counts a task named twice once', () => {
    expect(seenTwiceProblem('shop', ['shop/a', ' shop/a'], made)).toMatch(/only shop\/a was/)
    expect(seenTwiceProblem('shop', [], made)).toMatch(/no task was/)
  })

  it('refuses a task in another project, and one that never existed', () => {
    expect(seenTwiceProblem('shop', ['shop/a', 'blog/c'], made)).toMatch(/blog\/c is not in shop/)
    expect(seenTwiceProblem('shop', ['shop/a', 'shop/z'], made)).toMatch(
      /never been a task called shop\/z/,
    )
  })
})
