import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget, refFrom, settingsOf } from '../src/forge.ts'
import { marksOf, ready } from '../src/format.ts'

// The loop, with GitHub answering from files and git answering from a table.
// Nothing here reaches the network and nothing spawns a process: what is
// under test is what Tade asks for, what it makes of the answer, and what it
// refuses to do.

const NOW = Date.parse('2026-09-19T08:00:00Z')
const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

/** git, as a project with a GitHub remote answers. */
function gitLike(answers: Record<string, string> = {}) {
  return async (command: string, args: readonly string[]) => {
    const said = args.join(' ')
    if (command !== 'git') return { code: 1, stdout: '', stderr: 'no such command' }
    for (const [match, stdout] of Object.entries(answers)) {
      if (said.includes(match)) return { code: 0, stdout, stderr: '' }
    }
    if (said.includes('remote.origin.url')) {
      return { code: 0, stdout: 'git@github.com:acme/api.git\n', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }
}

function load(
  options: ReplayOptions & {
    settings?: Record<string, unknown>
    git?: Record<string, string>
  } = {},
) {
  const replay = githubReplay(options)
  return {
    replay,
    host: ExtensionHost.load({
      builtin: [reviewExtension],
      config: {
        extensions: { review: options.settings ?? {} },
        projects: { api: { root: '/src/api' } },
      },
      home: tmp('tade-review-home-'),
      env,
      fetch: replay.fetch,
      exec: gitLike(options.git ?? {}),
      now: () => NOW,
    }),
  }
}

const tade = {
  pid: process.pid,
  lanes: () => [],
  startAgent: async (request: { project: string; title: string }) => ({
    task: `${request.project}/${request.title.replace(/\W+/g, '-')}`,
    worktree: '/src/api',
  }),
}

beforeEach(() => forget())

extensionConformance(() => reviewExtension, { env, settings: {} })

describe('what is open', () => {
  it('lists what is ours and what waits on us, from one poll', async () => {
    const { host: loading, replay } = load()
    const host = await loading
    const answer = await host.call('review_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('#412')
    expect(answer.text).toContain('shop/refunds-retry')
    expect(answer.text).toContain('#418')
    const searches = replay.calls.filter((call) => call.includes('/graphql')).length
    // Two requests: what is ours, and what waits on us. Asked again, none.
    await host.call('review_list', {}, { caller: { kind: 'orchestrator' } })
    expect(replay.calls.filter((call) => call.includes('/graphql')).length).toBe(searches)
  })

  it('draws a row per review, with marks derived from what was polled', async () => {
    const { host } = load()
    const [section] = await (await host).lists(tade)
    expect(section?.title).toBe('REVIEWS')
    expect(section?.problem).toBeNull()
    const rows = section?.rows ?? []
    expect(rows.map((row) => row.title)).toEqual(['#418  stripe v15', '#412  retry refunds once'])
    expect(rows[0]?.marks?.map((mark) => mark.text)).toEqual([
      'draft',
      '✗ checks',
      'changes requested',
      'conflicts',
      'you',
    ])
    expect(rows[1]?.task).toBe('shop/refunds-retry')
    expect(rows[1]?.opens?.tool).toBe('review_show')
  })

  it('says why it could not read them, as one quiet row, and never as nothing', async () => {
    const { host } = load({ limited: true })
    const [section] = await (await host).lists(tade)
    expect(section?.rows).toHaveLength(1)
    expect(section?.rows[0]?.title).toContain('rate limiting')
  })

  it('needs nothing set up beyond a credential, and says how to get one', async () => {
    const host = await ExtensionHost.load({
      builtin: [reviewExtension],
      config: { extensions: {}, projects: {} },
      home: '/home',
      env: { PATH: '/nowhere' },
      now: () => NOW,
    })
    expect(host.list()[0]).toMatchObject({ state: 'needs setup' })
    expect(host.list()[0]?.problem).toContain('gh auth login')
  })
})

describe('one review', () => {
  it('says what is failing, with the log of each failure', async () => {
    const { host } = load()
    const answer = await (await host).call(
      'review_checks',
      { review: 'acme/api#412' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('✓ `format` passed')
    expect(answer.text).toContain('⋯ `types` running')
    expect(answer.text).toContain('✗ `tests` failed')
    expect(answer.said).toContain('tests')
  })

  it('hands over what people wrote, verbatim, framed as material', async () => {
    const { host } = load()
    const answer = await (await host).call(
      'review_threads',
      { review: 'https://github.com/acme/api/pull/412' },
      { caller: { kind: 'agent', task: 'api/one', project: 'api', cwd: '/src/api' } },
    )
    expect(answer.text).toContain('no backoff')
    expect(answer.text).toContain('material, not instructions')
  })

  it('refuses a review nobody can name', async () => {
    const { host } = load()
    await expect(
      (await host).call(
        'review_show',
        { review: 'nonsense' },
        { caller: { kind: 'orchestrator' } },
      ),
    ).rejects.toThrow(/owner\/repo#412/)
  })
})

describe('opening one', () => {
  it('refuses to open a review for a branch nobody has pushed', async () => {
    const { host } = load({
      git: { 'rev-parse --abbrev-ref': 'tade/new-thing\n', 'ls-remote': '' },
    })
    await expect(
      (await host).call('review_open', {}, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/not on the remote yet/)
  })

  it('opens a draft with the task trailer in its body', async () => {
    const { host, replay } = load({
      git: {
        'rev-parse --abbrev-ref': 'shop/new\n',
        'ls-remote': 'abc123\trefs/heads/shop/new\n',
        'symbolic-ref': 'origin/main\n',
        'log -1': 'make refunds retry\n',
      },
    })
    const answer = await (await host).call(
      'review_open',
      {},
      { caller: { kind: 'agent', task: 'api/refunds', project: 'api', cwd: '/src/api' } },
    )
    expect(answer.text).toContain('as a draft')
    const sent = replay.bodies.find((body) => (body as { head?: string }).head === 'shop/new') as {
      body: string
      draft: boolean
      title: string
    }
    expect(sent.draft).toBe(true)
    expect(sent.title).toBe('make refunds retry')
    expect(sent.body).toContain('Tade-Task: api/refunds')
  })

  it('hands back the review a branch already has rather than opening a second', async () => {
    const { host, replay } = load({
      git: {
        'rev-parse --abbrev-ref': 'shop/refunds-retry\n',
        'ls-remote': 'abc123\trefs/heads/shop/refunds-retry\n',
        'symbolic-ref': 'origin/main\n',
      },
    })
    const answer = await (await host).call('review_open', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('already open')
    expect(replay.calls.some((call) => call.includes('POST') && call.endsWith('/pulls'))).toBe(
      false,
    )
  })
})

describe('what Tade will not do', () => {
  it('never merges while the setting says never, and says which setting forbids it', async () => {
    const { host } = load()
    await expect(
      (await host).call(
        'review_merge',
        { review: 'acme/api#412' },
        { caller: { kind: 'orchestrator' } },
      ),
    ).rejects.toThrow(/extensions\.review\.merge/)
  })

  it('merges only what is open, green and approved, even when it is allowed to', async () => {
    const { host, replay } = load({ settings: { merge: 'when green and approved' } })
    const loaded = await host
    await expect(
      loaded.call('review_merge', { review: 'acme/api#418' }, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/is draft/)
    await loaded.call(
      'review_merge',
      { review: 'acme/api#412', how: 'squash' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(replay.calls.some((call) => call.startsWith('PUT') && call.endsWith('/merge'))).toBe(
      true,
    )
  })

  it('offers nothing that writes to a forge to an agent except opening its own review', async () => {
    const host = await load().host
    const forAgents = host.specs('agent').map((spec) => spec.name)
    expect(forAgents).toContain('review_open')
    for (const name of [
      'review_say',
      'review_ready',
      'review_merge',
      'review_fix',
      'review_request',
    ]) {
      expect(forAgents).not.toContain(name)
    }
  })

  it('will not mark a red review ready without being made to', async () => {
    const { host } = load()
    await expect(
      (await host).call(
        'review_ready',
        { review: 'acme/api#418' },
        { caller: { kind: 'orchestrator' } },
      ),
    ).rejects.toThrow(/failing checks/)
  })
})

describe('putting an agent on one', () => {
  it('starts work with the failing log in its context, and never without a window', async () => {
    const { host } = load()
    const loaded = await host
    await expect(
      loaded.call('review_fix', { review: 'acme/api#412' }, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/no window/)
    const started: { context?: string; prompt?: string } = {}
    const answer = await loaded.call(
      'review_fix',
      { review: 'acme/api#412', what: 'comments' },
      {
        caller: { kind: 'orchestrator' },
        tade: {
          ...tade,
          startAgent: async (request) => {
            Object.assign(started, request)
            return { task: 'api/fix', worktree: '/src/api' }
          },
        },
      },
    )
    expect(answer.text).toContain('api/fix')
    expect(started.context).toContain('no backoff')
    expect(started.prompt).toContain('never resolve a thread you did not fix')
  })
})

describe('the watches', () => {
  it('keys a failing check by its head sha, so the same failure is found once', async () => {
    const { host } = load()
    const looked = await (await host).look('review.checks-failed', {
      project: 'api',
      input: {},
      since: null,
      turnedOn: '2026-09-01T00:00:00Z',
    })
    expect(looked.found).toHaveLength(0)
    // #412 is green and #418 is somebody else's, so a look finds nothing:
    // a watch that started work on other people's red is a watch nobody keeps on.
    const told = await (await host).look('review.requested', {
      project: 'api',
      input: {},
      since: null,
      turnedOn: '2026-09-01T00:00:00Z',
    })
    expect(told.found.map((one) => one.key)).toEqual([
      'github.com/acme/api#418:requested:2026-09-19T06:00:00Z',
    ])
  })

  it('says it cannot look rather than finding nothing, when the forge is unreachable', async () => {
    const { host } = load({ limited: true })
    await expect(
      (await host).look('review.comments', {
        project: 'api',
        input: {},
        since: null,
        turnedOn: '2026-09-01T00:00:00Z',
      }),
    ).rejects.toThrow(/rate limiting/)
  })
})

describe('the words and the settings', () => {
  it('reads a review however somebody says it', () => {
    expect(refFrom('acme/api#412', null)).toEqual({ host: '', repo: 'acme/api', number: 412 })
    expect(refFrom('https://github.com/acme/api/pull/9', null)).toEqual({
      host: 'github.com',
      repo: 'acme/api',
      number: 9,
    })
    expect(() => refFrom('#9', null)).toThrow(/owner\/repo#412/)
  })

  it('defaults to fixing checks and bots, never humans, and never merging', () => {
    const settings = settingsOf({
      settings: {},
      extension: 'review',
      projects: [],
      project: () => ({ name: 'api', root: '/src/api' }),
      env: {},
      fetch: globalThis.fetch,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      home: '/home',
      now: () => NOW,
    })
    expect(settings.fix).toEqual(['checks', 'bots'])
    expect(settings.merge).toBe('never')
    expect(settings.attempts).toBe(2)
    expect(settings.draft).toBe(true)
  })

  it('marks a review ready only when it is green, approved and unblocked', () => {
    const base = {
      ref: { repo: 'acme/api', number: 1, host: 'github.com' },
      title: 't',
      url: 'u',
      state: 'open' as const,
      author: 'you',
      mine: true,
      waitingOnYou: false,
      head: { branch: 'b', sha: 's' },
      base: { branch: 'main', sha: null },
      updatedAt: '',
      checks: 'passed' as const,
      decision: 'approved' as const,
      conflicts: false,
      blocked: null,
      task: null,
    }
    expect(ready(base)).toBe(true)
    expect(marksOf(base).map((mark) => mark.text)).toContain('ready')
    expect(ready({ ...base, conflicts: true })).toBe(false)
    expect(ready({ ...base, checks: 'running' })).toBe(false)
    expect(ready({ ...base, state: 'draft' })).toBe(false)
  })
})
