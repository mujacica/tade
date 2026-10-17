import { generateKeyPairSync } from 'node:crypto'
import { credentialCache, ForgeError } from '@tade/forges-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  githubReplay,
  type ReplayApp,
  type ReplayOptions,
} from '../../../../test/fixtures/forge/github.ts'
import { APP_EVENTS, appToken, pemOf } from '../src/app.ts'
import { makeGithubForge } from '../src/index.ts'

// A GitHub App the person made, against the replay: the manifest it is made
// from, the code it is handed back for, and reading as its installation where
// it is installed — checked as GitHub checks the App's own token, so a forge
// that signed wrong is refused here rather than answered.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the GitHub App tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

/** A key as GitHub hands one over: PKCS#1, `BEGIN RSA PRIVATE KEY`. */
const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const replayApp = (more: Partial<ReplayApp> = {}): ReplayApp => ({
  id: '4242',
  publicKey: pair.publicKey,
  installations: [{ id: 7, account: 'acme', repositories: ['acme/api'] }],
  ...more,
})

const make = (
  options: ReplayOptions = {},
  forge: { key?: string; host?: string; cache?: ReturnType<typeof credentialCache> } = {},
) => {
  const replay = githubReplay({ app: replayApp(), ...options })
  return {
    replay,
    forge: makeGithubForge({
      exec: replay.exec,
      fetch: replay.fetch,
      env: {},
      app: { host: forge.host ?? 'github.com', id: '4242', key: forge.key ?? pair.privateKey },
      ...(forge.cache ? { credentials: forge.cache } : {}),
    }),
  }
}

/** Who asked for each call whose URL contains `part`. */
const whoAsked = (replay: ReturnType<typeof githubReplay>, part: string): string[] =>
  replay.calls.flatMap((call, at) => (call.includes(part) ? [replay.as[at] ?? ''] : []))

describe('making a GitHub App', () => {
  const want = {
    home: 'https://tade.example.com',
    hook: 'https://tade.example.com/hooks/github',
    made: 'https://tade.example.com/connect/github/made',
    installed: 'https://tade.example.com/connect/github/installed',
    state: 's-123',
    name: 'tade-vps',
  }

  it('asks to read and nothing else, with the webhook where a public name gives it an address', () => {
    const { forge } = make()
    const form = forge.appForm(want)
    expect(form.url).toBe('https://github.com/settings/apps/new?state=s-123')
    const manifest = JSON.parse(form.fields.manifest ?? '{}') as Record<string, unknown>
    expect(manifest.public).toBe(false)
    expect(manifest.redirect_url).toBe(want.made)
    expect(manifest.setup_url).toBe(want.installed)
    expect(manifest.hook_attributes).toEqual({ url: want.hook, active: true })
    expect(Object.values(manifest.default_permissions as Record<string, string>)).toEqual(
      Array(6).fill('read'),
    )
    expect(manifest.default_events).toEqual(APP_EVENTS)
    expect(form.asks.map((one) => one.what)).toContain('Issues: read')
  })

  it('makes an app with no webhook where nothing could reach this machine', () => {
    const { forge } = make()
    const form = forge.appForm({ ...want, hook: null })
    const manifest = JSON.parse(form.fields.manifest ?? '{}') as Record<string, unknown>
    expect(manifest.hook_attributes).toBeUndefined()
    expect(manifest.default_events).toEqual([])
    expect(form.events).toEqual([])
  })

  it('makes one under an organisation when it is told which', () => {
    const { forge } = make()
    expect(forge.appForm({ ...want, organisation: 'acme co' }).url).toBe(
      'https://github.com/organizations/acme%20co/settings/apps/new?state=s-123',
    )
  })

  it('exchanges the code once, with nobody’s credential, for everything the app is', async () => {
    const { forge, replay } = make({
      made: {
        'code-1': {
          id: 4242,
          slug: 'tade-vps',
          name: 'tade vps',
          owner: { login: 'mujacica' },
          html_url: 'https://github.com/apps/tade-vps',
          pem: pair.privateKey,
          webhook_secret: 'whsec',
          client_id: 'Iv1.x',
          client_secret: 'never kept',
        },
      },
    })
    const made = await forge.appMade('code-1')
    expect(made).toEqual({
      id: '4242',
      slug: 'tade-vps',
      name: 'tade vps',
      owner: 'mujacica',
      url: 'https://github.com/apps/tade-vps',
      key: pair.privateKey,
      hookSecret: 'whsec',
    })
    expect(whoAsked(replay, '/conversions')).toEqual(['nobody'])
    await expect(forge.appMade('code-1')).rejects.toMatchObject({ trouble: 'missing' })
  })

  it('says where to install it, carrying the state back', () => {
    const { forge } = make()
    expect(forge.appInstallUrl('tade-vps', 's 1')).toBe(
      'https://github.com/apps/tade-vps/installations/new?state=s%201',
    )
  })
})

describe('reading as the App', () => {
  it('reads a repository it is installed on as its installation, and asks which once', async () => {
    const cache = credentialCache()
    const first = make({}, { cache })
    await first.forge.checksOn('acme/api', HEAD)
    const second = make({}, { cache })
    await second.forge.checksOn('acme/api', HEAD)
    expect(whoAsked(first.replay, '/check-runs')).toEqual(['installation 7'])
    expect(whoAsked(first.replay, '/installation')).toEqual(['app 4242', 'app 4242'])
    // A forge lives for one look: the next one is handed what the first found.
    expect(whoAsked(second.replay, '/check-runs')).toEqual(['installation 7'])
    expect(whoAsked(second.replay, '/installation')).toEqual([])
  })

  it('reads a repository it is not installed on as the person, and remembers that too', async () => {
    const cache = credentialCache()
    const { forge, replay } = make({}, { cache })
    await forge.checksOn('acme/web', HEAD)
    await forge.checksOn('acme/web', HEAD)
    expect(whoAsked(replay, '/check-runs')).toEqual(['mujacica', 'mujacica'])
    expect(whoAsked(replay, '/repos/acme/web/installation')).toEqual(['app 4242'])
  })

  it('reads issues, a review and its log as the installation', async () => {
    const { forge, replay } = make()
    await forge.tickets({ repo: 'acme/api', labels: ['tade'] })
    await forge.checkLogOn('acme/api', HEAD, 'tests', 20)
    expect(whoAsked(replay, '/issues?')).toEqual(['installation 7'])
    expect(whoAsked(replay, '/actions/')).toEqual([
      'installation 7',
      'installation 7',
      'installation 7',
    ])
  })

  it('is still the person wherever the question is about the person', async () => {
    const { forge, replay } = make()
    expect(await forge.whoami()).toEqual({ login: 'mujacica', can: 'write' })
    expect(await forge.access('acme/api')).toMatchObject({ kind: 'signed in' })
    const mine = await forge.reviews({ who: 'mine', repos: ['acme/api'] })
    expect(mine.items.length).toBeGreaterThan(0)
    expect(replay.as.filter((one) => one.startsWith('installation'))).toEqual([])
  })

  it('asks the person for what the App was not allowed, and keeps its token for the rest', async () => {
    const { forge, replay } = make({ app: replayApp({ refuses: ['/actions/runs?'] }) })
    await forge.checkLogOn('acme/api', HEAD, 'tests', 20)
    expect(whoAsked(replay, '/actions/runs?')).toEqual(['installation 7', 'mujacica'])
    expect(whoAsked(replay, '/access_tokens')).toEqual(['app 4242'])
  })

  it('never answers for a host it was not made on', async () => {
    const { forge, replay } = make({}, { host: 'git.acme.com' })
    await forge.checksOn('acme/api', HEAD)
    expect(whoAsked(replay, '/check-runs')).toEqual(['mujacica'])
    expect(replay.calls.some((one) => one.includes('/installation'))).toBe(false)
  })

  it('says a key that is not one is the App’s trouble, without a byte of the key', async () => {
    const { forge } = make({}, { key: 'not a key at all' })
    const failed = await forge.checksOn('acme/api', HEAD).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(ForgeError)
    expect((failed as ForgeError).trouble).toBe('auth')
    expect((failed as ForgeError).message).toContain('GitHub App 4242')
    expect((failed as ForgeError).message).not.toContain('not a key at all')
  })

  it('says an App GitHub no longer takes is gone, rather than reading as the person', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const { forge } = make({ app: replayApp({ publicKey: other.publicKey }) })
    await expect(forge.checksOn('acme/api', HEAD)).rejects.toMatchObject({
      trouble: 'auth',
      message: expect.stringContaining('connect GitHub again'),
    })
  })

  it('says where it is installed and on how many repositories', async () => {
    const { forge } = make({
      app: replayApp({
        installations: [
          { id: 7, account: 'acme', repositories: ['acme/api', 'acme/web'] },
          { id: 8, account: 'mujacica', repositories: 'all' },
        ],
      }),
    })
    expect(await forge.appInstallations()).toEqual([
      { id: '7', account: 'acme', repositories: 2 },
      { id: '8', account: 'mujacica', repositories: 'all' },
    ])
  })

  it('refuses to say where an app is installed when it was made with none', async () => {
    const replay = githubReplay()
    const forge = makeGithubForge({ exec: replay.exec, fetch: replay.fetch, env: {} })
    await expect(forge.appInstallations()).rejects.toMatchObject({ trouble: 'auth' })
  })
})

describe('the App’s own token', () => {
  it('reads a key kept on one line with its newlines written out', () => {
    const oneLine = pair.privateKey.trim().replace(/\n/g, '\\n')
    expect(pemOf(oneLine)).toBe(pair.privateKey.trim())
    expect(pemOf(pair.privateKey)).toBe(pair.privateKey)
    const token = appToken({ host: 'github.com', id: '4242', key: oneLine }, 1_800_000_000_000)
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    expect(claims).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '4242' })
  })
})
