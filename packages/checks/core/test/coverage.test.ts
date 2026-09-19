import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { carryOver, coverageOf } from '../src/coverage.ts'
import type { Check, CheckLog, Covered } from '../src/port.ts'
import { readRuns, rollup, writeRun } from '../src/records.ts'

// The run that happened a second before the commit.
//
// Real repositories, because what is being tested is whether the bytes a run
// read are the bytes that got committed, and a mocked git would only ever
// agree with whatever we wrote here.

const CHECKS: Check[] = ['format', 'types', 'tests'].map((id) => ({
  id,
  title: id,
  run: `pnpm ${id}`,
  alone: false,
  minutes: 1,
  required: true,
}))

const ran = (check: string, commit: string, covered: Covered | null): CheckLog => ({
  id: `${commit.slice(0, 7)}:${check}:here:1`,
  check,
  commit,
  state: 'passed',
  where: { kind: 'here', runner: 'local', host: 'mbp' },
  required: true,
  startedAt: '2026-09-19T05:11:02.114Z',
  finishedAt: '2026-09-19T05:12:06.802Z',
  code: 0,
  summary: null,
  by: 'tade/checks',
  tail: '',
  covered,
})

/** A green suite at the commit checked out, over whatever the worktree holds. */
async function suiteAt(root: string, commit: string): Promise<CheckLog[]> {
  const covered = await coverageOf(root, commit)
  expect(covered).not.toBeNull()
  return CHECKS.map((check) => ran(check.id, commit, covered))
}

async function stands(root: string, runs: readonly CheckLog[], commit: string): Promise<string> {
  return rollup(CHECKS, runs, await carryOver(root, runs, commit)).state
}

describe('a run, and the commit made right after it', () => {
  it('carries over to a commit of exactly what it read', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    repo.write({ 'a.txt': 'a, edited\n', 'new.txt': 'written just now\n' })
    const before = repo.head()
    const runs = await suiteAt(repo.root, before)
    expect(await stands(repo.root, runs, before)).toBe('pass')

    repo.git('add', 'a.txt', 'new.txt')
    repo.git('commit', '-q', '-m', 'the work')
    const after = repo.head()
    expect(after).not.toBe(before)
    // Same bytes, new name for them.
    expect(await stands(repo.root, runs, after)).toBe('pass')
  })

  it('says nothing about a commit that holds something the run never read', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const runs = await suiteAt(repo.root, repo.head())

    // Somebody else's file changes between the run and the commit, and goes in.
    repo.write({ 'b.txt': 'another agent was here\n' })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'the work, and theirs')
    expect(await stands(repo.root, runs, repo.head())).toBe('unknown')
  })

  it('says nothing about a partial commit, though every byte in it was read', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    // Two dirty files at run time: mine, and one belonging to whoever else is
    // working in this checkout.
    repo.write({ 'a.txt': 'a, edited\n', 'b.txt': 'their work in progress\n' })
    const runs = await suiteAt(repo.root, repo.head())

    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'only mine')
    // The commit's tree is theirs-as-committed plus mine-as-read: a tree
    // nobody has run anything over.
    expect(await stands(repo.root, runs, repo.head())).toBe('unknown')
  })

  it('carries over though untracked files were lying about, so long as they stayed that way', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    // Tade's own files, and another agent's scratch: untracked, unignored, and
    // on disk for the run and for anything run after it.
    repo.write({ 'a.txt': 'a, edited\n', '.tade/checks.jsonl': '{}\n', 'scratch/theirs.md': 'x\n' })
    const runs = await suiteAt(repo.root, repo.head())

    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'the work')
    expect(await stands(repo.root, runs, repo.head())).toBe('pass')
  })

  it('carries over to a commit that renames nothing but itself', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    const runs = await suiteAt(repo.root, repo.head())
    repo.git('commit', '-q', '--amend', '-m', 'start, said better')
    expect(await stands(repo.root, runs, repo.head())).toBe('pass')
  })

  it('says nothing about a commit that takes back what the run read', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const runs = await suiteAt(repo.root, repo.head())

    // Edited again after the run, and that is what was committed.
    repo.write({ 'a.txt': 'a, edited twice\n' })
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'the later thought')
    expect(await stands(repo.root, runs, repo.head())).toBe('unknown')
  })

  it('says nothing for a run that never recorded what it read', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    const before = repo.head()
    const runs = CHECKS.map((check) => ran(check.id, before, null))
    repo.commit('the work', { 'a.txt': 'a, edited\n' })
    expect(await stands(repo.root, runs, before)).toBe('pass')
    expect(await stands(repo.root, runs, repo.head())).toBe('unknown')
  })

  it('keeps what a run read on disk, so the answer survives the window closing', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    for (const run of await suiteAt(repo.root, repo.head())) await writeRun(repo.root, run)

    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'the work')
    const back = await readRuns(repo.root)
    expect(back[0]?.covered?.dirty).toEqual([
      { path: 'a.txt', oid: expect.any(String), mode: '100644' },
    ])
    expect(await stands(repo.root, back, repo.head())).toBe('pass')
  })
})
