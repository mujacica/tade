import { writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { mirrorDir, mirrorRef } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink } from '@tade/remotes-scripted'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AGAIN_MS, Mirrors } from '../../src/wire/mirrors.ts'

// Another machine's branches mirrored into this home (`wire/mirrors.ts`): a
// real far end — its away view, an owner's session, its answer of where its
// work is — a scripted link, which hands git a far end's root as a path, and
// real repositories on both sides, the far one a clone of this checkout with
// work of its own, as one repository checked out on two machines is.

const fars: FarEnd[] = []
afterEach(async () => {
  await Promise.all(fars.splice(0).map((one) => one.close()))
})

const REPOSITORY = 'git@github.com:acme/app.git'

/** A commit on a branch of the far clone, as an agent there would make it. */
function workThere(there: string, branch: string, file: string): string {
  const from = runGit(there, 'branch', '--list', branch).trim() === '' ? 'main' : branch
  runGit(there, 'checkout', '-q', '-B', branch, from)
  writeFileSync(join(there, file), `${file}\n`)
  runGit(there, 'add', '-A')
  runGit(there, 'commit', '-q', '-m', `work on ${file}`)
  return runGit(there, 'rev-parse', 'HEAD').trim()
}

/** The refs a mirror holds of other machines, by name. */
function heldIn(mirror: string): string[] {
  return runGit(mirror, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')
    .split('\n')
    .filter(Boolean)
}

/** This machine with a checkout of `acme/app`, a far end with another, and a link up between them. */
async function linked() {
  const here = mkrepo()
  here.git('remote', 'add', 'origin', REPOSITORY)
  const there = join(tmp('tade-there-'), 'repo')
  runGit(here.root, 'clone', '-q', here.root, there)
  const head = workThere(there, 'tade/theirs', 'theirs.ts')
  const far = await startFarEnd({ projects: ['app'] })
  fars.push(far)
  far.repositories = [
    {
      project: 'app',
      root: there,
      repository: 'github.com/acme/app',
      base: 'main',
      branches: [{ task: 'app/theirs', branch: 'tade/theirs', base: 'main', head, live: true }],
    },
  ]
  const link = makeScriptedLink({
    home: here.home,
    remotes: new Map([
      ['far', { port: far.port, pair: (label) => far.pair(label), revoke: (d) => far.revoke(d) }],
    ]),
  })
  const remote = { name: 'vps', address: 'far', tade: 'tade', session: await far.pair('mac') }
  link.open(remote)
  const deadline = Date.now() + 20_000
  while (link.held('vps')?.link.kind !== 'live') {
    if (Date.now() > deadline) throw new Error(`no link: ${JSON.stringify(link.held('vps')?.link)}`)
    link.beat(Date.now())
    await new Promise((done) => setTimeout(done, 25))
  }
  const said: string[] = []
  let now = Date.parse('2026-10-17T09:00:00Z')
  const mirrors = new Mirrors({
    home: here.home,
    reach: () => ({ link, remote, live: link.held('vps')?.link.kind === 'live' }),
    projects: () => [{ name: 'app', root: here.root }],
    say: (one) => said.push(one),
    now: () => now,
    draw: () => {},
  })
  return {
    here,
    there,
    far,
    head,
    link,
    said,
    mirrors,
    later: (ms: number) => {
      now += ms
    },
    close: () => link.shutdown(),
  }
}

describe('another machine’s branches, mirrored here', () => {
  it('fetches the branches of a project that is the same repository there, for the forecast', async () => {
    const one = await linked()
    const before = runGit(one.here.root, 'for-each-ref')
    await one.mirrors.beat(['vps'])
    expect(one.said).toEqual([])
    const mirror = mirrorDir(one.here.home, 'app')
    expect(one.mirrors.elsewhere()).toEqual({
      app: {
        mirror,
        branches: [{ machine: 'vps', task: 'app/theirs', branch: 'tade/theirs', head: one.head }],
      },
    })
    // Its base is fetched beside it, which is what a merge in the mirror is measured from.
    expect(heldIn(mirror)).toEqual([mirrorRef('vps', 'main'), mirrorRef('vps', 'tade/theirs')])
    // Nothing written into the person's checkout: not a ref, not a fetch.
    expect(runGit(one.here.root, 'for-each-ref')).toBe(before)
    await one.close()
  })

  it('asks a quiet remote now and then and fetches nothing, and fetches again once a head there moved', async () => {
    const one = await linked()
    await one.mirrors.beat(['vps'])
    // Its repository taken away: any fetch now would fail, and say so.
    const away = `${one.there}-away`
    await rename(one.there, away)
    one.later(AGAIN_MS)
    await one.mirrors.beat(['vps'])
    expect(one.said).toEqual([])
    await rename(away, one.there)

    const moved = workThere(one.there, 'tade/theirs', 'more.ts')
    one.far.repositories = [
      {
        ...(one.far.repositories[0] as (typeof one.far.repositories)[number]),
        branches: [
          { task: 'app/theirs', branch: 'tade/theirs', base: 'main', head: moved, live: true },
        ],
      },
    ]
    one.later(AGAIN_MS)
    await one.mirrors.beat(['vps'])
    expect(one.mirrors.elsewhere().app?.branches[0]?.head).toBe(moved)
    expect(one.said).toEqual([])
    await one.close()
  })

  it('mirrors nothing of a project there that is another repository, whatever it is called', async () => {
    const one = await linked()
    one.far.repositories = [
      {
        ...(one.far.repositories[0] as (typeof one.far.repositories)[number]),
        repository: 'github.com/acme/other',
      },
    ]
    await one.mirrors.beat(['vps'])
    expect(one.mirrors.elsewhere()).toEqual({})
    expect(one.mirrors.sameAs('app')).toEqual([])
    await one.close()
  })

  it('says once what it could not fetch, and keeps what it fetched before', async () => {
    const one = await linked()
    await one.mirrors.beat(['vps'])
    const moved = workThere(one.there, 'tade/theirs', 'more.ts')
    one.far.repositories = [
      {
        ...(one.far.repositories[0] as (typeof one.far.repositories)[number]),
        root: '/tmp/a path with spaces',
        branches: [
          { task: 'app/theirs', branch: 'tade/theirs', base: 'main', head: moved, live: true },
        ],
      },
    ]
    for (const _ of [1, 2]) {
      one.later(AGAIN_MS)
      await one.mirrors.beat(['vps'])
    }
    expect(one.said).toHaveLength(1)
    expect(one.said[0]).toMatch(/vps's branches: .*not a path this machine fetches from/)
    // What was fetched before stands, and is not handed on as the moved head.
    const mirror = mirrorDir(one.here.home, 'app')
    expect(runGit(mirror, 'rev-parse', mirrorRef('vps', 'tade/theirs')).trim()).toBe(one.head)
    expect(one.mirrors.elsewhere()).toEqual({})
    await one.close()
  })

  it('asks nothing of a remote whose link is down, and forgets one taken away', async () => {
    const one = await linked()
    await one.mirrors.beat(['vps'])
    one.mirrors.forget('vps')
    expect(one.mirrors.elsewhere()).toEqual({})
    expect(one.mirrors.sameAs('app')).toEqual([])
    await one.close()
    await one.mirrors.beat(['vps'])
    expect(one.said).toEqual([])
  })
})
