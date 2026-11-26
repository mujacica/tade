import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { headIn, runningCheckout } from '../src/programs.ts'

// Which commit a checkout of Tade is on, read off git's own files rather than
// asked of git (`headIn`), because what another machine's reload moves this
// one by is read in a window that waits on no child. Every shape git leaves
// HEAD in is a real repository here: a branch, a branch whose ref is packed,
// a detached HEAD, a worktree, and no repository at all.

describe('the commit a checkout is on', () => {
  it('reads a branch, the same commit git names', () => {
    const repo = mkrepo()
    const sha = repo.commit('second', { 'a.txt': 'a\n' })
    expect(headIn(repo.root)).toBe(runGit(repo.root, 'rev-parse', 'HEAD').trim())
    expect(headIn(repo.root)).toMatch(/^[0-9a-f]{40}$/)
    expect(runGit(repo.root, 'rev-parse', 'HEAD').trim().startsWith(sha.slice(0, 7))).toBe(true)
  })

  it('reads a branch whose ref git has packed away', () => {
    const repo = mkrepo()
    repo.commit('second', { 'a.txt': 'a\n' })
    runGit(repo.root, 'pack-refs', '--all')
    expect(headIn(repo.root)).toBe(runGit(repo.root, 'rev-parse', 'HEAD').trim())
  })

  it('reads a detached HEAD', () => {
    const repo = mkrepo()
    const first = runGit(repo.root, 'rev-parse', 'HEAD').trim()
    repo.commit('second', { 'a.txt': 'a\n' })
    runGit(repo.root, 'checkout', '-q', '--detach', first)
    expect(headIn(repo.root)).toBe(first)
  })

  it('reads a worktree, whose branch is in the repository it belongs to', () => {
    const repo = mkrepo()
    const at = join(tmp('tade-worktree-'), 'there')
    runGit(repo.root, 'worktree', 'add', '-q', '-b', 'other', at)
    runGit(repo.root, 'pack-refs', '--all')
    expect(headIn(at)).toBe(runGit(at, 'rev-parse', 'HEAD').trim())
  })

  it('is null where there is no repository, or HEAD names nothing yet', () => {
    const nothing = tmp('tade-no-repo-')
    expect(headIn(nothing)).toBeNull()
    const empty = join(tmp('tade-empty-repo-'), 'repo')
    mkdirSync(empty)
    runGit(empty, 'init', '-q', '-b', 'main')
    expect(headIn(empty)).toBeNull()
  })

  it('is what this Tade runs from: this repository is a checkout, read once', () => {
    const running = runningCheckout()
    expect(running?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(runningCheckout()).toBe(running)
  })
})
