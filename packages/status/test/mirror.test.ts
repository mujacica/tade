import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Elsewhere, liveThere, mirrorDir, mirrorRef } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { forecastConflicts } from '../src/conflicts.ts'
import { repositoryNamed } from '../src/forges.ts'
import { fetchMirror, mirrorChanged, mirrorDiff, mirrorHeads, readyMirror } from '../src/mirror.ts'

// The mirror (`mirror.ts`): another machine's branches of one of this
// machine's projects, in this home, borrowing the checkout's objects — and the
// forecast merging this machine's live branches with them there.
//
// The other machine is a clone of the checkout at a path, which is what the
// scripted link hands git for a far end (`repository`): real repositories,
// real fetches, and the far side's history built on the same commits this
// side has, as two checkouts of one repository are.

/** A checkout, and another machine's clone of it with work of its own on a branch. */
function twoMachines() {
  const here = mkrepo()
  here.commit('shared', { 'x.ts': 'one\ntwo\nthree\n', 'y.ts': 'y\n' })
  const there = join(tmp('tade-there-'), 'repo')
  runGit(here.root, 'clone', '-q', here.root, there)
  return { here, there }
}

/** A commit on a branch of the other machine's clone. */
function workThere(there: string, branch: string, files: Record<string, string>): string {
  const at = runGit(there, 'branch', '--list', branch).trim() === '' ? 'main' : branch
  runGit(there, 'checkout', '-q', '-B', branch, at)
  for (const [path, text] of Object.entries(files)) writeFileSync(join(there, path), text)
  runGit(there, 'add', '-A')
  runGit(there, 'commit', '-q', '-m', `work on ${branch}`)
  return runGit(there, 'rev-parse', 'HEAD').trim()
}

/** Everything git keeps about a checkout that a fetch could change: refs, config, objects. */
function untouched(root: string): string {
  const git = join(root, '.git')
  const objects: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name)
      if (statSync(at).isDirectory()) walk(at)
      else objects.push(at.slice(git.length))
    }
  }
  walk(join(git, 'objects'))
  return JSON.stringify({
    refs: runGit(root, 'for-each-ref', '--format=%(objectname) %(refname)'),
    config: readFileSync(join(git, 'config'), 'utf8'),
    objects: objects.sort(),
    fetchHead: existsSync(join(git, 'FETCH_HEAD')),
    head: readFileSync(join(git, 'HEAD'), 'utf8'),
  })
}

describe('the mirror', () => {
  it('holds another machine’s branches under its name, borrowing the checkout’s objects, and writes nothing into the checkout', async () => {
    const { here, there } = twoMachines()
    const head = workThere(there, 'tade/fix', { 'z.ts': 'z\n' })
    const mirror = mirrorDir(here.home, 'app')
    const before = untouched(here.root)

    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()

    const heads = await mirrorHeads(mirror, 'vps')
    expect(heads?.get(mirrorRef('vps', 'tade/fix'))).toBe(head)
    expect(heads?.get(mirrorRef('vps', 'main'))).toBe(here.head())
    // In the home, and it leans on the checkout for everything both have.
    expect(mirror.startsWith(here.home)).toBe(true)
    expect(readFileSync(join(mirror, 'objects', 'info', 'alternates'), 'utf8')).toBe(
      `${join(here.root, '.git', 'objects')}\n`,
    )
    expect(untouched(here.root)).toBe(before)
  })

  it('reads what a branch there changed since it left its base, and one file’s diff, in the mirror', async () => {
    const { here, there } = twoMachines()
    const head = workThere(there, 'tade/fix', { 'z.ts': 'z\n', 'x.ts': 'ONE\ntwo\nthree\n' })
    // Work that landed on its base there since is not the branch's.
    runGit(there, 'checkout', '-q', 'main')
    writeFileSync(join(there, 'later.ts'), 'later\n')
    runGit(there, 'add', '-A')
    runGit(there, 'commit', '-q', '-m', 'landed since')
    const mirror = mirrorDir(here.home, 'app')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    const base = mirrorRef('vps', 'main')
    expect(await mirrorChanged(mirror, base, head)).toEqual(['x.ts', 'z.ts'])
    const diff = await mirrorDiff(mirror, base, head, 'x.ts')
    expect(diff).toContain('-one')
    expect(diff).toContain('+ONE')
    // A base the mirror has not got is a look that could not be made, never nothing changed.
    expect(await mirrorChanged(mirror, mirrorRef('vps', 'nowhere'), head)).toBeNull()
  })

  it('keeps each machine’s branches apart, and lets go of one gone there', async () => {
    const { here, there } = twoMachines()
    workThere(there, 'tade/fix', { 'z.ts': 'z\n' })
    const lab = join(tmp('tade-lab-'), 'repo')
    runGit(here.root, 'clone', '-q', here.root, lab)
    const labs = workThere(lab, 'tade/fix', { 'w.ts': 'w\n' })
    const mirror = mirrorDir(here.home, 'app')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    expect(await fetchMirror(mirror, here.root, 'lab', { url: lab, env: {} })).toBeNull()
    expect((await mirrorHeads(mirror, 'lab'))?.get(mirrorRef('lab', 'tade/fix'))).toBe(labs)
    expect((await mirrorHeads(mirror, 'vps'))?.get(mirrorRef('vps', 'tade/fix'))).not.toBe(labs)

    runGit(there, 'checkout', '-q', 'main')
    runGit(there, 'branch', '-q', '-D', 'tade/fix')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    expect((await mirrorHeads(mirror, 'vps'))?.has(mirrorRef('vps', 'tade/fix'))).toBe(false)
    expect((await mirrorHeads(mirror, 'lab'))?.get(mirrorRef('lab', 'tade/fix'))).toBe(labs)
  })

  it('is made again from nothing when the checkout gave away an object it leaned on', async () => {
    const { here, there } = twoMachines()
    // Work both machines had once: a branch here, fetched there, built on there.
    const gone = here.addTask('gone', { project: 'app' })
    here.commit('only here and there', { 'g.ts': 'g\n' }, gone)
    runGit(there, 'fetch', '-q', 'origin', 'tade/gone:tade/gone')
    runGit(there, 'checkout', '-q', 'tade/gone')
    workThere(there, 'tade/gone', { 'h.ts': 'h\n' })
    const mirror = mirrorDir(here.home, 'app')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    // Here, that branch is thrown away and its commit collected.
    runGit(here.root, 'worktree', 'remove', '--force', gone)
    runGit(here.root, 'branch', '-q', '-D', 'tade/gone')
    runGit(here.root, 'reflog', 'expire', '--expire=now', '--all')
    runGit(here.root, 'gc', '-q', '--prune=now')
    const later = workThere(there, 'tade/gone', { 'i.ts': 'i\n' })

    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    expect((await mirrorHeads(mirror, 'vps'))?.get(mirrorRef('vps', 'tade/gone'))).toBe(later)
    // Whole again: everything the branch is built on can be read, the commit
    // only both machines once had included.
    const all = runGit(mirror, 'rev-list', '--objects', later)
    expect(all.split('\n').length).toBeGreaterThan(3)
  })

  it('says why it could not fetch, and never answers that nothing is there', async () => {
    const { here } = twoMachines()
    const mirror = mirrorDir(here.home, 'app')
    const said = await fetchMirror(mirror, here.root, 'vps', {
      url: join(tmp('tade-none-'), 'nothing'),
      env: {},
    })
    expect(said).toMatch(/does not appear to be a git repository|not found|No such/i)
    expect(await fetchMirror(mirror, here.root, 'Not A Name', { url: here.root, env: {} })).toMatch(
      /not a machine's name/,
    )
    expect(await readyMirror(mirror, tmp('tade-not-a-checkout-'))).toMatch(/not a checkout/)
    // A mirror nothing was fetched into holds no branches, which is an answer.
    expect(await mirrorHeads(join(tmp('tade-empty-'), 'm.git'), 'vps')).toEqual(new Map())
  })
})

describe('naming a repository wherever it is checked out', () => {
  it('reads one name out of every way a remote is written, an account’s alias included', () => {
    const name = 'github.com/acme/api'
    expect(repositoryNamed('git@github.com:acme/api.git')).toBe(name)
    expect(repositoryNamed('https://github.com/Acme/API')).toBe(name)
    expect(repositoryNamed('ssh://git@github.com/acme/api.git')).toBe(name)
    expect(repositoryNamed('git@github.com-work:acme/api.git')).toBe(name)
    expect(repositoryNamed('https://user:secret@github.com/acme/api.git')).toBe(name)
    expect(repositoryNamed('git@git.example.com:acme/api.git')).toBe('git.example.com/acme/api')
    expect(repositoryNamed('/a/path/on/disk')).toBeNull()
    expect(repositoryNamed('')).toBeNull()
  })
})

describe('the forecast across machines', () => {
  it('says this machine’s live branch and another machine’s would conflict, merged in the mirror', async () => {
    const { here, there } = twoMachines()
    const mine = here.addTask('mine', { project: 'app' })
    const ours = here.commit('mine', { 'x.ts': 'ONE\ntwo\nthree\n' }, mine)
    const theirs = workThere(there, 'tade/theirs', { 'x.ts': 'uno\ntwo\nthree\n' })
    workThere(there, 'tade/apart', { 'q.ts': 'q\n' })
    const mirror = mirrorDir(here.home, 'app')
    expect(await fetchMirror(mirror, here.root, 'vps', { url: there, env: {} })).toBeNull()
    const heads = (await mirrorHeads(mirror, 'vps')) ?? new Map()
    const elsewhere: Elsewhere = {
      mirror,
      branches: liveThere(
        'vps',
        [
          { task: 'app/theirs', branch: 'tade/theirs', base: 'main', head: theirs, live: true },
          {
            task: 'app/apart',
            branch: 'tade/apart',
            base: 'main',
            head: heads.get(mirrorRef('vps', 'tade/apart')) ?? null,
            live: true,
          },
        ],
        heads,
      ),
    }
    const before = untouched(here.root)
    const looked = await forecastConflicts({
      root: here.root,
      tasks: [
        {
          id: 'app/mine',
          workspace: 'worktree',
          state: 'working',
          git: { head: ours, mergedIntoBase: false, ahead: 1, behind: 0, baseRef: 'main' },
        } as never,
      ],
      base: null,
      wrote: async () => [],
      pool: 2,
      elsewhere,
    })
    expect(looked.warnings).toEqual([])
    expect(looked.conflicts).toEqual([
      {
        kind: 'elsewhere',
        tasks: ['app/mine'],
        elsewhere: { machine: 'vps', task: 'app/theirs', branch: 'tade/theirs' },
        files: ['x.ts'],
      },
    ])
    // The trees the merge wrote are the mirror's.
    expect(untouched(here.root)).toBe(before)
  })
})
