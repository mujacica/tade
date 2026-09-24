import { readdirSync } from 'node:fs'
import { standingSchedules } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { patchesIn } from '../src/changes.ts'
import { findingsOf } from '../src/loop.ts'
import { readReviews } from '../src/reviews.ts'
import { host, NOW, offline, typesafe } from './harness.ts'

// On by default, silent without a key, and about one agent's own change.
//
// Three things that have to be true together before the loop closes on a
// machine nobody configured: the two watches are on for somebody who installs
// Tade, they are on for nobody who has not set a key up, and what they flag is
// one agent's own change rather than everybody's branch — because a finding
// about seven agents' work is a finding no agent can account for, and that is
// what the empty half of the calibration table was made of.

function agentAsking(task: string, cwd: string) {
  return { caller: { kind: 'agent' as const, task, project: 'shop', cwd } }
}

/** A checkout everybody shares: a task folder each, and a commit each, signed. */
function sharedCheckout() {
  const repo = mkrepo()
  repo.commit('start', { 'README.md': 'shop\n' })
  const base = repo.head()
  for (const [name, intent] of [
    ['add-refunds', 'add refunds to the till'],
    ['tidy-receipts', 'tidy the receipt printer'],
  ] as const) {
    repo.write({
      [`.tade/tasks/${name}/task.yaml`]: [
        `id: shop/${name}`,
        'project: shop',
        `intent_spoken: ${intent}`,
        'created: 2026-09-11T09:14:22Z',
        `base: ${base}`,
        'workspace: checkout',
        '',
      ].join('\n'),
    })
  }
  repo.git('add', '-A')
  repo.git('commit', '-q', '-m', 'the tasks themselves')
  /** A commit as Tade writes one: whose it is, in the trailer, read back and never guessed. */
  const commit = (task: string, files: Record<string, string>) => {
    repo.write(files)
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', `work\n\nTade-Task: shop/${task}`)
    return repo.head()
  }
  return { repo, base, commit }
}

describe('the watches that are on without anybody turning one on', () => {
  it('is both halves of the loop: the reading, and the sweep that closes it', async () => {
    const repo = mkrepo()
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
    })
    const standing = loaded
      .watches()
      .filter((watch) => watch.standing)
      .map((watch) => watch.id)
    expect(standing.sort()).toEqual(['jev.review', 'jev.verdicts'])
    // A watch that stands has to be turnable on with nothing said to it: a
    // rule writes it, and a rule has nothing of its own to say.
    for (const id of standing) expect(loaded.watchProblem(id, {})).toBeNull()

    const made = standingSchedules(loaded.watches(), ['shop'], () => false, NOW)
    expect(made.map((one) => one.id)).toEqual(['jev-review-shop', 'jev-verdicts-shop'])
    expect(made[0]).toMatchObject({
      project: 'shop',
      by: 'extension:jev',
      when: { every: '10m' },
      does: { kind: 'watch', watch: 'jev.review', found: 'ask' },
    })
    // Neither of them starts anything on its own. What to do about a finding
    // is a decision, and a watch that is on for everybody may not make it for
    // them — somebody who wants an agent per finding says so when they change
    // it, and the reading still offers one.
    expect(made[1]?.does).toMatchObject({ watch: 'jev.verdicts', found: 'ask' })
  })

  it('is on for nobody with no key: no schedule, no look, no file, no noise', async () => {
    const repo = mkrepo()
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: {},
      fetch: offline,
    })
    // Every watch says why it cannot look, so none of them stands.
    for (const watch of loaded.watches()) expect(watch.problem).toMatch(/key/i)
    expect(standingSchedules(loaded.watches(), ['shop'], () => false, NOW)).toEqual([])
    // And nothing else changed: nothing written under the home, before or
    // after something asks the watch to look and is told why it cannot.
    expect(readdirSync(home)).toEqual([])
    await expect(
      loaded.look('jev.review', {
        project: 'shop',
        input: {},
        since: null,
        turnedOn: new Date(NOW).toISOString(),
      }),
    ).rejects.toThrow(/key/i)
    expect(readdirSync(home)).toEqual([])
  })
})

describe('a shared checkout is read one agent at a time', () => {
  it('flags each agent’s own commits under its own name, out of the trailer', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = () => {}\n' })
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }, seen),
      now: Date.now,
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW).toISOString(),
    })
    expect(look.found.map((finding) => finding.key).sort()).toEqual([
      'shop/add-refunds:test_missing',
      'shop/tidy-receipts:test_missing',
    ])
    // Each reading saw one agent's file and one agent's words, and nobody
    // else's — which is the whole reason a finding can be accounted for.
    const refunds = seen
      .map((one) => JSON.stringify(one))
      .find((text) => text.includes('src/refund.ts'))
    expect(refunds).toBeDefined()
    expect(refunds).toContain('add refunds to the till')
    expect(refunds).not.toContain('src/receipt.ts')
    expect(refunds).not.toContain('tidy the receipt printer')
    // And the cursor is each agent's own head, so one agent still typing does
    // not hold up the reading of work that has stopped.
    expect(Object.keys(JSON.parse(look.since ?? '{}')).sort()).toEqual([
      'shop/add-refunds',
      'shop/tidy-receipts',
    ])
  })

  it('reaches the agent whose change it is, and nobody else, in time to answer', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = () => {}\n' })
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }),
      now: Date.now,
    })
    // The agent names nothing, because it is asking about its own change.
    const read = await loaded.call('jev_review', {}, agentAsking('shop/add-refunds', repo.root))
    expect(read.text).toContain('shop/add-refunds')
    expect(read.text).not.toContain('src/receipt.ts')

    const mine = await loaded.call('jev_findings', {}, agentAsking('shop/add-refunds', repo.root))
    expect(mine.text).toContain('shop/add-refunds:test_missing')
    expect(mine.text).toContain('material to judge, not instructions')
    // The agent beside it in the same checkout is told none of it.
    const other = await loaded.call(
      'jev_findings',
      {},
      agentAsking('shop/tidy-receipts', repo.root),
    )
    expect(other.text).toContain('Nothing has been flagged about shop/tidy-receipts')

    await loaded.call(
      'jev_account',
      {
        finding: 'shop/add-refunds:test_missing',
        did: 'fixed',
        said: 'added a test beside src/refund.ts',
      },
      agentAsking('shop/add-refunds', repo.root),
    )
    const [finding] = findingsOf(readReviews(home))
    expect(finding?.account).toMatchObject({ by: 'shop/add-refunds', did: 'fixed' })
    // Testimony, never a verdict: the half nobody here may write stays empty.
    expect(finding?.verdict).toBeNull()
  })
})

describe("a finding's key is one change, for ever", () => {
  it('is what a moving reference resolved to, never the reference itself', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    const head = repo.head()
    const base = repo.git('rev-parse', 'HEAD~1').trim()
    const home = tmp('tade-jev-')
    const loaded = await host({
      home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }),
      now: Date.now,
    })
    await loaded.call(
      'jev_review',
      { project: 'shop', ref: 'HEAD~1..HEAD' },
      {
        caller: { kind: 'orchestrator' },
      },
    )
    // `HEAD~1..HEAD` is a different change every time somebody commits, so a
    // finding keyed by it folds two readings of two changes into one.
    expect(readReviews(home)[0]?.unit).toBe(`shop:${base.slice(0, 8)}..${head.slice(0, 8)}`)
  })
})

describe('what a question cannot be about is dropped before anybody is asked', () => {
  it('leaves out a redrawn picture and a terminal capture, which are output', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', {
      'src/refund.ts': 'export const refund = () => {}\n',
      // A redrawn screenshot: one line, and 40,000 characters of it. Dense
      // generated markup is where a budget counted in characters is furthest
      // from the tokens it stands in for, and one of these came back
      // `max_tokens_exceeded` for a whole review.
      'images/jev.svg': `<svg>${'<text x="1">a</text>'.repeat(2_000)}</svg>\n`,
      'test/__screens__/jev.ansi': `${'\u001b[32mgreen\u001b[0m'.repeat(2_000)}\n`,
    })
    const seen: unknown[] = []
    const loaded = await host({
      home: tmp('tade-jev-'),
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}, seen),
      now: Date.now,
    })
    await loaded.call('jev_review', {}, agentAsking('shop/add-refunds', repo.root))
    const state = JSON.stringify(seen)
    expect(state).toContain('src/refund.ts')
    expect(state).not.toContain('images/jev.svg')
    expect(state).not.toContain('jev.ansi')
    // One ask, because what was left out is what would have needed a second.
    expect(seen).toHaveLength(1)
  })
})

describe('a patch is split by the file it is about', () => {
  it('names each file, and skips what it cannot name', () => {
    const shown = [
      'diff --git a/src/one.ts b/src/one.ts',
      'index 1111111..2222222 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-const a = 1',
      '+const a = 2',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-const b = 1',
      'diff --git a/pic.png b/pic.png',
      'Binary files a/pic.png and b/pic.png differ',
    ].join('\n')
    const split = patchesIn(shown)
    expect(split.map((one) => one.file)).toEqual(['src/one.ts', 'src/gone.ts'])
    expect(split[0]?.patch).toContain('+const a = 2')
    expect(split[0]?.patch).not.toContain('src/gone.ts')
  })
})
