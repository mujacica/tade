import type { CheckRun, CheckState } from '@tade/checks-core'
import { testForge } from '@tade/forges-core/conformance'
import { describe, expect, it } from 'vitest'
import { makeScriptedForge, type ScriptedReview, type ScriptedTicket } from '../src/index.ts'

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

// The patch of #412, two files, one of them handed over as nothing — a binary
// file is the ordinary reason, and a reviewer told "nothing changed" about one
// would be reviewing a file it never saw.
const patches = {
  'acme/api#412': [
    {
      path: 'src/refunds.ts',
      from: null,
      added: 4,
      removed: 1,
      what: 'changed' as const,
      patch: '@@ -10,4 +10,7 @@\n context\n+  retry(once)\n+  keep(key)\n+  log(it)\n-  retry()\n',
    },
    {
      path: 'docs/logo.png',
      from: null,
      added: 0,
      removed: 0,
      what: 'changed' as const,
      patch: null,
    },
  ],
}

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

// Two filed requests: one whose `tade` label somebody is named for, and one
// whose label nobody can be — the second is the answer a forge that keeps no
// history of labelling gives, and a caller deciding on a labeller has to
// handle it rather than falling back to the author.
const tickets: ScriptedTicket[] = [
  {
    ref: { repo: 'acme/api', number: 501, host: 'scripted.test' },
    title: 'Refund retries drop the idempotency key',
    body: 'Two refunds go out when the first attempt times out.',
    labels: ['tade', 'bug'],
    author: { login: 'kim', bot: false },
    labelled: [{ label: 'tade', by: { login: 'kim', bot: false }, at: '2026-09-18T08:07:00.000Z' }],
  },
  {
    ref: { repo: 'acme/api', number: 502, host: 'scripted.test' },
    title: 'Typo in the README',
    labels: ['tade'],
    author: { login: 'stranger', bot: false },
  },
]

testForge('scripted', () => makeScriptedForge({ reviews, commits, logs, tickets, patches }), {
  ref: { repo: 'acme/api', number: 412, host: 'scripted.test' },
  unknown: { repo: 'acme/api', number: 9999, host: 'scripted.test' },
  remotes: { serves: 'git@scripted.test:acme/api.git', not: 'git@github.com:acme/api.git' },
  branches: { withReview: 'shop/refunds-retry', without: 'nothing-here' },
  commits: { withChecks: 'a1b2c3d', nothingRan: '0000000' },
  signedOut: () => makeScriptedForge({ reviews, me: null, trouble: 'auth' }),
  limited: () => makeScriptedForge({ reviews, trouble: 'rate' }),
  readOnly: () => makeScriptedForge({ reviews, can: 'read', patches }),
  tickets: { repo: 'acme/api', label: 'tade', unknown: 9999 },
})

testForge(
  'scripted with no tickets, no patch and no notes',
  () =>
    makeScriptedForge({
      reviews,
      commits,
      logs,
      capabilities: { tickets: false, patches: false, notes: false },
    }),
  {
    ref: { repo: 'acme/api', number: 412, host: 'scripted.test' },
    unknown: { repo: 'acme/api', number: 9999, host: 'scripted.test' },
    remotes: { serves: 'git@scripted.test:acme/api.git', not: 'git@github.com:acme/api.git' },
    branches: { withReview: 'shop/refunds-retry', without: 'nothing-here' },
    commits: { withChecks: 'a1b2c3d', nothingRan: '0000000' },
  },
)

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

  it('answers a note per note, so one line that moved never hides the rest', async () => {
    const ref = { repo: 'acme/api', number: 412, host: 'scripted.test' }
    const forge = makeScriptedForge({
      reviews,
      patches,
      refuses: { 'src/refunds.ts:99': 'that line is not part of the diff' },
    })
    const patch = await forge.patch(ref)
    // Pinned: the commit the patch is of comes back with it, and it is the
    // commit the notes are then written against.
    expect(patch.head).toBe('a1b2c3d')
    expect(patch.files.map((one) => one.patch === null)).toEqual([false, true])
    const receipts = await forge.note(ref, {
      on: patch.head,
      body: 'Two things, neither a verdict.',
      notes: [
        { path: 'src/refunds.ts', line: 12, body: 'the key is dropped here' },
        { path: 'src/refunds.ts', line: 99, body: 'about a line that moved' },
      ],
    })
    expect(receipts.map((one) => one.posted)).toEqual([true, false])
    expect(receipts[1]?.said).toContain('not part of the diff')
    const noted = forge.wrote.find((one) => one.kind === 'noted')
    // Only what went up is written down: a test asking what Tade put in
    // somebody's repository reads the same thing the receipts say.
    expect(noted?.kind === 'noted' && noted.notes.map((one) => one.line)).toEqual([12])
    expect(noted?.kind === 'noted' && noted.on).toBe('a1b2c3d')
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
