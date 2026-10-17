import { describe, expect, it } from 'vitest'
import { type GithubLook, githubPage, QUIET_MS } from '../src/connect.ts'

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
    expect(step(page, 'make')?.press).toEqual({ act: 'make', label: 'Make it on GitHub' })
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
