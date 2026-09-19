import { testForge } from '@tade/forges-core/conformance'
import { describe, expect, it } from 'vitest'
import { makeScriptedForge, type ScriptedReview } from '../src/index.ts'

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

testForge('scripted', () => makeScriptedForge({ reviews }), {
  ref: { repo: 'acme/api', number: 412, host: 'scripted.test' },
  unknown: { repo: 'acme/api', number: 9999, host: 'scripted.test' },
  remotes: { serves: 'git@scripted.test:acme/api.git', not: 'git@github.com:acme/api.git' },
  branches: { withReview: 'shop/refunds-retry', without: 'nothing-here' },
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
