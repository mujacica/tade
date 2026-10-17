import { generateKeyPairSync } from 'node:crypto'
import { type Config, ConfigSchema } from '@tade/core'
import { forgeOnHost } from '@tade/status'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import {
  challengeOf,
  type LinearScript,
  linearScript,
} from '../../../../test/fixtures/linear/linear.ts'
import { type SlackScript, slackScript } from '../../../../test/fixtures/slack/slack.ts'
import { LINEAR_CONNECTED_BY } from '../../src/wire/linear-tokens.ts'
import { CONNECTED_BY, connectingFor, SLACK_CONNECTED_BY } from '../../src/wire/web-connect.ts'

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
    slack?: SlackScript
    linear?: LinearScript
    env?: Record<string, string>
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
    env: over.env ?? {},
    ...(over.slack === undefined ? {} : { fetch: over.slack.fetch }),
    ...(over.linear === undefined ? {} : { fetch: over.linear.fetch }),
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
    expect(await half.installed('github', { code: null, error: null, home: 'x' })).toEqual({
      where: null,
    })
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
    expect(window().half.installUrl('github', 's', 'https://x', null)).toBeNull()
    const { half } = window({ intake: { github_app_slug: 'tade-vps' } })
    expect(half.installUrl('github', 's-1', 'https://x', null)).toBe(
      'https://github.com/apps/tade-vps/installations/new?state=s-1',
    )
  })
})

describe('connecting Slack, as the window does it', () => {
  // Everything about Slack is asked of the Slack door over its one client
  // (`@tade/extension-intake`'s `slack-app.ts`), against a Slack that answers
  // from a file and checks the install's client, code and redirect as Slack does.
  const SIGNING = 's'.repeat(32)
  const SECRET = 'c'.repeat(32)
  const install = {
    clientId: '1234.5678',
    clientSecret: SECRET,
    code: 'c0de',
    redirect: 'https://tade.example.com/connect/slack/installed',
    token: 'xoxb-1-2-made',
  }
  const kept = { slack_client_id: '1234.5678', slack_client_secret: SECRET }

  it('starts at making the app, says what it asks Slack for, and asks Slack nothing', async () => {
    const slack = slackScript({ base: 0, install })
    const { half } = window({ slack })
    const { page, asks, events } = await half.page('slack')
    expect(page.steps.map((one) => [one.id, one.done])).toEqual([
      ['make', false],
      ['keep', false],
      ['deliveries', false],
      ['install', false],
    ])
    expect(asks.map((one) => one.what)).toContain('app_mentions:read')
    expect(events).toEqual(['app_mention'])
    expect(slack.calls).toEqual([])
  })

  it('makes the app from a manifest with the doorbell’s address, or with none', () => {
    const { half } = window({ slack: slackScript({ base: 0 }) })
    const want = {
      home: 'https://tade.example.com',
      hook: 'https://tade.example.com/hooks/slack',
      made: '',
      installed: '',
      state: '',
      name: 'Tade vps',
    }
    const made = new URL(half.form('slack', want).url)
    const manifest = JSON.parse(made.searchParams.get('manifest_json') ?? '{}')
    expect(manifest.settings.event_subscriptions.request_url).toBe(want.hook)
    const none = new URL(
      half.form('slack', { ...want, hook: null, home: 'http://localhost:1' }).url,
    )
    expect(JSON.parse(none.searchParams.get('manifest_json') ?? '{}').settings).not.toHaveProperty(
      'event_subscriptions',
    )
  })

  it('keeps what was pasted through the one write path, each as connecting Slack, a secret said as set', async () => {
    const { half, wrote, config } = window({ slack: slackScript({ base: 0 }) })
    const answer = await half.keep('slack', {
      signing_secret: SIGNING,
      client_id: '1234.5678',
      client_secret: SECRET,
    })
    expect(answer).toEqual({ kept: ['the signing secret', 'the client id', 'the client secret'] })
    expect(wrote.map((one) => [one.key, one.was, one.by])).toEqual([
      ['extensions.intake.slack_signing_secret', 'not set', SLACK_CONNECTED_BY],
      ['extensions.intake.slack_client_id', '', SLACK_CONNECTED_BY],
      ['extensions.intake.slack_client_secret', 'not set', SLACK_CONNECTED_BY],
    ])
    expect(config().extensions.intake).toMatchObject({
      slack_signing_secret: SIGNING,
      slack_client_id: '1234.5678',
      slack_client_secret: SECRET,
    })
    // Kept again, a credential that was there is said as set, never as itself.
    await half.keep('slack', { signing_secret: 't'.repeat(32) })
    expect(wrote.at(-1)?.was).toBe('set')
  })

  it('says where a variable here wins over what was kept', async () => {
    const { half } = window({
      slack: slackScript({ base: 0 }),
      env: { SLACK_BOT_TOKEN: 'xoxb-env' },
    })
    expect(await half.keep('slack', { token: 'xoxb-pasted-here-1' })).toEqual({
      kept: ['the bot token (though $SLACK_BOT_TOKEN wins over it here)'],
    })
  })

  it('installs with OAuth to the public name only once the client is kept', () => {
    expect(window().half.installUrl('slack', 's', 'https://tade.example.com', null)).toBeNull()
    const { half } = window({ intake: kept })
    const url = new URL(half.installUrl('slack', 's-1', 'https://tade.example.com', null) ?? '')
    expect(url.searchParams.get('client_id')).toBe('1234.5678')
    expect(url.searchParams.get('redirect_uri')).toBe(install.redirect)
    expect(url.searchParams.get('state')).toBe('s-1')
  })

  it('exchanges the code that came back for the token, keeps it, and then reads as installed', async () => {
    const slack = slackScript({ base: 0, install })
    const { half, wrote, config } = window({
      intake: { ...kept, slack_signing_secret: SIGNING },
      slack,
    })
    const back = { code: 'c0de', error: null, home: 'https://tade.example.com' }
    expect(await half.installed('slack', back)).toEqual({ where: 'Acme' })
    expect(wrote).toEqual([
      {
        key: 'extensions.intake.slack_token',
        value: install.token,
        was: 'not set',
        by: SLACK_CONNECTED_BY,
      },
    ])
    expect(config().extensions.intake?.slack_token).toBe(install.token)
    const { page } = await half.page('slack')
    const step = page.steps.find((one) => one.id === 'install')
    expect(step?.done).toBe(true)
    expect(step?.said).toContain('installed in Acme as @tade')
  })

  it('keeps nothing where Slack said no, or would not take the code, and says which', async () => {
    const slack = slackScript({ base: 0, install })
    const { half, wrote } = window({ intake: kept, slack })
    const home = 'https://tade.example.com'
    expect(await half.installed('slack', { code: null, error: 'access_denied', home })).toEqual({
      problem: expect.stringContaining('access_denied'),
    })
    expect(await half.installed('slack', { code: 'guessed', error: null, home })).toEqual({
      problem: expect.stringContaining('invalid_code'),
    })
    expect(await half.installed('slack', { code: null, error: null, home })).toEqual({
      problem: expect.stringContaining('no code'),
    })
    // An error that is not one of Slack's words is never drawn.
    expect(
      await half.installed('slack', { code: null, error: '<script>alert(1)</script>', home }),
    ).toEqual({ problem: expect.not.stringContaining('<script>') })
    expect(wrote).toEqual([])
  })

  it('says a token Slack no longer takes is to be installed again', async () => {
    const slack = slackScript({ base: 0, install })
    const { half } = window({ intake: { ...kept, slack_token: 'xoxb-revoked-long' }, slack })
    const { page } = await half.page('slack')
    expect(page.steps.find((one) => one.id === 'install')?.said).toContain('no longer good')
  })
})

describe('connecting Linear, as the window does it', () => {
  // Everything about Linear is asked of the Linear door over its one client
  // (`@tade/extension-intake`'s `linear-app.ts`), against a Linear that answers
  // from a file and checks a code's verifier and redirect, and every `Bearer`
  // token, as Linear does; its tokens are the window's holder's
  // (`linear-tokens.ts`), one of its own here.
  const CLIENT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
  const SIGNING = 'lin_wh_abcdefghijklmnopqrstuvwxyz0123456789'
  const VERIFIER = 'v'.repeat(43)
  const HOME = 'https://tade.example.com'
  const oauth = (over: Record<string, { challenge: string; redirect: string }> = {}) =>
    linearScript({
      base: 0,
      oauth: {
        clientId: CLIENT,
        codes: {
          c0de: { challenge: challengeOf(VERIFIER), redirect: `${HOME}/connect/linear/installed` },
          ...over,
        },
        workspace: 'Acme',
        user: 'kim',
      },
    })

  it('starts at making the app, says what it asks Linear for, and asks Linear nothing', async () => {
    const linear = oauth()
    const { half } = window({ linear })
    const { page, asks, events } = await half.page('linear')
    expect(page.steps.map((one) => [one.id, one.done])).toEqual([
      ['make', false],
      ['keep', false],
      ['install', false],
      ['deliveries', false],
    ])
    expect(asks.map((one) => one.what)).toEqual(['read'])
    expect(events).toEqual(['Issue', 'Comment'])
    expect(linear.calls).toEqual([])
    expect(linear.oauth?.calls).toEqual([])
  })

  it('makes the app from a manifest with the doorbell’s address, or with none', () => {
    const { half } = window({ linear: oauth() })
    const want = {
      home: HOME,
      hook: `${HOME}/hooks/linear`,
      made: '',
      installed: '',
      state: '',
      name: 'Tade vps',
    }
    const manifest = (url: string) =>
      JSON.parse(new URL(url).searchParams.get('manifest') ?? '{}') as {
        webhook?: { url: string }
        oauth: { redirect_uris: string[] }
      }
    expect(manifest(half.form('linear', want).url).webhook?.url).toBe(want.hook)
    const none = manifest(
      half.form('linear', { ...want, hook: null, home: 'http://localhost:1' }).url,
    )
    expect(none).not.toHaveProperty('webhook')
    expect(none.oauth.redirect_uris).toEqual(['http://localhost:1/connect/linear/installed'])
  })

  it('keeps the client id and the signing secret, each as connecting Linear, the secret said as set', async () => {
    const { half, wrote, config } = window({ linear: oauth() })
    expect(await half.keep('linear', { client_id: CLIENT, signing_secret: SIGNING })).toEqual({
      kept: ['the client id', 'the webhook’s signing secret'],
    })
    expect(wrote.map((one) => [one.key, one.was, one.by])).toEqual([
      ['extensions.intake.linear_client_id', '', LINEAR_CONNECTED_BY],
      ['extensions.intake.linear_webhook_secret', 'not set', LINEAR_CONNECTED_BY],
    ])
    expect(config().extensions.intake).toMatchObject({
      linear_client_id: CLIENT,
      linear_webhook_secret: SIGNING,
    })
    // What Slack's page takes is not Linear's to keep.
    expect(await half.keep('linear', { token: 'xoxb-1-2-3' })).toEqual({
      problem: 'nothing was pasted that Linear’s page asks for',
    })
  })

  it('connects only with a proof key, once the client id is kept', () => {
    expect(window().half.installUrl('linear', 's', HOME, 'c')).toBeNull()
    const { half } = window({ intake: { linear_client_id: CLIENT } })
    expect(half.installUrl('linear', 's', HOME, null)).toBeNull()
    const url = new URL(half.installUrl('linear', 's-1', HOME, 'chal') ?? '')
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('redirect_uri')).toBe(`${HOME}/connect/linear/installed`)
  })

  it('exchanges the code with its verifier, keeps the refresh token, and then reads as connected', async () => {
    const linear = oauth()
    const { half, wrote, config } = window({ intake: { linear_client_id: CLIENT }, linear })
    const back = { code: 'c0de', error: null, home: HOME, verifier: VERIFIER }
    expect(await half.installed('linear', back)).toEqual({ where: 'Acme' })
    expect(wrote).toEqual([
      {
        key: 'extensions.intake.linear_refresh_token',
        value: 'lin_refresh_1',
        was: 'not set',
        by: LINEAR_CONNECTED_BY,
      },
    ])
    // The access token is held in this window, never written.
    expect(JSON.stringify(config())).not.toContain('lin_oauth_access')
    const { page } = await half.page('linear')
    const step = page.steps.find((one) => one.id === 'install')
    expect(step?.done).toBe(true)
    expect(step?.said).toContain('connected to Acme as kim')
    // Read with the token it was just handed: no refresh.
    expect(linear.oauth?.calls.map((one) => one.form.grant_type)).toEqual(['authorization_code'])
  })

  it('keeps nothing where Linear said no, a code came with no verifier, or Linear would not take it', async () => {
    const linear = oauth()
    const { half, wrote } = window({ intake: { linear_client_id: CLIENT }, linear })
    const at = { home: HOME, verifier: VERIFIER }
    expect(await half.installed('linear', { ...at, code: null, error: 'access_denied' })).toEqual({
      problem: expect.stringContaining('access_denied'),
    })
    expect(
      await half.installed('linear', { ...at, code: 'c0de', error: null, verifier: null }),
    ).toEqual({ problem: expect.stringContaining('no proof key') })
    expect(
      await half.installed('linear', {
        ...at,
        code: 'c0de',
        error: null,
        verifier: 'w'.repeat(43),
      }),
    ).toEqual({ problem: expect.stringContaining('invalid_grant') })
    expect(await half.installed('linear', { ...at, code: null, error: null })).toEqual({
      problem: expect.stringContaining('no code'),
    })
    expect(
      await half.installed('linear', { ...at, code: null, error: '<script>alert(1)</script>' }),
    ).toEqual({ problem: expect.not.stringContaining('<script>') })
    expect(wrote).toEqual([])
  })

  it('says a refresh token Linear no longer takes is to be connected again', async () => {
    const linear = oauth()
    const { half } = window({
      intake: { linear_client_id: CLIENT, linear_refresh_token: 'lin_refresh_spent' },
      linear,
    })
    const { page } = await half.page('linear')
    const step = page.steps.find((one) => one.id === 'install')
    expect(step?.done).toBe(false)
    expect(step?.said).toContain('connect it again')
  })
})
