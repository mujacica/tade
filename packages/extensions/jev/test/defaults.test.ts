import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MOST, standingSchedules } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { patchesIn } from '../src/changes.ts'
import { findingsOf } from '../src/loop.ts'
import { RUBRIC } from '../src/questions.ts'
import { type Review, readReviews, recordReview } from '../src/reviews.ts'
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
    // In Tade's home, not in the checkout: nothing about a task is in the
    // repository, so none of this is ever in a commit somebody reads.
    mkdirSync(join(repo.home, 'projects', 'shop', 'tasks', name), { recursive: true })
    writeFileSync(
      join(repo.home, 'projects', 'shop', 'tasks', name, 'task.yaml'),
      [
        `id: shop/${name}`,
        'project: shop',
        `intent_spoken: ${intent}`,
        'created: 2026-09-11T09:14:22Z',
        `base: ${base}`,
        'workspace: checkout',
        '',
      ].join('\n'),
    )
  }
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
  it('is both halves of the loop, the reading and the sweep, and what a mistake made twice becomes', async () => {
    const repo = mkrepo()
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
    })
    const standing = loaded
      .watches()
      .filter((watch) => watch.standing)
      .map((watch) => watch.id)
    expect(standing.sort()).toEqual(['jev.mistakes', 'jev.review', 'jev.verdicts'])
    // A watch that stands has to be turnable on with nothing said to it: a
    // rule writes it, and a rule has nothing of its own to say.
    for (const id of standing) expect(loaded.watchProblem(id, {})).toBeNull()

    const made = standingSchedules(loaded.watches(), ['shop'], () => false, NOW)
    expect(made.map((one) => one.id)).toEqual([
      'jev-review-shop',
      'jev-verdicts-shop',
      'jev-mistakes-shop',
    ])
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
    // Two is the right ceiling on agents started and the wrong one on questions
    // asked. The sweep starts nothing, and metered at two an hour a backlog of
    // nine takes five hours to be mentioned once — which is how nine findings
    // came to sit open for three days with nobody having decided against them.
    expect(made[0]?.does).toMatchObject({ most: DEFAULT_MOST })
    expect(made[1]?.does.kind === 'watch' && made[1].does.most).toBeGreaterThan(DEFAULT_MOST)
    // The one that makes work makes it parked (`mistakes.test.ts`): a check a
    // judge proposed is put to the orchestrator, so it starts nothing by rule either.
    expect(made[2]?.does).toMatchObject({ watch: 'jev.mistakes', found: 'agent' })
  })

  it('is on for nobody with no key: no schedule, no look, no file, no noise', async () => {
    const repo = mkrepo()
    const home = repo.home
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
      home: repo.home,
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
    // What a reader is told to run shows that agent's own commits, because a
    // diff between two of them takes in whatever landed in between.
    const detail = look.found.find((one) => one.key.startsWith('shop/add-refunds'))?.detail ?? ''
    expect(detail).toMatch(/git show [0-9a-f]{40} -- src\/refund\.ts/)
  })

  it('measures from the oldest point any of them branched at, never from one of them', async () => {
    const { repo, commit } = sharedCheckout()
    // One agent's morning, and then a task made at HEAD — which is what a task
    // folder looks like all day. It sorts first by name, and the base that was
    // taken used to be the first one that sorted, so the morning fell outside
    // the range and nothing was read at all. That is what the watch's one look
    // at this repository did: `found: 0`, with an afternoon of work in front
    // of it.
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    repo.write({
      '.tade/tasks/a-late-arrival/task.yaml': [
        'id: shop/a-late-arrival',
        'project: shop',
        'intent_spoken: something else entirely',
        'created: 2026-09-11T09:14:22Z',
        `base: ${repo.head()}`,
        'workspace: checkout',
        '',
      ].join('\n'),
    })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'a task file')
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }),
      now: Date.now,
    })
    const look = await loaded.look('jev.review', {
      project: 'shop',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW).toISOString(),
    })
    expect(look.found.map((one) => one.key)).toEqual(['shop/add-refunds:test_missing'])
  })

  it('reaches the agent whose change it is, and nobody else, in time to answer', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = () => {}\n' })
    const home = repo.home
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

  it('says whose the commits in a named range are, rather than reading them silently', async () => {
    const { repo, commit } = sharedCheckout()
    commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = () => {}\n' })
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }),
      now: Date.now,
    })
    // `HEAD` in a checkout everybody shares is whoever committed last, which
    // here is the agent beside this one. The range is read, because a range
    // somebody named is a range somebody meant — but never as this agent's
    // own change.
    const read = await loaded.call(
      'jev_review',
      { ref: 'HEAD~1..HEAD' },
      agentAsking('shop/add-refunds', repo.root),
    )
    expect(read.text).toContain('carry your `Tade-Task:` trailer')
    expect(read.text).toContain('shop/tidy-receipts (1)')
    // Said before the table, never after it: a table of probabilities under
    // nothing reads as a table about the asker's own change.
    expect(read.text.indexOf('Tade-Task:')).toBeLessThan(read.text.indexOf('| question |'))
    // And it is a sentence and not a refusal: the reading still happened.
    expect(read.text).toContain('test_missing')
  })

  it('files what a named range turned up under whose commits are in it, never under the asker', async () => {
    const { repo, commit } = sharedCheckout()
    commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = () => {}\n' })
    const seen: unknown[] = []
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }, seen),
      now: Date.now,
    })
    await loaded.call(
      'jev_review',
      { ref: 'HEAD~1..HEAD' },
      agentAsking('shop/add-refunds', repo.root),
    )
    // Filed under everybody in the checkout, the asker was handed a finding
    // about a commit it never made as its own change to account for.
    expect(readReviews(repo.home)[0]?.tasks).toEqual(['shop/tidy-receipts'])
    const asker = await loaded.call('jev_findings', {}, agentAsking('shop/add-refunds', repo.root))
    expect(asker.text).toContain('Nothing has been flagged about shop/add-refunds')
    const whose = await loaded.call(
      'jev_findings',
      {},
      agentAsking('shop/tidy-receipts', repo.root),
    )
    expect(whose.text).toContain(':test_missing')
    // And whether it did what was asked is asked against the words that
    // commit was asked for in, not everybody's joined.
    const state = JSON.stringify(seen)
    expect(state).toContain('tidy the receipt printer')
    expect(state).not.toContain('add refunds to the till')
  })

  it('says nothing about whose a range is when all of it is the asker’s own', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }),
      now: Date.now,
    })
    const read = await loaded.call(
      'jev_review',
      { ref: 'HEAD~1..HEAD' },
      agentAsking('shop/add-refunds', repo.root),
    )
    expect(read.text).not.toContain('Tade-Task:')
  })
})

describe('whose a change is, is whose commits are in it', () => {
  it('files a branch nobody signed under no task, rather than every task in the checkout', async () => {
    const { repo } = sharedCheckout()
    repo.write({ 'src/refund.ts': 'export const refund = () => {}\n' })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'work nobody signed')
    const seen: unknown[] = []
    const loaded = await host({
      home: repo.home,
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
    // Read as one branch, exactly as before — but nobody's, because nothing
    // in it says whose it is.
    expect(look.found.map((one) => one.key)).toEqual([
      expect.stringMatching(/^shop:.+:test_missing$/),
    ])
    expect(readReviews(repo.home)[0]?.tasks).toEqual([])
    const state = JSON.stringify(seen)
    expect(state).not.toContain('add refunds to the till')
    expect(state).not.toContain('tidy the receipt printer')
    const asked = await loaded.call('jev_findings', {}, agentAsking('shop/add-refunds', repo.root))
    expect(asked.text).toContain('Nothing has been flagged about shop/add-refunds')
  })

  it('reads a line filed under everybody back by its trailers, and leaves the line as it was', async () => {
    const { repo, base, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    const before = repo.head()
    const receipts = commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = 1\n' })
    const refunds = commit('add-refunds', { 'src/refund.ts': 'export const refund = 2\n' })
    const reading = (unit: string, over: Partial<Review>): Review => ({
      at: new Date(NOW).toISOString(),
      project: 'shop',
      unit,
      tasks: [unit],
      base,
      head: refunds,
      version: 'jev-1.13.0',
      rubric: RUBRIC,
      files: 1,
      part: null,
      requests: 1,
      cost_usd: 0.001,
      answers: { test_missing: 0.9 },
      where: { test_missing: 'src/receipt.ts' },
      raised: ['test_missing'],
      account: {},
      verdict: {},
      ...over,
    })
    // A named range holding tidy-receipts' one commit, filed the way older
    // code filed it: under every task in the checkout.
    const range = `shop:${before.slice(0, 8)}..${receipts.slice(0, 8)}`
    recordReview(
      repo.home,
      reading(range, {
        base: before,
        head: receipts,
        tasks: ['shop/add-refunds', 'shop/tidy-receipts'],
      }),
    )
    // And add-refunds' own reading, whose range on a shared branch starts
    // where everybody branched and so holds tidy-receipts' commit too.
    recordReview(
      repo.home,
      reading('shop/add-refunds', { where: { test_missing: 'src/refund.ts' } }),
    )
    const written = readFileSync(join(repo.home, 'jev', 'reviews.jsonl'), 'utf8')
    const loaded = await host({
      home: repo.home,
      projects: { shop: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: offline,
      now: NOW + 2 * 3_600_000,
    })

    const refundsAsked = await loaded.call(
      'jev_findings',
      {},
      agentAsking('shop/add-refunds', repo.root),
    )
    expect(refundsAsked.text).toContain('shop/add-refunds:test_missing')
    expect(refundsAsked.text).not.toContain(`${range}:test_missing`)
    const receiptsAsked = await loaded.call(
      'jev_findings',
      {},
      agentAsking('shop/tidy-receipts', repo.root),
    )
    expect(receiptsAsked.text).toContain(`${range}:test_missing`)
    expect(receiptsAsked.text).not.toContain('shop/add-refunds:test_missing')
    // The orchestrator naming a task is told the same.
    const orchestrator = { caller: { kind: 'orchestrator' as const } }
    const named = await loaded.call('jev_findings', { task: 'shop/add-refunds' }, orchestrator)
    expect(named.text).not.toContain(range)
    expect(
      (await loaded.call('jev_findings', { task: 'shop/tidy-receipts' }, orchestrator)).text,
    ).toContain(range)

    // And the sweep counts the one task whose commit it is, not the checkout.
    const swept = await loaded.look('jev.verdicts', {
      project: 'shop',
      input: {},
      since: null,
      turnedOn: new Date(NOW).toISOString(),
    })
    const unowned = swept.found.find((one) => one.key.startsWith(`${range}:test_missing#unowned`))
    expect(unowned?.title).toContain('1 task(s) share it')
    // What was written is evidence, and is never rewritten.
    expect(readFileSync(join(repo.home, 'jev', 'reviews.jsonl'), 'utf8')).toBe(written)
  })
})

describe("a finding's key is one change, for ever", () => {
  it('is what a moving reference resolved to, never the reference itself', async () => {
    const { repo, commit } = sharedCheckout()
    commit('add-refunds', { 'src/refund.ts': 'export const refund = () => {}\n' })
    const head = repo.head()
    const base = repo.git('rev-parse', 'HEAD~1').trim()
    const home = repo.home
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
      home: repo.home,
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
