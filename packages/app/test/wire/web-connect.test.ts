import { generateKeyPairSync } from 'node:crypto'
import { type Config, ConfigSchema } from '@tade/core'
import { forgeOnHost } from '@tade/status'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { CONNECTED_BY, connectingFor } from '../../src/wire/web-connect.ts'

// The window's half of connecting GitHub (REMOTE-TADE §6.4): what the page
// reads — the App kept, where GitHub says it is installed, what the journal
// heard — and keeping what GitHub hands back for a code, through the one
// write path, in an order no window dying halfway can leave half of. Against
// the replay, which checks the App's token as GitHub does; the routes in front
// of this are `@tade/web`'s `connected.test.ts`.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`connecting GitHub reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const NOW = Date.now()

/** GitHub's answer for a code, as its conversions endpoint gives it. */
const MADE = {
  id: 4242,
  slug: 'tade-vps',
  name: 'Tade vps',
  owner: { login: 'mujacica' },
  html_url: 'https://github.com/apps/tade-vps',
  pem: keys.privateKey,
  webhook_secret: 'whsec-new',
  client_id: 'Iv1.never-kept',
  client_secret: 'never kept either',
}

function window(
  over: {
    intake?: Record<string, unknown>
    publicName?: string | null
    replay?: ReplayOptions
    heard?: { verified: number | null; refused: number | null }
  } = {},
) {
  const replay = githubReplay({
    made: { 'code-1': MADE },
    app: {
      id: '4242',
      publicKey: keys.publicKey,
      installations: [{ id: 7, account: 'acme', repositories: ['acme/api', 'acme/web'] }],
    },
    ...over.replay,
  })
  let config: Config = ConfigSchema.parse({
    extensions: { intake: over.intake ?? {} },
    surfaces: {
      // A public name counts only while the away view is on, which is what
      // serves these pages at all.
      web:
        over.publicName === null
          ? { enabled: true }
          : { enabled: true, public: over.publicName ?? 'tade.example.com' },
    },
  })
  const wrote: { key: string; value: unknown; was: string; by: string | undefined }[] = []
  const half = connectingFor({
    config: () => config,
    settings: {
      writeKey: async (key, value, was, how) => {
        wrote.push({ key, value, was, by: how?.by })
        const leaf = key.split('.').at(-1) ?? ''
        const intake = { ...(config.extensions.intake ?? {}) }
        if (value === undefined) delete intake[leaf]
        else intake[leaf] = value
        config = { ...config, extensions: { ...config.extensions, intake } }
      },
    },
    heard: () => over.heard ?? { verified: null, refused: null },
    now: () => NOW,
    env: {},
    forge: (apps) =>
      forgeOnHost('github.com', { exec: replay.exec, fetch: replay.fetch, env: {}, apps }),
  })
  return { half, wrote, replay, config: () => config }
}

describe('the page, as the window reads it', () => {
  it('starts at making the App, and says what it asks GitHub for', async () => {
    const { half, replay } = window()
    const { page, asks, events } = await half.page('github')
    expect(page.steps.map((one) => one.done)).toEqual([false, false, false])
    expect(asks.map((one) => one.what)).toContain('Pull requests: read')
    expect(events).toContain('check_suite')
    // Nothing is asked of GitHub where there is no App to ask about.
    expect(replay.calls.filter((one) => !one.startsWith('gh '))).toEqual([])
  })

  it('reads where a kept App is installed, as the App, once a minute however often it is opened', async () => {
    const { half, replay } = window({
      intake: {
        github_app_id: '4242',
        github_app_key: keys.privateKey,
        github_app_slug: 'tade-vps',
      },
    })
    const first = await half.page('github')
    await half.page('github')
    expect(first.page.steps[1]).toMatchObject({
      done: true,
      said: 'installed on 2 repositories of acme',
    })
    expect(replay.calls.filter((one) => one.includes('/app/installations?')).length).toBe(1)
    // Told an install came back, it asks again.
    half.installed('github')
    await half.page('github')
    expect(replay.calls.filter((one) => one.includes('/app/installations?')).length).toBe(2)
  })

  it('says GitHub would not take the App rather than that it is installed nowhere', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const { half } = window({
      intake: {
        github_app_id: '4242',
        github_app_key: other.privateKey,
        github_app_slug: 'tade-vps',
      },
    })
    const { page } = await half.page('github')
    expect(page.steps[1]?.done).toBe(false)
    expect(page.steps[1]?.said).toContain('could not be asked')
    expect(page.steps[1]?.said).toContain('connect GitHub again')
  })

  it('reads the deliveries out of what the journal heard', async () => {
    const { half } = window({
      intake: { github_webhook_secret: 'whsec' },
      heard: { verified: NOW - 60_000, refused: null },
    })
    const { page } = await half.page('github')
    expect(page.steps[2]?.done).toBe(true)
  })
})

describe('keeping what GitHub made', () => {
  it('keeps the key, the slug and the delivery secret, and the id last, each as connecting GitHub', async () => {
    const { half, wrote, config } = window()
    expect(await half.made('github', 'code-1')).toEqual({ name: 'Tade vps' })
    expect(wrote.map((one) => [one.key, one.was])).toEqual([
      ['extensions.intake.github_app_key', 'not set'],
      ['extensions.intake.github_app_slug', ''],
      ['extensions.intake.github_webhook_secret', 'not set'],
      ['extensions.intake.github_app_id', ''],
    ])
    expect(wrote.every((one) => one.by === CONNECTED_BY)).toBe(true)
    expect(config().extensions.intake).toMatchObject({
      github_app_id: '4242',
      github_app_key: keys.privateKey,
      github_app_slug: 'tade-vps',
      github_webhook_secret: 'whsec-new',
    })
    // What GitHub hands over and Tade does not use is not kept.
    expect(JSON.stringify(config().extensions.intake)).not.toContain('never kept')
  })

  it('takes the old id away first, so no old id is ever beside a new key', async () => {
    const { half, wrote } = window({
      intake: { github_app_id: '1111', github_app_key: 'old', github_webhook_secret: 'old' },
    })
    await half.made('github', 'code-1')
    expect(wrote[0]).toMatchObject({ key: 'extensions.intake.github_app_id', value: undefined })
    expect(wrote.at(-1)).toMatchObject({ key: 'extensions.intake.github_app_id', value: '4242' })
    expect(wrote.find((one) => one.key.endsWith('github_app_key'))?.was).toBe('set')
  })

  it('takes the old delivery secret away where the new App was made with no webhook', async () => {
    const { half, wrote, config } = window({
      intake: { github_webhook_secret: 'old' },
      replay: { made: { 'code-1': { ...MADE, webhook_secret: null } } },
    })
    await half.made('github', 'code-1')
    expect(wrote.find((one) => one.key.endsWith('github_webhook_secret'))?.value).toBeUndefined()
    expect(config().extensions.intake?.github_webhook_secret).toBeUndefined()
  })

  it('keeps nothing for a code GitHub does not know, and says so in the forge’s words', async () => {
    const { half, wrote } = window()
    const kept = await half.made('github', 'never-handed-out')
    expect(kept).toEqual({ problem: expect.stringContaining('does not know that code') })
    expect(wrote).toEqual([])
  })

  it('says where the browser goes to install it, carrying the word, once a slug is kept', () => {
    expect(window().half.installUrl('github', 's')).toBeNull()
    const { half } = window({ intake: { github_app_slug: 'tade-vps' } })
    expect(half.installUrl('github', 's-1')).toBe(
      'https://github.com/apps/tade-vps/installations/new?state=s-1',
    )
  })
})
