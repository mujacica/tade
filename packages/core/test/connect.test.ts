import { describe, expect, it } from 'vitest'
import {
  CONNECT_FLOWS,
  CONNECT_SOURCES,
  type GithubLook,
  githubPage,
  QUIET_MS,
  type SlackLook,
  slackPage,
} from '../src/connect.ts'

// GitHub's guided page as a fold over a look (REMOTE-TADE §6.4): a step is
// done when what it is for is true now, never because somebody once pressed
// it, and each says one line with at most one press.

const NOW = Date.parse('2026-10-17T14:00:00Z')

const look = (over: Partial<GithubLook> = {}): GithubLook => ({
  publicName: 'tade.example.com',
  app: { id: '4242', slug: 'tade-vps' },
  installed: [{ account: 'acme', repositories: 3 }],
  secret: true,
  heard: { verified: NOW - 60_000, refused: null },
  ...over,
})

const step = (page: ReturnType<typeof githubPage>, id: string) =>
  page.steps.find((one) => one.id === id)

describe('GitHub’s page', () => {
  it('starts with one press, making the App, and says it may only read', () => {
    const page = githubPage(
      look({ app: null, installed: null, secret: false, heard: { verified: null, refused: null } }),
      NOW,
    )
    expect(page.steps.map((one) => [one.id, one.done])).toEqual([
      ['make', false],
      ['install', false],
      ['deliveries', false],
    ])
    expect(step(page, 'make')?.press).toMatchObject({ act: 'make', label: 'Make it on GitHub' })
    // The name and the organisation are boxes on the press, named for GitHub.
    expect(step(page, 'make')?.press?.fields?.map((one) => one.name)).toEqual([
      'name',
      'organisation',
    ])
    expect(step(page, 'make')?.press?.fields?.[0]?.placeholder).toBe('Tade tade')
    expect(page.writes).toContain('writes anything')
    expect(step(page, 'make')?.said).toContain('write nothing anywhere')
    expect(step(page, 'install')?.press).toBeUndefined()
    expect(step(page, 'deliveries')?.said).toContain('https://tade.example.com/hooks/github')
  })

  it('ticks all three where the App is kept, installed and heard from within the day', () => {
    const page = githubPage(look(), NOW)
    expect(page.steps.every((one) => one.done)).toBe(true)
    expect(step(page, 'install')?.said).toBe('installed on 3 repositories of acme')
    expect(step(page, 'install')?.press?.label).toBe('Change repositories')
    expect(step(page, 'make')?.press?.label).toBe('Make another')
  })

  it('reads installed nowhere, or on no repository, as not installed', () => {
    for (const installed of [[], [{ account: 'acme', repositories: 0 }]] as const) {
      const page = githubPage(look({ installed }), NOW)
      expect(step(page, 'install')?.done).toBe(false)
      expect(step(page, 'install')?.press?.label).toBe('Install it on GitHub')
    }
    expect(
      step(
        githubPage(look({ installed: [{ account: 'me', repositories: 'all' }] }), NOW),
        'install',
      )?.said,
    ).toBe('installed on every repository of me')
  })

  it('says GitHub could not be asked rather than that it is installed nowhere', () => {
    const page = githubPage(look({ installed: { problem: 'github.com answered 502' } }), NOW)
    expect(step(page, 'install')?.done).toBe(false)
    expect(step(page, 'install')?.said).toContain('could not be asked')
    expect(step(page, 'install')?.said).toContain('502')
  })

  it('offers no install press without a slug to address the App by', () => {
    const page = githubPage(look({ app: { id: '4242', slug: null }, installed: [] }), NOW)
    expect(step(page, 'install')?.press).toBeUndefined()
  })

  it('says a machine with no public name polls, and offers nothing it cannot do', () => {
    const page = githubPage(look({ publicName: null }), NOW)
    const deliveries = step(page, 'deliveries')
    expect(deliveries?.done).toBe(false)
    expect(deliveries?.said).toContain('no public name')
    expect(deliveries?.press).toBeUndefined()
  })

  it('reads the newest of a verified delivery and a refused one, as a schedule’s bell does', () => {
    const refused = githubPage(
      look({ heard: { verified: NOW - 120_000, refused: NOW - 60_000 } }),
      NOW,
    )
    expect(step(refused, 'deliveries')?.done).toBe(false)
    expect(step(refused, 'deliveries')?.said).toContain('did not verify')
    const since = githubPage(
      look({ heard: { verified: NOW - 60_000, refused: NOW - 120_000 } }),
      NOW,
    )
    expect(step(since, 'deliveries')?.done).toBe(true)
  })

  it('says a hook that has gone quiet for a day is quiet, not working', () => {
    const page = githubPage(look({ heard: { verified: NOW - QUIET_MS - 1, refused: null } }), NOW)
    expect(step(page, 'deliveries')?.done).toBe(false)
    expect(step(page, 'deliveries')?.said).toContain('nothing for over a day')
  })

  it('says an App kept with no secret for its deliveries refuses each one', () => {
    const page = githubPage(look({ secret: false, heard: { verified: null, refused: null } }), NOW)
    expect(step(page, 'deliveries')?.said).toContain('no secret is kept')
  })
})

// Slack's page (REMOTE-TADE §6.3): make the app from a manifest, keep its
// signing secret before Slack checks the address, then install it with OAuth
// v2 — and with no public name, made with no address, installed from its own
// page and its token kept by hand, which is the poll's path.

const slackLook = (over: Partial<SlackLook> = {}): SlackLook => ({
  publicName: 'tade.example.com',
  kept: { clientId: '1234.5678', clientSecret: true, signingSecret: true, token: true },
  installed: { team: 'Acme', user: 'tade-vps' },
  heard: { verified: NOW - 60_000, refused: null },
  ...over,
})

const NOTHING: SlackLook['kept'] = {
  clientId: null,
  clientSecret: false,
  signingSecret: false,
  token: false,
}

describe('Slack’s page', () => {
  it('starts with making the app, then the signing secret, before anything else', () => {
    const page = slackPage(
      slackLook({ kept: NOTHING, installed: null, heard: { verified: null, refused: null } }),
    )
    expect(page.steps.map((one) => [one.id, one.done])).toEqual([
      ['make', false],
      ['keep', false],
      ['deliveries', false],
      ['install', false],
    ])
    expect(step(page, 'make')?.press?.act).toBe('make')
    const keep = step(page, 'keep')
    expect(keep?.press?.act).toBe('keep')
    expect(keep?.press?.fields?.map((one) => [one.name, one.secret])).toEqual([
      ['signing_secret', true],
      ['client_id', false],
      ['client_secret', true],
    ])
    expect(keep?.said).toContain('before anything else')
    // Slack's check of the address is answered only once the secret is here.
    expect(step(page, 'deliveries')?.said).toContain('once its signing secret is kept')
    // Nothing to install with until the client is kept.
    expect(step(page, 'install')?.press).toBeUndefined()
    expect(page.writes).toContain('unless you turn reply on')
  })

  it('asks for Retry once the secret is kept and Slack has not checked yet', () => {
    const page = slackPage(
      slackLook({
        installed: null,
        kept: { ...NOTHING, signingSecret: true, clientId: '1.2', clientSecret: true },
        heard: { verified: null, refused: null },
      }),
    )
    expect(step(page, 'deliveries')?.done).toBe(false)
    expect(step(page, 'deliveries')?.said).toContain(
      'press Retry beside https://tade.example.com/hooks/slack',
    )
    expect(step(page, 'install')?.press).toEqual({ act: 'install', label: 'Install it on Slack' })
  })

  it('ticks every step where the app is kept, verified and installed, and says what is next', () => {
    const page = slackPage(slackLook())
    expect(page.steps.every((one) => one.done)).toBe(true)
    expect(step(page, 'install')?.said).toContain('installed in Acme as @tade-vps')
    expect(step(page, 'install')?.said).toContain('/invite @tade-vps')
    expect(step(page, 'make')?.press?.label).toBe('Make another')
    expect(step(page, 'keep')?.press?.label).toBe('Replace them')
  })

  it('says a delivery that did not verify is the wrong secret, and never goes quiet', () => {
    const wrong = slackPage(
      slackLook({ heard: { verified: NOW - 120_000, refused: NOW - 60_000 } }),
    )
    expect(step(wrong, 'deliveries')?.done).toBe(false)
    expect(step(wrong, 'deliveries')?.said).toContain('not the app’s')
    // A channel nobody mentioned Tade in for a week is quiet, not broken.
    const quiet = slackPage(slackLook({ heard: { verified: NOW - 7 * QUIET_MS, refused: null } }))
    expect(step(quiet, 'deliveries')?.done).toBe(true)
  })

  it('says a token Slack refused is to be installed again, and one it could not be asked about is not', () => {
    const refused = slackPage(
      slackLook({ installed: { problem: 'auth.test: token_revoked', refused: true } }),
    )
    expect(step(refused, 'install')?.done).toBe(false)
    expect(step(refused, 'install')?.said).toContain('no longer good')
    expect(step(refused, 'install')?.press?.label).toBe('Install it again')
    const away = slackPage(
      slackLook({ installed: { problem: 'slack.com did not answer', refused: false } }),
    )
    expect(step(away, 'install')?.said).toContain('could not be asked')
  })

  it('with no public name makes the app with no address, and keeps its token by hand', () => {
    const page = slackPage(
      slackLook({
        publicName: null,
        kept: NOTHING,
        installed: null,
        heard: { verified: null, refused: null },
      }),
    )
    expect(page.steps.map((one) => one.id)).toEqual(['make', 'install', 'deliveries'])
    expect(step(page, 'make')?.said).toContain('its watch polls')
    const install = step(page, 'install')
    expect(install?.press).toMatchObject({ act: 'keep', label: 'Keep it' })
    expect(install?.press?.fields).toEqual([
      { name: 'token', label: 'Bot User OAuth Token', secret: true },
    ])
    expect(install?.said).toContain('Install to Workspace')
    expect(step(page, 'deliveries')?.said).toContain('a mention inside a thread is seen only')
    const kept = slackPage(slackLook({ publicName: null }))
    expect(step(kept, 'install')?.done).toBe(true)
    expect(step(kept, 'make')?.done).toBe(true)
  })
})

describe('what each source’s page may be asked', () => {
  it('has a back only after a press that has one, and Slack’s only to a public name', () => {
    for (const source of CONNECT_SOURCES) {
      const flow = CONNECT_FLOWS[source]
      if (flow.backs.includes('made')) expect(flow.presses).toContain('make')
      if (flow.backs.includes('installed')) expect(flow.presses).toContain('install')
      expect(flow.goes.length).toBeGreaterThan(0)
    }
    expect(CONNECT_FLOWS.slack).toMatchObject({ backs: ['installed'], publicBack: true })
    expect(CONNECT_FLOWS.github.presses).not.toContain('keep')
  })
})
