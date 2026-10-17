import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { slackScript } from '../../../../test/fixtures/slack/slack.ts'
import { SlackError } from '../src/slack-api.ts'
import {
  slackAsks,
  slackInstalled,
  slackInstallUrl,
  slackMakeUrl,
  slackManifest,
  slackRedirect,
  slackWho,
} from '../src/slack-app.ts'

// The Slack app Connect Slack asks the person to make (REMOTE-TADE §6.3): the
// manifest, the addresses a browser is sent to, and an install's code
// exchanged for its token over the one Slack client, against a Slack that
// answers from a file. What the page and the window do with it is
// `web/test/connected.test.ts` and `app/test/wire/web-connect.test.ts`.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Slack app tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const HOME = 'https://tade.example.com'

/** The manifest, as the parts these tests read are shaped. */
interface Manifest {
  display_information: { name: string }
  features: { bot_user: { display_name: string } }
  oauth_config: { redirect_urls?: string[]; scopes: { bot: string[] } }
  settings: { event_subscriptions?: unknown; socket_mode_enabled: boolean }
}
const manifest = (want: Parameters<typeof slackManifest>[0]) =>
  slackManifest(want) as unknown as Manifest

describe('the manifest', () => {
  it('delivers mentions to the doorbell and comes back to the public name, over HTTP', () => {
    const made = manifest({ name: 'Tade vps', home: HOME })
    expect(made.settings).toEqual({
      event_subscriptions: { request_url: `${HOME}/hooks/slack`, bot_events: ['app_mention'] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    })
    expect(made.oauth_config.redirect_urls).toEqual([`${HOME}/connect/slack/installed`])
    expect(made.oauth_config.scopes.bot).toEqual([
      'app_mentions:read',
      'channels:history',
      'groups:history',
      'chat:write',
      'reactions:write',
    ])
    // A handle Slack takes: lower case, no spaces.
    expect(made.features.bot_user.display_name).toBe('tade-vps')
    expect(made.display_information.name).toBe('Tade vps')
  })

  it('is made with no address, nothing delivered and nothing to come back to, with no public name', () => {
    const made = manifest({ name: 'Tade', home: null })
    expect(made.settings.event_subscriptions).toBeUndefined()
    expect(made.oauth_config.redirect_urls).toBeUndefined()
    expect(made.oauth_config.scopes.bot).not.toContain('app_mentions:read')
    expect(made.settings.socket_mode_enabled).toBe(false)
  })

  it('says why it asks for each scope, the two that write only once reply is on', () => {
    for (const one of slackAsks(true)) expect(one.why.length).toBeGreaterThan(10)
    const writes = slackAsks(true).filter((one) => one.what.endsWith(':write'))
    expect(writes.map((one) => one.what)).toEqual(['chat:write', 'reactions:write'])
    for (const one of writes) expect(one.why).toContain('reply')
  })

  it('cuts a name to Slack’s 35, and never leaves it empty', () => {
    const long = manifest({ name: 'x'.repeat(60), home: null })
    expect(long.display_information.name).toHaveLength(35)
    const none = manifest({ name: '  ', home: null })
    expect(none.display_information.name).toBe('Tade')
  })
})

describe('where a browser is sent', () => {
  it('makes the app on Slack’s own page with the manifest filled in', () => {
    const url = new URL(slackMakeUrl({ name: 'Tade', home: HOME }))
    expect(url.origin).toBe('https://api.slack.com')
    expect(url.searchParams.get('new_app')).toBe('1')
    expect(JSON.parse(url.searchParams.get('manifest_json') ?? '')).toEqual(
      slackManifest({ name: 'Tade', home: HOME }),
    )
  })

  it('installs with OAuth v2, coming back to the public name with the word', () => {
    const url = new URL(slackInstallUrl({ clientId: '1234.5678', home: HOME, state: 'w0rd' }))
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1234.5678',
      scope: 'app_mentions:read,channels:history,groups:history,chat:write,reactions:write',
      redirect_uri: slackRedirect(HOME),
      state: 'w0rd',
    })
  })
})

describe('an install’s code', () => {
  const install = {
    clientId: '1234.5678',
    clientSecret: 'c'.repeat(32),
    code: 'c0de',
    redirect: slackRedirect(HOME),
    token: 'xoxb-1-2-made',
  }
  const from = (script: ReturnType<typeof slackScript>) => ({
    fetch: script.fetch,
    signal: new AbortController().signal,
  })

  it('is exchanged once for the bot token, with the client and no token, and says who it is', async () => {
    const script = slackScript({ base: 0, install })
    const got = await slackInstalled(from(script), {
      clientId: install.clientId,
      clientSecret: install.clientSecret,
      code: 'c0de',
      home: HOME,
    })
    expect(got).toEqual({ token: 'xoxb-1-2-made', team: 'Acme', user: 'tade' })
    expect(script.methods()).toEqual(['oauth.v2.access', 'auth.test'])
    expect(script.calls[0]?.form).toEqual({
      client_id: install.clientId,
      client_secret: install.clientSecret,
      code: 'c0de',
      redirect_uri: install.redirect,
    })
  })

  it('throws Slack’s own word where it says no, and keeps nothing', async () => {
    for (const [asked, word] of [
      [{ code: 'guessed' }, 'invalid_code'],
      [{ clientSecret: 'w'.repeat(32) }, 'bad_client_secret'],
      [{ home: 'https://elsewhere.example' }, 'bad_redirect_uri'],
    ] as const) {
      const script = slackScript({ base: 0, install })
      const failed = slackInstalled(from(script), {
        clientId: install.clientId,
        clientSecret: install.clientSecret,
        code: 'c0de',
        home: HOME,
        ...asked,
      })
      await expect(failed).rejects.toBeInstanceOf(SlackError)
      await expect(failed).rejects.toThrow(word)
      expect(script.methods()).toEqual(['oauth.v2.access'])
    }
  })

  it('asks who a kept token is, and says Slack refused one it no longer takes', async () => {
    const script = slackScript({ base: 0, install })
    expect(await slackWho(from(script), install.token)).toEqual({ team: 'Acme', user: 'tade' })
    await expect(slackWho(from(script), 'xoxb-revoked')).rejects.toMatchObject({
      trouble: 'auth',
    })
  })
})
