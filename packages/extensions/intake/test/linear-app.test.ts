import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { challengeOf, linearScript } from '../../../../test/fixtures/linear/linear.ts'
import { linearIssues } from '../src/linear.ts'
import { LinearError } from '../src/linear-api.ts'
import {
  linearAsks,
  linearAuthorizeUrl,
  linearEvents,
  linearInstalled,
  linearMakeUrl,
  linearManifest,
  linearRefreshed,
  linearWho,
} from '../src/linear-app.ts'

// The Linear app Connect Linear asks the person to make (REMOTE-TADE §6.3):
// the manifest, the addresses a browser is sent to, an install's code
// exchanged with its proof key, and a refresh token traded for the next —
// over the one Linear client, against a Linear that answers from a file. What
// the page and the window do with it is `web/test/connected.test.ts`,
// `app/test/wire/web-connect.test.ts` and `app/test/wire/linear-tokens.test.ts`.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Linear app tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const HOME = 'https://tade.example.com'
const CLIENT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
const VERIFIER = 'v'.repeat(43)

/**
 * What Linear's own schema (`oauth-app-manifest.schema.json`, read
 * 2026-10-17) refuses, as far as a manifest made here could reach it: no key
 * it does not know at any level, the three it requires, a client name of two
 * to eighty characters with neither "Linear" nor an address in it, redirects
 * over HTTP or HTTPS, a webhook only over HTTPS, and resource types from its
 * list. Written out rather than fetched, so the test runs with no network.
 */
function refusedByLinear(manifest: Record<string, unknown>): string[] {
  const wrong: string[] = []
  const only = (at: string, value: unknown, keys: readonly string[]) => {
    for (const key of Object.keys(value as object)) {
      if (!keys.includes(key)) wrong.push(`${at}.${key} is not in the schema`)
    }
  }
  only('manifest', manifest, [
    '$schema',
    'schemaVersion',
    'distribution',
    'display',
    'developer',
    'oauth',
    'webhook',
  ])
  for (const key of ['schemaVersion', 'developer', 'oauth']) {
    if (!(key in manifest)) wrong.push(`${key} is required`)
  }
  if (manifest.schemaVersion !== '1.0.0') wrong.push('schemaVersion must be 1.0.0')
  if (!['private', 'public', undefined].includes(manifest.distribution as string)) {
    wrong.push('distribution is private or public')
  }
  const developer = manifest.developer as { name?: string }
  only('developer', developer, ['name'])
  if ((developer.name ?? '').length < 2) wrong.push('developer.name is two characters or more')
  const oauth = manifest.oauth as {
    client_name?: string
    redirect_uris?: string[]
    grant_types?: string[]
  }
  only('oauth', oauth, ['client_name', 'client_uri', 'redirect_uris', 'grant_types'])
  const name = oauth.client_name ?? ''
  if (name.length < 2 || name.length > 80) wrong.push('client_name is 2–80 characters')
  if (/linear/i.test(name)) wrong.push('client_name may not contain Linear')
  if (/https?:\/\//i.test(name)) wrong.push('client_name may not contain an address')
  const redirects = oauth.redirect_uris ?? []
  if (redirects.length < 1 || redirects.length > 32) wrong.push('1–32 redirect_uris')
  for (const one of redirects) if (!/^https?:\/\//i.test(one)) wrong.push(`${one} is not http(s)`)
  if (!(oauth.grant_types ?? ['authorization_code']).includes('authorization_code')) {
    wrong.push('grant_types must contain authorization_code')
  }
  if (manifest.display !== undefined) only('display', manifest.display, ['description', 'iconUrl'])
  const webhook = manifest.webhook as
    | { url?: string; enabled?: boolean; resourceTypes?: string[] }
    | undefined
  if (webhook !== undefined) {
    only('webhook', webhook, ['url', 'enabled', 'resourceTypes'])
    if (!/^https:\/\//i.test(webhook.url ?? '')) wrong.push('webhook.url is HTTPS')
    const known = ['Issue', 'Comment', 'IssueLabel', 'AgentSessionEvent', 'OAuthAuthorization']
    for (const one of webhook.resourceTypes ?? []) {
      if (!known.includes(one)) wrong.push(`${one} is not a resource type`)
    }
    if ((webhook.resourceTypes ?? []).length < 1) wrong.push('at least one resource type')
  }
  return wrong
}

describe('the manifest', () => {
  it('delivers what rings the watch to the doorbell and comes back to the public name', () => {
    const made = linearManifest({ name: 'Tade vps', home: HOME, delivers: true })
    expect(refusedByLinear(made)).toEqual([])
    expect(made).toMatchObject({
      distribution: 'private',
      oauth: {
        client_name: 'Tade vps',
        redirect_uris: [`${HOME}/connect/linear/installed`],
        grant_types: ['authorization_code'],
      },
      webhook: { enabled: true, url: `${HOME}/hooks/linear` },
    })
    // What the webhook is sent is what rings the watch, read off the watch.
    expect((made.webhook as { resourceTypes: string[] }).resourceTypes).toEqual(
      linearIssues.doorbell?.events,
    )
    expect(linearEvents(true)).toEqual(['Issue', 'Comment'])
  })

  it('with no public name has no webhook, and comes back to the door the press came in at', () => {
    const made = linearManifest({ name: 'Tade', home: 'http://localhost:7654', delivers: false })
    expect(refusedByLinear(made)).toEqual([])
    expect(made).not.toHaveProperty('webhook')
    expect((made.oauth as { redirect_uris: string[] }).redirect_uris).toEqual([
      'http://localhost:7654/connect/linear/installed',
    ])
    expect(linearEvents(false)).toEqual([])
  })

  it('keeps the word Linear and any address out of the name, which Linear refuses', () => {
    for (const name of ['Linear for Tade', 'https://tade.example.com', 'linear', '  ']) {
      const made = linearManifest({ name, home: HOME, delivers: true })
      expect(refusedByLinear(made), name).toEqual([])
    }
    expect(
      (
        linearManifest({ name: 'Linear', home: HOME, delivers: true }).oauth as {
          client_name: string
        }
      ).client_name,
    ).toBe('Tade')
  })

  it('asks to read and nothing else, and says so', () => {
    expect(linearAsks().map((one) => one.what)).toEqual(['read'])
    expect(linearAsks()[0]?.why).toContain('nothing it may do writes')
  })

  it('is made on Linear’s own page, with the manifest in its address', () => {
    const url = new URL(linearMakeUrl({ name: 'Tade vps', home: HOME, delivers: true }))
    expect(`${url.origin}${url.pathname}`).toBe('https://linear.app/settings/api/applications/new')
    expect(JSON.parse(url.searchParams.get('manifest') ?? '{}')).toEqual(
      linearManifest({ name: 'Tade vps', home: HOME, delivers: true }),
    )
  })
})

describe('connecting it', () => {
  it('sends the browser to Linear with the word, the redirect and a proof key’s challenge', () => {
    const url = new URL(
      linearAuthorizeUrl({ clientId: CLIENT, home: HOME, state: 's-1', challenge: 'c-1' }),
    )
    expect(`${url.origin}${url.pathname}`).toBe('https://linear.app/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: `${HOME}/connect/linear/installed`,
      response_type: 'code',
      scope: 'read',
      state: 's-1',
      code_challenge: 'c-1',
      code_challenge_method: 'S256',
    })
  })

  it('exchanges the code with its verifier and no client secret, and says who it is', async () => {
    const script = linearScript({
      base: 0,
      oauth: {
        clientId: CLIENT,
        codes: {
          c0de: { challenge: challengeOf(VERIFIER), redirect: `${HOME}/connect/linear/installed` },
        },
        workspace: 'Acme',
        user: 'kim',
      },
    })
    const from = { fetch: script.fetch, signal: new AbortController().signal }
    const got = await linearInstalled(from, {
      clientId: CLIENT,
      code: 'c0de',
      verifier: VERIFIER,
      home: HOME,
    })
    expect(got).toEqual({
      access: 'lin_oauth_access_1',
      refresh: 'lin_refresh_1',
      expiresIn: 86399,
      workspace: 'Acme',
      user: 'kim',
    })
    const [sent] = script.oauth?.calls ?? []
    expect(sent?.form).not.toHaveProperty('client_secret')
    expect(sent?.form).toMatchObject({ grant_type: 'authorization_code', code_verifier: VERIFIER })
    // Who it is was asked with the token, as `Bearer`.
    expect(await linearWho(from, got.access)).toEqual({ workspace: 'Acme', user: 'kim' })
  })

  it('will not exchange a code with another verifier, again, or for another redirect', async () => {
    const redirect = `${HOME}/connect/linear/installed`
    const script = linearScript({
      base: 0,
      oauth: {
        clientId: CLIENT,
        codes: {
          one: { challenge: challengeOf(VERIFIER), redirect },
          two: { challenge: challengeOf(VERIFIER), redirect },
        },
      },
    })
    const from = { fetch: script.fetch, signal: new AbortController().signal }
    const asked = (code: string, over: Partial<{ verifier: string; home: string }> = {}) =>
      linearInstalled(from, { clientId: CLIENT, code, verifier: VERIFIER, home: HOME, ...over })
    await expect(asked('one', { verifier: 'w'.repeat(43) })).rejects.toMatchObject({
      trouble: 'auth',
      message: expect.stringContaining('invalid_grant'),
    })
    // The try burned it, as Linear does.
    await expect(asked('one')).rejects.toBeInstanceOf(LinearError)
    await expect(asked('two', { home: 'http://localhost:1' })).rejects.toMatchObject({
      trouble: 'auth',
    })
  })
})

describe('refreshing it', () => {
  it('trades the refresh token for the next one, and the spent one answers the same while its grace lasts', async () => {
    const script = linearScript({ base: 0, oauth: { clientId: CLIENT, refresh: 'first' } })
    const from = { fetch: script.fetch, signal: new AbortController().signal }
    const next = await linearRefreshed(from, { clientId: CLIENT, refresh: 'first' })
    expect(next.refresh).not.toBe('first')
    expect(script.oauth?.refresh).toBe(next.refresh)
    // A window that died before keeping it asks again with the spent one.
    expect(await linearRefreshed(from, { clientId: CLIENT, refresh: 'first' })).toEqual(next)
    script.oauth?.graceOver()
    await expect(
      linearRefreshed(from, { clientId: CLIENT, refresh: 'first' }),
    ).rejects.toMatchObject({ trouble: 'auth' })
    expect(script.oauth?.calls.every((one) => !('client_secret' in one.form))).toBe(true)
  })

  it('says a revoked app is auth, and nothing answering is not', async () => {
    const script = linearScript({ base: 0, oauth: { clientId: CLIENT, refresh: 'first' } })
    script.oauth?.revoke()
    const from = { fetch: script.fetch, signal: new AbortController().signal }
    await expect(
      linearRefreshed(from, { clientId: CLIENT, refresh: 'first' }),
    ).rejects.toMatchObject({ trouble: 'auth' })
    const offline = linearScript({ base: 0, offline: true, oauth: { clientId: CLIENT } })
    await expect(
      linearRefreshed(
        { fetch: offline.fetch, signal: new AbortController().signal },
        { clientId: CLIENT, refresh: 'first' },
      ),
    ).rejects.toThrow(/did not answer/)
  })

  it('says a gateway’s page is not a token, rather than reading it as none', async () => {
    const gateway = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch
    await expect(
      linearRefreshed(
        { fetch: gateway, signal: new AbortController().signal },
        { clientId: CLIENT, refresh: 'first' },
      ),
    ).rejects.toMatchObject({ trouble: 'linear', message: expect.stringContaining('not JSON') })
  })

  it('says a token Linear no longer takes is auth when asked who it is', async () => {
    const script = linearScript({ base: 0, oauth: { clientId: CLIENT } })
    await expect(
      linearWho({ fetch: script.fetch, signal: new AbortController().signal }, 'lin_oauth_old'),
    ).rejects.toMatchObject({ trouble: 'auth' })
  })
})
