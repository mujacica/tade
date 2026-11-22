import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorDir, mirrorRef, syncVerdict } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { fetchMirror } from '../src/mirror.ts'
import { lookSync, moveSync } from '../src/sync.ts'

// Keeping a branch in step, as git sees it (`sync.ts`): real repositories —
// a checkout with an origin, a second clone of it standing in for another
// machine, and this home's mirror — never a mocked git.

/** A checkout with an origin, and another clone of it that has pushed `files` there. */
function pushedElsewhere(files: Record<string, string>) {
  const here = mkrepo({ remote: true })
  const there = join(tmp('tade-there-'), 'repo')
  runGit(here.root, 'clone', '-q', here.remote as string, there)
  for (const [path, text] of Object.entries(files)) writeFileSync(join(there, path), text)
  runGit(there, 'add', '-A')
  runGit(there, 'commit', '-q', '-m', 'work elsewhere')
  runGit(there, 'push', '-q', 'origin', 'main')
  return { here, there, theirs: runGit(there, 'rev-parse', 'HEAD').trim() }
}

const look = (root: string, home: string, over: Partial<Parameters<typeof lookSync>[0]> = {}) =>
  lookSync({ project: 'app', root, mirror: mirrorDir(home, 'app'), fetchOrigin: true, ...over })

describe('a look at a checkout', () => {
  it('fast-forwards a clean checkout to origin, and the files land', async () => {
    const { here, theirs } = pushedElsewhere({
      'README.md': 'changed elsewhere\n',
      'new.ts': 'x\n',
    })
    const was = here.head()
    const { facts, troubles } = await look(here.root, here.home)
    expect(troubles).toEqual([])
    expect(facts).toMatchObject({
      branch: 'main',
      at: { kind: 'checkout' },
      head: was,
      target: { kind: 'one', sha: theirs, from: ['origin'] },
      forward: true,
      behind: 1,
    })
    expect(facts.incoming).toEqual([
      { path: 'README.md', added: false },
      { path: 'new.ts', added: true },
    ])
    const verdict = syncVerdict(facts, 'ff')
    expect(verdict).toMatchObject({ kind: 'move', byRef: false })
    expect(await moveSync(here.root, facts, theirs)).toBeNull()
    expect(here.head()).toBe(theirs)
    expect(readFileSync(join(here.root, 'README.md'), 'utf8')).toBe('changed elsewhere\n')
  })

  it('refuses, naming the path, for a dirty file the incoming commit changes', async () => {
    const { here } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    writeFileSync(join(here.root, 'README.md'), 'somebody is editing this\n')
    const { facts } = await look(here.root, here.home)
    const verdict = syncVerdict(facts, 'ff')
    expect(verdict).toMatchObject({ kind: 'refused', paths: ['README.md'] })
    // Nothing moved, and their edit is as they left it.
    expect(readFileSync(join(here.root, 'README.md'), 'utf8')).toBe('somebody is editing this\n')
  })

  it('refuses for an untracked file where the incoming commit adds one, and for an ignored one', async () => {
    const { here } = pushedElsewhere({ 'new.ts': 'theirs\n', 'local.env': 'theirs\n' })
    writeFileSync(join(here.root, 'new.ts'), 'mine, never added\n')
    // Ignored by this checkout's own exclude, which `git merge` would write over without a word.
    writeFileSync(join(here.root, '.git', 'info', 'exclude'), 'local.env\n')
    writeFileSync(join(here.root, 'local.env'), 'TOKEN=mine\n')
    const { facts } = await look(here.root, here.home)
    expect(facts.inTheWay).toEqual(['local.env', 'new.ts'])
    const verdict = syncVerdict(facts, 'ff')
    expect(verdict).toMatchObject({ kind: 'refused', paths: ['local.env', 'new.ts'] })
    expect(readFileSync(join(here.root, 'local.env'), 'utf8')).toBe('TOKEN=mine\n')
  })

  it('waits while something is staged, even a file the move does not touch', async () => {
    const { here } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    writeFileSync(join(here.root, 'other.ts'), 'mid-commit\n')
    here.git('add', 'other.ts')
    const { facts } = await look(here.root, here.home)
    expect(facts.staged).toEqual(['other.ts'])
    expect(syncVerdict(facts, 'ff').kind).toBe('wait')
  })

  it('waits while somebody holds the index lock', async () => {
    const { here } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    writeFileSync(join(here.root, '.git', 'index.lock'), '')
    const { facts } = await look(here.root, here.home)
    expect(facts.committing).toBe(true)
    expect(syncVerdict(facts, 'ff').kind).toBe('wait')
  })

  it('finds a diverged branch, and counts each side', async () => {
    const { here, theirs } = pushedElsewhere({ 'theirs.ts': 'theirs\n' })
    const mine = here.commit('work here', { 'mine.ts': 'mine\n' })
    const { facts } = await look(here.root, here.home)
    expect(facts).toMatchObject({ head: mine, forward: false, ahead: 1, behind: 1 })
    expect(syncVerdict(facts, 'ff')).toMatchObject({ kind: 'diverged', target: theirs })
  })

  it('reads another machine’s branch out of the mirror, and brings its commits into the checkout', async () => {
    const here = mkrepo()
    const there = join(tmp('tade-there-'), 'repo')
    runGit(here.root, 'clone', '-q', here.root, there)
    writeFileSync(join(there, 'vps.ts'), 'from the vps\n')
    runGit(there, 'add', '-A')
    runGit(there, 'commit', '-q', '-m', 'on the vps')
    const theirs = runGit(there, 'rev-parse', 'HEAD').trim()
    const mirror = mirrorDir(here.home, 'app')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    expect(runGit(mirror, 'rev-parse', mirrorRef('vps', 'main')).trim()).toBe(theirs)
    // The checkout has not got it: only the mirror does.
    expect(() => runGit(here.root, 'cat-file', '-e', theirs)).toThrow()
    const refsBefore = runGit(here.root, 'for-each-ref')

    const { facts, troubles } = await look(here.root, here.home)
    expect(troubles).toEqual([])
    expect(facts.target).toEqual({ kind: 'one', sha: theirs, from: ['vps'] })
    // Its objects, and no ref: the checkout's refs are as they were.
    expect(runGit(here.root, 'for-each-ref')).toBe(refsBefore)
    expect(await moveSync(here.root, facts, theirs)).toBeNull()
    expect(here.head()).toBe(theirs)
    expect(existsSync(join(here.root, 'vps.ts'))).toBe(true)
  })

  it('looks only at the source it is asked to', async () => {
    const { here } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    const { facts } = await look(here.root, here.home, { only: ['vps'] })
    expect(facts.target.kind).toBe('none')
  })

  it('moves only the ref of a branch nothing has checked out, and nothing in the checkout', async () => {
    const { here, theirs } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    here.git('checkout', '-q', '-b', 'side')
    const side = here.head()
    writeFileSync(join(here.root, 'README.md'), 'my edit on side\n')
    const { facts } = await look(here.root, here.home)
    expect(facts.branch).toBe('side')
    // On a branch origin has not got, the checkout's own branch has nothing to follow…
    expect(facts.target.kind).toBe('none')
    // …and its base, checked out nowhere, moves by its ref alone.
    here.git('checkout', '-q', '--detach')
    const based = await look(here.root, here.home)
    expect(based.facts).toMatchObject({ branch: 'main', at: { kind: 'nowhere' } })
    expect(syncVerdict(based.facts, 'ff')).toMatchObject({ kind: 'move', byRef: true })
    expect(await moveSync(here.root, based.facts, theirs)).toBeNull()
    expect(here.git('rev-parse', 'refs/heads/main').trim()).toBe(theirs)
    expect(here.head()).toBe(side)
    expect(readFileSync(join(here.root, 'README.md'), 'utf8')).toBe('my edit on side\n')
  })

  it('never moves a ref that moved after the look', async () => {
    const { here, theirs } = pushedElsewhere({ 'README.md': 'changed elsewhere\n' })
    here.git('checkout', '-q', '--detach')
    const { facts } = await look(here.root, here.home)
    expect(facts.at.kind).toBe('nowhere')
    here.git('update-ref', 'refs/heads/main', here.commit('meanwhile', { 'm.ts': 'm\n' }))
    const moved = here.git('rev-parse', 'refs/heads/main').trim()
    expect(await moveSync(here.root, facts, theirs)).not.toBeNull()
    expect(here.git('rev-parse', 'refs/heads/main').trim()).toBe(moved)
  })
})
