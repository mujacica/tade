import type { CheckRun, CheckState } from '@tade/checks-core'
import { testForge } from '@tade/forges-core/conformance'
import { describe, expect, it } from 'vitest'
import { makeScriptedForge, type ScriptedReview } from '../src/index.ts'

/** One run on a commit, as much of it as these tests care to say. */
const ran = (commit: string, check: string, state: CheckState): CheckRun => ({
  id: `${commit}:${check}:scripted:1`,
  check,
  commit,
  state,
  where: { kind: 'forge', forge: 'scripted', job: check, url: null },
  required: check !== 'format',
  startedAt: '2026-09-19T05:01:00.000Z',
  finishedAt: state === 'running' ? null : '2026-09-19T05:03:00.000Z',
  code: null,
  summary: state === 'failed' ? '8 failed' : null,
  by: null,
})

// What ran on two commits: a review's head, and a push straight to `main`
// that nobody opened anything for — the case the branch watch is about.
const commits = {
  'acme/api@a1b2c3d': [ran('a1b2c3d', 'format', 'passed'), ran('a1b2c3d', 'tests', 'passed')],
  'acme/api@deadbee': [ran('deadbee', 'format', 'passed'), ran('deadbee', 'tests', 'failed')],
}
const logs = { 'acme/api@deadbee:tests': 'FAIL src/refunds.test.ts\n  8 failed, 412 passed\n' }

const reviews: ScriptedReview[] = [
  {
    ref: { repo: 'acme/api', number: 412, host: 'scripted.test' },
    title: 'retry refunds once',
    head: { branch: 'shop/refunds-retry', sha: 'a1b2c3d' },
    mine: true,
    author: 'you',
    checks: 'passed',
    decision: 'approved',
    task: 'shop/refunds-retry',
  },
  {
    ref: { repo: 'acme/api', number: 418, host: 'scripted.test' },
    title: 'stripe v15',
    head: { branch: 'shop/stripe-v15', sha: 'ffee001' },
    author: 'somebody',
    mine: false,
    waitingOnYou: true,
    checks: 'failed',
    state: 'draft',
  },
]

testForge('scripted', () => makeScriptedForge({ reviews, commits, logs }), {
  ref: { repo: 'acme/api', number: 412, host: 'scripted.test' },
  unknown: { repo: 'acme/api', number: 9999, host: 'scripted.test' },
  remotes: { serves: 'git@scripted.test:acme/api.git', not: 'git@github.com:acme/api.git' },
  branches: { withReview: 'shop/refunds-retry', without: 'nothing-here' },
  commits: { withChecks: 'a1b2c3d', nothingRan: '0000000' },
  signedOut: () => makeScriptedForge({ reviews, me: null, trouble: 'auth' }),
  limited: () => makeScriptedForge({ reviews, trouble: 'rate' }),
  readOnly: () => makeScriptedForge({ reviews, can: 'read' }),
})

describe('a forge that answers from a table', () => {
  it('keeps what it was asked to change, without changing anything real', async () => {
    const forge = makeScriptedForge({ reviews })
    await forge.open({
      repo: 'acme/api',
      head: 'shop/new',
      base: 'main',
      title: 'a new one',
      body: 'Tade-Task: shop/new\n',
      draft: true,
    })
    await forge.say({ repo: 'acme/api', number: 412, host: 'scripted.test' }, { body: 'hello' })
    expect(forge.wrote.map((one) => one.kind)).toEqual(['opened', 'said'])
    const found = await forge.reviewOf('acme/api', 'shop/new')
    expect(found?.state).toBe('draft')
    expect(found?.task).toBe('shop/new')
  })

  it('publishes a head ref only when it is told to, because both answers are real', async () => {
    // Which is why the table's default is `null`: a forge that publishes no ref
    // for a review's head is the half nothing else here covers, and a checkout
    // of one can only ever be its own branch.
    const ref = { repo: 'acme/api', number: 412, host: 'scripted.test' }
    expect(makeScriptedForge({ reviews }).headRef(ref)).toBeNull()
    expect(makeScriptedForge({ reviews, headRefs: true }).headRef(ref)).toBe('refs/pull/412/head')
  })

  it('says what ran on a commit nobody opened anything for, and hands back its log', async () => {
    // A push to `main` has no review to ask through, so the commit is the
    // whole address: this is what watching CI on the branch you are on reads.
    const forge = makeScriptedForge({ reviews, commits, logs })
    const runs = await forge.checksOn('acme/api', 'deadbee')
    expect(runs.map((one) => `${one.check}:${one.state}`)).toEqual([
      'format:passed',
      'tests:failed',
    ])
    expect(await forge.checkLogOn('acme/api', 'deadbee', 'tests', 1)).toBe('')
    expect(await forge.checkLogOn('acme/api', 'deadbee', 'tests', 2)).toContain('8 failed')
    expect(forge.wrote).toEqual([])
  })

  it('hands back the review a branch already has rather than opening a second', async () => {
    const forge = makeScriptedForge({ reviews })
    const again = await forge.open({
      repo: 'acme/api',
      head: 'shop/refunds-retry',
      base: 'main',
      title: 'again',
      body: '',
      draft: false,
    })
    expect(again.ref.number).toBe(412)
    expect(forge.wrote).toEqual([])
  })
})
