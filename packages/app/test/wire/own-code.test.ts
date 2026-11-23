import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { gitLoad, resetGitLoad } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { mkrepo, type Repo } from '../../../../test/fixtures/mkrepo.ts'
import { LOOK_EVERY_MS, OwnCode, ownCheckout, ownCheckoutOption } from '../../src/wire/own-code.ts'

// Whether the code a Tade run from its checkout holds is still the checkout's.
// Real git, the way every look at a checkout is tested here.

/** A checkout shaped like Tade's: code under a package's `src/`, tests and docs beside it. */
function checkout(): Repo {
  const repo = mkrepo()
  repo.commit('a tade-shaped tree', {
    'package.json': '{}\n',
    'packages/app/package.json': '{}\n',
    'packages/app/src/wire/updates.ts': 'export const a = 1\n',
    'packages/app/test/updates.test.ts': 'test\n',
    'packages/web/src/assets/boot.js': 'page\n',
    'docs.md': 'words\n',
  })
  return repo
}

/** One look, as the beat makes it, waited for. */
async function look(own: OwnCode, at: number): Promise<number> {
  let told = 0
  own.beat(at, () => told++)
  await own.settled()
  return told
}

describe('a reload owed by Tade’s own code', () => {
  it('is owed once a commit touches a package’s src, and not for docs or tests', async () => {
    const repo = checkout()
    const own = new OwnCode(repo.root)
    await own.begin()
    expect(own.startedOn()).toBe(repo.head())

    repo.commit('docs and tests', {
      'docs.md': 'more words\n',
      'packages/app/test/updates.test.ts': 'more test\n',
      // Live-reloaded by the away page itself, never held by the server.
      'packages/web/src/assets/boot.js': 'newer page\n',
    })
    expect(await look(own, 0)).toBe(0)
    expect(own.owed()).toEqual([])

    repo.commit('code', { 'packages/app/src/wire/updates.ts': 'export const a = 2\n' })
    // A minute has not passed: not looked at yet.
    expect(await look(own, LOOK_EVERY_MS - 1)).toBe(0)
    expect(await look(own, LOOK_EVERY_MS)).toBe(1)
    expect(own.owed()).toEqual(['packages/app/src/wire/updates.ts'])
    // Said once, and never looked at again.
    expect(await look(own, 10 * LOOK_EVERY_MS)).toBe(0)
  })

  it('counts the lockfile and a package.json, committed or not', async () => {
    const repo = checkout()
    const own = new OwnCode(repo.root)
    await own.begin()
    repo.write({ 'packages/app/package.json': '{ "exports": {} }\n' })
    expect(await look(own, 0)).toBe(1)
    expect(own.owed()).toEqual(['packages/app/package.json'])

    const lock = checkout()
    const locked = new OwnCode(lock.root)
    await locked.begin()
    lock.commit('a dependency', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    expect(await look(locked, 0)).toBe(1)
    expect(locked.owed()).toEqual(['pnpm-lock.yaml'])
  })

  it('starts from what was uncommitted, so a dirty tree is not owed until it changes again', async () => {
    const repo = checkout()
    repo.write({
      'packages/app/src/wire/updates.ts': 'export const a = 3\n',
      'packages/app/src/wire/new.ts': 'export const b = 1\n',
    })
    const own = new OwnCode(repo.root)
    await own.begin()
    expect(await look(own, 0)).toBe(0)

    // Committed exactly as it was loaded: still the code that runs.
    repo.commit('as it was', {
      'packages/app/src/wire/updates.ts': 'export const a = 3\n',
      'packages/app/src/wire/new.ts': 'export const b = 1\n',
    })
    expect(await look(own, LOOK_EVERY_MS)).toBe(0)

    repo.write({ 'packages/app/src/wire/new.ts': 'export const b = 2\n' })
    expect(await look(own, 2 * LOOK_EVERY_MS)).toBe(1)
    expect(own.owed()).toEqual(['packages/app/src/wire/new.ts'])
  })

  it('is owed when an uncommitted change is put back, because that is not what was loaded', async () => {
    const repo = checkout()
    repo.write({ 'packages/app/src/wire/updates.ts': 'export const a = 3\n' })
    const own = new OwnCode(repo.root)
    await own.begin()
    repo.write({ 'packages/app/src/wire/updates.ts': 'export const a = 1\n' })
    expect(await look(own, 0)).toBe(1)
    expect(own.owed()).toEqual(['packages/app/src/wire/updates.ts'])
  })

  it('lets what the told side throws reach whoever reports it, rather than swallowing it', async () => {
    const repo = checkout()
    const own = new OwnCode(repo.root)
    await own.begin()
    repo.commit('code', { 'packages/app/src/wire/updates.ts': 'export const a = 2\n' })
    own.beat(0, () => {
      throw new Error('the strip could not draw')
    })
    await expect(own.settled()).rejects.toThrow('the strip could not draw')
    expect(own.owed()).toEqual(['packages/app/src/wire/updates.ts'])
  })

  it('never looks without a checkout, or where git cannot read one', async () => {
    const none = new OwnCode(null)
    await none.begin()
    expect(await look(none, 0)).toBe(0)
    expect(none.startedOn()).toBeNull()

    const repo = checkout()
    rmSync(join(repo.root, '.git'), { recursive: true, force: true })
    const gone = new OwnCode(repo.root)
    await gone.begin()
    resetGitLoad()
    expect(await look(gone, 0)).toBe(0)
    expect(gitLoad().started).toBe(0)
  })

  it('is a checkout only where Tade runs from source', () => {
    expect(ownCheckout('file:///opt/tade/packages/app/src/wire/own-code.js')).toBeNull()
    expect(ownCheckoutOption('file:///opt/tade/packages/app/src/wire/own-code.js')).toEqual({})
    expect(ownCheckout('file:///work/tade/packages/app/src/wire/own-code.ts')).toBe('/work/tade')
    expect(ownCheckoutOption('file:///work/tade/packages/app/src/wire/own-code.ts')).toEqual({
      checkout: '/work/tade',
    })
  })
})

// "Tade stays light, and proves it": the beat runs every couple of seconds on
// the thread that draws, so what it may cost is held here as a count with a
// ceiling, never a time — at most one look a minute, two gits a look, and none
// at all once owed.
describe('what the beat costs', () => {
  it('starts at most one look a minute, of two gits, and none once owed', async () => {
    const repo = checkout()
    const own = new OwnCode(repo.root)
    await own.begin()
    resetGitLoad()

    // Ten minutes of a two-second beat, each look let finish before the next beat.
    const BEAT_MS = 2_000
    const beats = (10 * LOOK_EVERY_MS) / BEAT_MS
    for (let i = 0; i < beats; i++) await look(own, i * BEAT_MS)
    expect(gitLoad().commands).toEqual({ diff: 10, 'ls-files': 10 })

    // A beat while a look is still going starts no second one.
    resetGitLoad()
    own.beat(20 * LOOK_EVERY_MS, () => {})
    own.beat(30 * LOOK_EVERY_MS, () => {})
    await own.settled()
    expect(gitLoad().started).toBe(2)

    repo.commit('code', { 'packages/app/src/wire/updates.ts': 'export const a = 2\n' })
    expect(await look(own, 40 * LOOK_EVERY_MS)).toBe(1)
    resetGitLoad()
    for (let i = 0; i < beats; i++) await look(own, (50 + i) * LOOK_EVERY_MS)
    expect(gitLoad().started).toBe(0)
  })
})
