import { CREDENTIAL_KEEP_MS, credentialCache, type ForgeOptions } from '@tade/forges-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { makeGithubForge } from '../src/index.ts'

// A forge is made for every look and thrown away after it, so what `gh auth
// token` answered used to be thrown away with it: a process a minute per
// project. These hold what replaced that — a credential kept between forges,
// for minutes, and never once the forge has been refused it.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the credential tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

function machine(options: ReplayOptions = {}) {
  let at = Date.parse('2026-10-11T08:00:00Z')
  const replay = githubReplay(options)
  const now = () => at
  const credentials = credentialCache({ now })
  const make = (more: Partial<ForgeOptions> = {}) =>
    makeGithubForge({ exec: replay.exec, fetch: replay.fetch, env: {}, now, credentials, ...more })
  const asked = () => replay.calls.filter((call) => call.startsWith('gh auth token')).length
  return {
    replay,
    make,
    asked,
    credentials,
    later: (ms: number) => {
      at += ms
    },
  }
}

describe('a credential found by running gh', () => {
  it('is asked for once however many forges are made for the same sign-in', async () => {
    const { make, asked } = machine()
    for (let look = 0; look < 5; look++) await make().whoami()
    expect(asked()).toBe(1)
  })

  it('is asked for once when several forges want it at the same moment', async () => {
    const { make, asked } = machine()
    await Promise.all([make().whoami(), make().whoami(), make().whoami()])
    expect(asked()).toBe(1)
  })

  it('is kept per sign-in: a second account is its own ask, and its own token', async () => {
    const { make, asked } = machine({ signedInAs: ['ammujacic', 'mujacica'] })
    expect(await make().whoami()).toMatchObject({ login: 'mujacica' })
    const second = make({ accounts: { 'github.com': 'ammujacic' } })
    expect(await second.whoami()).toMatchObject({ login: 'ammujacic' })
    expect(await make().whoami()).toMatchObject({ login: 'mujacica' })
    expect(asked()).toBe(2)
  })

  it('is looked for again once it has been kept for ten minutes', async () => {
    const { make, asked, later } = machine()
    await make().whoami()
    later(CREDENTIAL_KEEP_MS - 1)
    await make().whoami()
    expect(asked()).toBe(1)
    later(1)
    await make().whoami()
    expect(asked()).toBe(2)
  })

  it('is dropped the moment GitHub refuses it, and the next forge looks again', async () => {
    // A token revoked on the website: `gh` hands over the old one until
    // somebody signs in again, and then a new one. Ten minutes of 401s in
    // between would be a fault the cache made.
    const replay = githubReplay()
    let revoked = true
    const exec: ForgeOptions['exec'] = async (command, args) => {
      const got = await replay.exec(command, args)
      return revoked ? { ...got, stdout: 'gho_revoked\n' } : got
    }
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      if (auth === 'Bearer gho_revoked') {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      }
      return replay.fetch(url, init)
    }) as typeof globalThis.fetch
    const credentials = credentialCache()
    const make = () => makeGithubForge({ exec, fetch, env: {}, credentials })
    await expect(make().reviews({ who: 'mine' })).rejects.toMatchObject({ trouble: 'auth' })
    revoked = false
    expect(await make().whoami()).toMatchObject({ login: 'mujacica' })
    expect(replay.calls.filter((call) => call.startsWith('gh auth token'))).toHaveLength(2)
  })

  it('is not kept when gh could not find one, so signing in is heard at the next look', async () => {
    const replay = githubReplay({ signedOut: true })
    let signedIn = false
    const exec: ForgeOptions['exec'] = async (command, args) =>
      signedIn ? githubReplay().exec(command, args) : replay.exec(command, args)
    const credentials = credentialCache()
    const make = () => makeGithubForge({ exec, fetch: replay.fetch, env: {}, credentials })
    expect(await make().whoami()).toHaveProperty('problem')
    signedIn = true
    expect(await make().whoami()).toMatchObject({ login: 'mujacica' })
  })

  it('never stands in for the environment, which is read every time and always wins', async () => {
    const { make, asked } = machine()
    await make().whoami()
    const env = { GITHUB_TOKEN: 'gho_fromtheenvironmenttoken' }
    expect(await make({ env }).whoami()).toMatchObject({ login: 'fromtheenvironment' })
    expect(asked()).toBe(1)
  })
})

describe('the cache, on its own', () => {
  it('forgets a refused credential only if it is still the one kept', async () => {
    let at = 0
    const cache = credentialCache({ now: () => at, keepMs: 100 })
    expect(await cache.get('github.com', async () => 'first')).toBe('first')
    at = 100
    // A newer one is already being found when the old one is refused: the
    // refusal is about the old one and must not throw the new one away.
    let release: (value: string) => void = () => {}
    const second = cache.get('github.com', () => new Promise<string>((done) => (release = done)))
    cache.refused('github.com', 'first')
    release('second')
    expect(await second).toBe('second')
    cache.refused('github.com', 'first')
    expect(await cache.get('github.com', async () => 'third')).toBe('second')
    cache.refused('github.com', 'second')
    expect(await cache.get('github.com', async () => 'third')).toBe('third')
  })
})
