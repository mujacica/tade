import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyRepo, mkrepo, runGit } from './fixtures/mkrepo.ts'

// A copied fixture is the repository `mkrepo` would have built at the copy's
// path, and nothing of the template's: the window's tests start every test
// from one, so a copy that still pointed at its template would have every test
// in a file changing the same worktrees.

const template = () => {
  const repo = mkrepo()
  repo.commit('first')
  const worktree = repo.addTask('refunds', { project: 'app', intent: 'refunds' })
  return { repo, worktree }
}

describe('a copied fixture repository', () => {
  it('is its own: worktrees, branches and task files at its own path', () => {
    const { repo: from } = template()
    const repo = copyRepo(from)
    expect(dirname(repo.root)).not.toBe(dirname(from.root))
    const worktree = join(dirname(repo.root), 'worktrees', 'app-refunds')
    // Git's own answer about where each worktree is, from the repository and from the worktree.
    const listed = runGit(repo.root, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    expect(listed).toEqual([repo.root, worktree])
    expect(runGit(worktree, 'rev-parse', '--show-toplevel').trim()).toBe(worktree)
    expect(runGit(worktree, 'rev-parse', '--git-common-dir').trim()).toBe(join(repo.root, '.git'))
    expect(runGit(worktree, 'branch', '--show-current').trim()).toBe('tade/refunds')
    expect(repo.head()).toBe(from.head())
    expect(repo.home).toBe(join(dirname(repo.root), 'tade-home'))
    expect(
      readFileSync(join(repo.home, 'projects', 'app', 'tasks', 'refunds', 'task.yaml'), 'utf8'),
    ).toContain(`base: ${from.head()}`)
  })

  it('changes nothing of the template, nor of another copy', () => {
    const { repo: from, worktree: theirs } = template()
    const one = copyRepo(from)
    const two = copyRepo(from)
    const mine = join(dirname(one.root), 'worktrees', 'app-refunds')
    one.commit('refunds charge once', { 'refunds.ts': 'once' }, mine)
    one.addTask('search', { project: 'app', intent: 'search' })
    expect(one.head(mine)).not.toBe(from.head(theirs))
    expect(two.head(join(dirname(two.root), 'worktrees', 'app-refunds'))).toBe(from.head(theirs))
    expect(runGit(from.root, 'branch', '--list', 'tade/search').trim()).toBe('')
    expect(runGit(two.root, 'branch', '--list', 'tade/search').trim()).toBe('')
    expect(existsSync(join(two.home, 'projects', 'app', 'tasks', 'search'))).toBe(false)
    expect(runGit(theirs, 'status', '--porcelain=v2').trim()).toBe('')
  })

  it('refuses a template whose home or remote every copy would share', () => {
    expect(() => copyRepo(mkrepo({ home: join(dirname(mkrepo().root), 'shared') }))).toThrow(
      /home is its own/,
    )
    expect(() => copyRepo(mkrepo({ remote: true }))).toThrow(/no remote/)
  })
})
