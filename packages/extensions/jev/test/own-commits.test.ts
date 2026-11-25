import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { ownSaid } from '../src/changes.ts'
import { readReviews } from '../src/reviews.ts'
import { host, typesafe } from './harness.ts'

// `jev_review` with `task:` in a checkout two agents share reads that task's
// own commits, by their `Tade-Task:` trailer, and says so — never the range
// from where the oldest task branched, which for a plan made on the repository's
// first day is the whole history. slopmmelier/finish-kit's no-findings answer
// was printed and recorded as `7cc1deb..d412681`: twenty-six commits of
// nineteen tasks, of which one was its own.

const asked = { caller: { kind: 'orchestrator' } as const }

/** Two tasks made with the plan at the repository's first commit, sharing its checkout. */
function planMadeOnDayOne(bases: { refunds?: string; receipts?: string } = {}) {
  const repo = mkrepo()
  repo.commit('start', { 'README.md': 'shop\n' })
  const first = repo.head()
  for (const [name, intent, base] of [
    ['add-refunds', 'add refunds to the till', bases.refunds ?? first],
    ['tidy-receipts', 'tidy the receipt printer', bases.receipts ?? first],
  ] as const) {
    mkdirSync(join(repo.home, 'projects', 'shop', 'tasks', name), { recursive: true })
    writeFileSync(
      join(repo.home, 'projects', 'shop', 'tasks', name, 'task.yaml'),
      [
        `id: shop/${name}`,
        'project: shop',
        `intent_spoken: ${intent}`,
        'created: 2026-09-11T09:14:22Z',
        ...(base ? [`base: ${base}`] : []),
        'workspace: checkout',
        '',
      ].join('\n'),
    )
  }
  const commit = (task: string | null, files: Record<string, string>) => {
    repo.write(files)
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', task ? `work\n\nTade-Task: shop/${task}` : 'work by hand')
    return repo.head()
  }
  commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = 1\n' })
  commit(null, { 'src/by-hand.ts': 'export const byHand = 1\n' })
  const refunds = commit('add-refunds', { 'src/refund.ts': 'export const refund = 1\n' })
  commit('tidy-receipts', { 'src/receipt.ts': 'export const receipt = 2\n' })
  return { repo, first, refunds }
}

async function review(repo: ReturnType<typeof mkrepo>, task: string) {
  const seen: unknown[] = []
  const loaded = await host({
    home: repo.home,
    projects: { shop: { root: repo.root } },
    env: { TYPESAFE_API_KEY: 'k' },
    fetch: typesafe({}, seen),
    now: Date.now,
  })
  const read = await loaded.call('jev_review', { project: 'shop', task }, asked)
  return { read, sent: JSON.stringify(seen) }
}

describe('jev_review of one task in a checkout two tasks commit to', () => {
  it('reads only that task’s own commits, and names what else is in the range', async () => {
    const { repo, first, refunds } = planMadeOnDayOne()
    const { read, sent } = await review(repo, 'shop/add-refunds')

    expect(sent).toContain('src/refund.ts')
    expect(sent).not.toContain('src/receipt.ts')
    expect(sent).not.toContain('src/by-hand.ts')

    expect(read.text).toContain(
      `Read its own 1 commit by its \`Tade-Task:\` trailer (${refunds.slice(0, 8)})`,
    )
    expect(read.text).toContain('2 commits of 1 other task')
    expect(read.text).toContain('1 commit nobody signed, which may be its own and was not read')
    // Never the bare range from the first commit, which reads as all of it.
    expect(read.text).not.toContain(`${first.slice(0, 8)}…`)
    expect(read.text.indexOf('Tade-Task:')).toBeLessThan(read.text.indexOf('| question |'))

    const [line] = readReviews(repo.home)
    expect(line?.tasks).toEqual(['shop/add-refunds'])
    expect(line?.commits).toEqual([refunds])
  })

  it('still reads one task’s own commits when another task’s recorded base is gone', async () => {
    // A base git no longer has failed the octopus, and the whole checkout was
    // then read as one branch — under the name of whichever task was asked about.
    const { repo, refunds } = planMadeOnDayOne({ receipts: 'f'.repeat(40) })
    const { read, sent } = await review(repo, 'shop/add-refunds')
    expect(sent).toContain('src/refund.ts')
    expect(sent).not.toContain('src/receipt.ts')
    expect(read.text).toContain(`(${refunds.slice(0, 8)})`)
    expect(readReviews(repo.home)[0]?.commits).toEqual([refunds])
  })

  it.each([
    ['gone', { refunds: 'f'.repeat(40), receipts: 'e'.repeat(40) }],
    ['missing', { refunds: '', receipts: '' }],
  ])(
    'still reads one task’s own commits on the base branch when every recorded base is %s',
    async (_, bases) => {
      // With no remote, the base branch is the one checked out, so where the
      // branch left it is HEAD itself: there was no unit at all, and a task that
      // had committed was told it had nothing committed.
      const { repo, refunds } = planMadeOnDayOne(bases)
      const { read, sent } = await review(repo, 'shop/add-refunds')
      expect(sent).toContain('src/refund.ts')
      expect(sent).not.toContain('src/receipt.ts')
      expect(sent).not.toContain('src/by-hand.ts')
      expect(read.text).toContain(`(${refunds.slice(0, 8)})`)
      expect(readReviews(repo.home)[0]?.commits).toEqual([refunds])
    },
  )

  it('reads the other task’s two commits as its own change, and not the one between', async () => {
    const { repo } = planMadeOnDayOne()
    const { read, sent } = await review(repo, 'shop/tidy-receipts')
    expect(sent).toContain('src/receipt.ts')
    expect(sent).not.toContain('src/refund.ts')
    expect(sent).not.toContain('src/by-hand.ts')
    expect(read.text).toContain('Read its own 2 commits')
    expect(read.text).toContain('1 commit of 1 other task')
    expect(readReviews(repo.home)[0]?.commits).toHaveLength(2)
  })
})

describe('what a reading of one agent’s own commits says', () => {
  const unit = { base: 'a'.repeat(40), head: 'b'.repeat(40), commits: ['b'.repeat(40)] }

  it('says nothing where the unit is a whole range, which its header says itself', () => {
    expect(ownSaid({ ...unit, commits: [] })).toBeNull()
  })

  it('names own commits past the ones read rather than dropping them', () => {
    const said = ownSaid({
      ...unit,
      beside: { head: 'c'.repeat(40), others: 0, tasks: 0, unsigned: 0, older: 3 },
    })
    expect(said).toContain('Its 3 oldest commits were not read: only the newest 50 are.')
    expect(said).not.toContain('none of the rest')
  })

  it('says the range it counted to the branch’s head, not to this task’s last commit', () => {
    const said = ownSaid({
      ...unit,
      beside: { head: 'c'.repeat(40), others: 4, tasks: 2, unsigned: 0, older: 0 },
    })
    expect(said).toContain('none of the rest of aaaaaaaa..cccccccc: 4 commits of 2 other tasks.')
  })
})
