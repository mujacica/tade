import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CheckLog, coverageOf, writeRun } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'
import { readRecord, readTests, testsPath, verifiedAt, writeTests } from '../src/tests.ts'

// A test result is about one commit. Everything here is about refusing to let
// an old green run vouch for code it never saw.

const record = (over: Partial<Parameters<typeof writeTests>[1]> = {}) => ({
  status: 'pass' as const,
  commit: 'abc123',
  command: 'pnpm test',
  at: '2026-09-13T09:00:00.000Z',
  output: '',
  ...over,
})

describe('readTests', () => {
  it('knows nothing when nothing has been run', async () => {
    expect(await readTests(tmp('tade-tests-'), 'abc123')).toBe('unknown')
  })

  it('reports the result for the commit it ran against', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record())
    expect(await readTests(worktree, 'abc123')).toBe('pass')

    await writeTests(worktree, record({ status: 'fail' }))
    expect(await readTests(worktree, 'abc123')).toBe('fail')
  })

  it('refuses to vouch for a commit it never saw', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record({ commit: 'old' }))
    // Green three commits ago says nothing about this one, and a stale pass is
    // worse than no result at all: it would let `review` mean verified.
    expect(await readTests(worktree, 'abc123')).toBe('unknown')
  })

  it('knows nothing when there is no commit to be about', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record())
    expect(await readTests(worktree, null)).toBe('unknown')
  })
})

describe('readRecord', () => {
  it('round-trips what was written', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record({ output: 'boom' }))
    expect(await readRecord(worktree)).toMatchObject({ status: 'pass', output: 'boom' })
  })

  it('returns null on a shape it does not know, rather than throwing', async () => {
    const worktree = tmp('tade-tests-')
    for (const bad of ['not json', '{}', '{"status":"maybe","commit":"x"}', '[]', 'null']) {
      writeFileSync(testsPath(worktree), bad)
      expect(await readRecord(worktree)).toBeNull()
      expect(await readTests(worktree, 'abc123')).toBe('unknown')
    }
  })

  it('fills in the parts it can live without', async () => {
    const worktree = tmp('tade-tests-')
    writeFileSync(testsPath(worktree), '{"status":"pass","commit":"abc123"}')
    expect(await readRecord(worktree)).toEqual({
      status: 'pass',
      commit: 'abc123',
      command: '',
      at: '',
      output: '',
    })
  })
})

describe('verifiedAt', () => {
  const workflow = ciWorkflow([
    { id: 'format', run: 'pnpm exec biome ci .' },
    { id: 'tests', run: 'pnpm exec vitest run' },
  ])

  const run = (check: string, state: string, commit = 'abc123') =>
    JSON.stringify({
      id: `${commit}:${check}:here:1`,
      check,
      commit,
      state,
      where: { kind: 'here', runner: 'local', host: 'mbp' },
      required: true,
      startedAt: '2026-09-19T05:00:00.000Z',
      finishedAt: '2026-09-19T05:01:00.000Z',
      code: state === 'passed' ? 0 : 1,
      summary: null,
      by: 'you',
      tail: '',
    })

  const project = (root: string) => ({ name: 'demo', root, records: root })

  it('is the rollup of the required checks, not of one command', async () => {
    const worktree = tmp('tade-verified-')
    mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(worktree, CI_WORKFLOW), workflow)
    const records = join(worktree, 'checks.jsonl')
    writeFileSync(records, `${run('format', 'passed')}\n`)
    // One of two required checks has run: unverified, never green.
    expect(await verifiedAt(worktree, 'abc123', project(worktree))).toBe('unknown')
    writeFileSync(records, `${run('format', 'passed')}\n${run('tests', 'passed')}\n`)
    expect(await verifiedAt(worktree, 'abc123', project(worktree))).toBe('pass')
    writeFileSync(records, `${run('format', 'passed')}\n${run('tests', 'failed')}\n`)
    expect(await verifiedAt(worktree, 'abc123', project(worktree))).toBe('fail')
  })

  it('still reads what `tade check` recorded for a project with nothing written down', async () => {
    const worktree = tmp('tade-verified-')
    await writeTests(worktree, record())
    expect(await verifiedAt(worktree, 'abc123', project(worktree))).toBe('pass')
  })

  // The whole point of recording what a run read: an agent checks its work and
  // then commits it, and the commit it just made is the work that was checked.
  it('is green at the commit an agent made of exactly what the run read', async () => {
    const repo = mkrepo()
    repo.commit('start', { [CI_WORKFLOW]: workflow, 'a.txt': 'a\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const before = repo.head()
    const covered = await coverageOf(repo.root, before)
    for (const check of ['format', 'tests']) {
      await writeRun(repo.root, {
        ...(JSON.parse(run(check, 'passed', before)) as CheckLog),
        covered,
      })
    }
    expect(await verifiedAt(repo.root, before, project(repo.root))).toBe('pass')

    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'the work')
    expect(await verifiedAt(repo.root, repo.head(), project(repo.root))).toBe('pass')
  })

  it('is unknown at a commit that holds a byte nobody ran anything over', async () => {
    const repo = mkrepo()
    repo.commit('start', { [CI_WORKFLOW]: workflow, 'a.txt': 'a\n', 'b.txt': 'b\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const before = repo.head()
    const covered = await coverageOf(repo.root, before)
    for (const check of ['format', 'tests']) {
      await writeRun(repo.root, {
        ...(JSON.parse(run(check, 'passed', before)) as CheckLog),
        covered,
      })
    }
    // Another agent's file goes in with it.
    repo.write({ 'b.txt': 'theirs\n' })
    repo.git('add', 'a.txt', 'b.txt')
    repo.git('commit', '-q', '-m', 'mine and theirs')
    expect(await verifiedAt(repo.root, repo.head(), project(repo.root))).toBe('unknown')
  })
})
