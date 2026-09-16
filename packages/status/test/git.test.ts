import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../test/fixtures/mkrepo.ts'
import {
  listWorktrees,
  parseStatusV2,
  parseWorktreeList,
  probeGit,
  resolveBaseRef,
} from '../src/git.ts'

const noPr = { pr: false } as const

describe('parsers', () => {
  it('parseWorktreeList handles NUL records', () => {
    const out = parseWorktreeList(
      'worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w x\0HEAD def\0detached\0prunable gitdir file points to non-existent location\0\0',
    )
    expect(out).toEqual([
      { path: '/r', head: 'abc', branch: 'main', bare: false, prunable: false },
      { path: '/w x', head: 'def', branch: null, bare: false, prunable: true },
    ])
  })

  it('parseStatusV2 consumes the original path of a rename', () => {
    const s = parseStatusV2(
      '# branch.oid abc\0# branch.head wilco/x\0' +
        '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts\0old name.ts\0' +
        '1 .M N... 100644 100644 100644 aaa bbb src/a.ts\0' +
        '? new\nline.txt\0',
    )
    expect(s.paths).toEqual(['new name.ts', 'src/a.ts', 'new\nline.txt'])
    expect(s.head).toBe('wilco/x')
    expect(s.ahead).toBeNull()
  })
})

describe('probeGit on real repos', () => {
  it('clean worktree', async () => {
    const r = mkrepo()
    const wt = r.addTask('clean', { project: 'p' })
    const { snapshot, warnings } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(warnings).toEqual([])
    expect(snapshot).toMatchObject({
      branch: 'wilco/clean',
      dirty: [],
      ahead: 0,
      behind: 0,
      mergedIntoBase: false,
      upstreamGone: false,
    })
  })

  it('dirty worktree: staged, unstaged, untracked, awkward filenames; .wilco excluded', async () => {
    const r = mkrepo()
    const wt = r.addTask('dirty', { project: 'p' })
    r.write({ 'README.md': 'changed\n', 'has space.txt': 'x', 'new\nline.txt': 'y' }, wt)
    r.write({ 'staged.ts': 'z' }, wt)
    runGit(wt, 'add', 'staged.ts')
    const { snapshot } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(snapshot?.dirty).toEqual(['README.md', 'has space.txt', 'new\nline.txt', 'staged.ts'])
  })

  it('worktree with 3 commits ahead, and main moved on', async () => {
    const r = mkrepo()
    const wt = r.addTask('ahead', { project: 'p' })
    for (const n of [1, 2, 3]) r.commit(`c${n}`, { [`c${n}.txt`]: `${n}` }, wt)
    r.commit('on main', { 'm.txt': 'm' })
    const { snapshot } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(snapshot).toMatchObject({ ahead: 3, behind: 1, headSubject: 'c3', dirty: [] })
    expect(snapshot?.headTime).toBeGreaterThan(0)
  })

  it('detached head', async () => {
    const r = mkrepo()
    const wt = r.addTask('det', { project: 'p' })
    r.commit('one', undefined, wt)
    runGit(wt, 'checkout', '-q', '--detach', 'HEAD')
    const { snapshot } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(snapshot?.branch).toBeNull()
    expect(snapshot?.ahead).toBe(1)
  })

  it('branch deleted upstream', async () => {
    const r = mkrepo({ remote: true })
    const wt = r.addTask('gone', { project: 'p' })
    r.commit('work', undefined, wt)
    runGit(wt, 'push', '-q', '-u', 'origin', 'wilco/gone')
    runGit(wt, 'push', '-q', 'origin', '--delete', 'wilco/gone')
    runGit(wt, 'fetch', '-q', '--prune')
    const { snapshot } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(snapshot?.upstreamGone).toBe(true)
  })

  it('detects a fast-forward merge only once the task has moved past its base', async () => {
    const r = mkrepo()
    const wt = r.addTask('ff', { project: 'p' })
    const taskBase = r.head()
    let res = await probeGit(wt, { baseRef: 'main', taskBase, ...noPr })
    expect(res.snapshot?.mergedIntoBase).toBe(false)

    r.commit('feature', undefined, wt)
    r.git('merge', '-q', '--ff-only', 'wilco/ff')
    res = await probeGit(wt, { baseRef: 'main', taskBase, ...noPr })
    expect(res.snapshot?.mergedIntoBase).toBe(true)
    expect(res.snapshot?.ahead).toBe(0)
  })

  it('detects a squash merge, where the work is in the base but the commits are not', async () => {
    const r = mkrepo()
    const wt = r.addTask('squash', { project: 'p' })
    const taskBase = r.head()
    r.commit('first half', { 'feature.ts': 'half\n' }, wt)
    r.commit('second half', { 'feature.ts': 'whole\n' }, wt)
    let res = await probeGit(wt, { baseRef: 'main', taskBase, ...noPr })
    expect(res.snapshot?.mergedIntoBase).toBe(false)

    // What a "Squash and merge" leaves behind: the same files, none of the commits.
    r.git('merge', '-q', '--squash', 'wilco/squash')
    r.git('commit', '-q', '-m', 'the feature (#12)')
    res = await probeGit(wt, { baseRef: 'main', taskBase, ...noPr })
    expect(res.snapshot?.mergedIntoBase).toBe(true)
    // Its commits are still its own: it is ahead and behind, and merged all the same.
    expect(res.snapshot?.ahead).toBe(2)
    expect(res.snapshot?.behind).toBe(1)

    // More work after the merge is work the base does not have.
    r.commit('one more thing', { 'feature.ts': 'more\n' }, wt)
    res = await probeGit(wt, { baseRef: 'main', taskBase, ...noPr })
    expect(res.snapshot?.mergedIntoBase).toBe(false)
  })

  it('a missing worktree degrades to null with a warning', async () => {
    const r = mkrepo()
    const wt = r.addTask('gone', { project: 'p' })
    rmSync(wt, { recursive: true, force: true })
    const { snapshot, warnings } = await probeGit(wt, { baseRef: 'main', ...noPr })
    expect(snapshot).toBeNull()
    expect(warnings[0]).toMatch(/git status failed/)
    const list = await listWorktrees(r.root)
    expect(Array.isArray(list) && list.find((w) => w.path === wt)?.prunable).toBe(true)
  })

  it('resolveBaseRef prefers local main, falls back to master, then null', async () => {
    const r = mkrepo()
    expect(await resolveBaseRef(r.root)).toBe('main')
    r.git('branch', '-m', 'main', 'master')
    expect(await resolveBaseRef(r.root)).toBe('master')
    r.git('checkout', '-q', '--orphan', 'other')
    r.git('branch', '-D', 'master')
    expect(await resolveBaseRef(r.root)).toBeNull()
  })

  it('listWorktrees on a corrupt .git reports an error rather than throwing', async () => {
    const r = mkrepo()
    rmSync(join(r.root, '.git', 'HEAD'))
    const list = await listWorktrees(r.root)
    expect(list).toHaveProperty('error')
  })
})
