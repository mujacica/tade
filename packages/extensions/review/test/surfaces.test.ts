import { ExtensionHost } from '@tade/extensions-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget } from '../src/forge.ts'

// The four places a review reaches somebody without being asked for: the line
// in the strip, the filters on the sidebar list, the page behind it, and the
// item in the briefing.
//
// `review.test.ts` holds the tools and what one poll makes of GitHub's answer;
// these are the surfaces that read the same snapshot and say different things
// about it, and none of them had been run. Each has the same two failure modes
// and they are what is asserted hardest: **a forge that cannot be reached must
// never read as good news** — not an empty section, not a missing line, not a
// green strip — and **nothing polls twice**, because these four are drawn from
// one snapshot and a page that asks the forge per surface is four requests a
// second against somebody's rate limit.

const NOW = Date.parse('2026-09-19T08:00:00Z')
const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

const gitLike = () => async (command: string, args: readonly string[]) => {
  if (command === 'git' && args.join(' ').includes('remote.origin.url')) {
    return { code: 0, stdout: 'git@github.com:acme/api.git\n', stderr: '' }
  }
  return { code: 1, stdout: '', stderr: '' }
}

function load(options: ReplayOptions & { settings?: Record<string, unknown> } = {}) {
  const replay = githubReplay(options)
  return {
    replay,
    host: ExtensionHost.load({
      builtin: [reviewExtension],
      config: {
        extensions: { review: options.settings ?? {} },
        projects: { api: { root: '/src/api' } },
      },
      home: tmp('tade-review-surfaces-'),
      env,
      fetch: replay.fetch,
      exec: gitLike(),
      now: () => NOW,
    }),
  }
}

const tade = {
  pid: process.pid,
  lanes: () => [],
  agents: () => [],
  startAgent: async () => ({ task: 'api/x', worktree: '/src/api' }),
}

beforeEach(() => forget())

describe('the line in the strip', () => {
  it('is quiet where nothing of yours is failing, and says who wants you', async () => {
    // `#412` is ours and green; `#418` is somebody else's and waits on us.
    const [said] = await (await load().host).statuses(tade)
    expect(said?.item.text).toBe('reviews · 2 open · 1 want you')
    expect(said?.item.tone).toBe('quiet')
  })

  it('goes red for a branch of yours that is failing, and only for that', async () => {
    // Red is `mine && failing`: a red build on somebody else's branch is
    // theirs to fix, and a strip that went red for it would be red all day.
    const [said] = await (await load({ me: 'somebody-else' }).host).statuses(tade)
    expect(said?.item.text).toBe('reviews · 1 open · 1 red')
    expect(said?.item.tone).toBe('bad')
  })

  it('says it could not read them rather than saying nothing', async () => {
    const [said] = await (await load({ limited: true }).host).statuses(tade)
    // An absent line reads as "no reviews", which is the one thing that is not
    // true: nobody knows, because GitHub would not say.
    expect(said?.item.text).toBe('reviews · not read')
  })
})

describe('the filters on the list', () => {
  const rowsWith = async (filter: string) => {
    const host = await load().host
    const [section] = await host.lists(tade, { filters: { 'review.open': filter } })
    return (section?.rows ?? []).map((row) => row.title)
  }

  it('shows everything that was polled under the first one', async () => {
    expect(await rowsWith('all')).toEqual(['#418  stripe v15', '#412  retry refunds once'])
  })

  it('shows only yours under mine', async () => {
    // What is polled is the `who` setting's business; these only choose what
    // of it is drawn, so no filter ever asks the forge anything new.
    expect(await rowsWith('mine')).toEqual(['#412  retry refunds once'])
  })

  it('shows only what is waiting on you under waiting', async () => {
    expect(await rowsWith('waiting')).toEqual(['#418  stripe v15'])
  })

  it('asks the forge once, however many filters are drawn', async () => {
    const { host, replay } = load()
    const loaded = await host
    await loaded.lists(tade, { filters: { 'review.open': 'all' } })
    const after = replay.calls.length
    await loaded.lists(tade, { filters: { 'review.open': 'mine' } })
    await loaded.lists(tade, { filters: { 'review.open': 'waiting' } })
    expect(replay.calls.length).toBe(after)
  })
})

describe('the page behind it', () => {
  it('draws every review, and says how long ago it was read', async () => {
    const page = await (await load().host).view('review', tade)
    expect(page.markdown).toContain('#412')
    expect(page.markdown).toContain('#418')
    // A page about something polled has to say when: a list with no age on it
    // is read as now, and this one is at most a minute old by design.
    expect(page.markdown).toMatch(/Read \d+s ago/)
    expect(page.markdown).toContain('every 60s')
  })

  it('says why it is empty, where the forge would not answer', async () => {
    const page = await (await load({ limited: true }).host).view('review', tade)
    expect(page.markdown).toContain('rate limiting')
  })

  it('says nothing about watches before one has found anything', async () => {
    const page = await (await load().host).view('review', tade)
    expect(page.markdown).not.toContain('What the watches found')
  })
})

describe('the item in the briefing', () => {
  it('says what is ready and what wants you, in one line', async () => {
    const { items } = await (await load().host).brief()
    expect(items).toHaveLength(1)
    expect(items[0]?.said).toBe('1 of yours is ready, 1 wants you in pull requests')
    // The forge's own word for the thing, so a GitLab briefing says merge
    // requests without anybody here asking which forge it is.
    expect(items[0]?.ask).toBe('Show me what is waiting')
  })

  it('offers the thing to do about the worst of it, and red is the worst', async () => {
    const { items } = await (await load({ me: 'somebody-else' }).host).brief()
    // Red beats waiting: a branch nobody can merge is worse news than a review
    // somebody is waiting on, and the briefing has room for one thing to do.
    expect(items[0]?.said).toBe('1 is red in pull requests')
    expect(items[0]?.ask).toBe('Say what is failing and fix it')
    expect(items[0]?.links?.[0]?.title).toBe('PR #418')
  })

  it('says nothing at all where nothing wants anybody', async () => {
    // Not "0 red, 0 waiting": a briefing is what happened, and nothing
    // happening is a line nobody needs to read.
    const { items } = await (await load({ me: 'nobody' }).host).brief()
    expect(items).toEqual([])
  })

  it('stays out of the briefing where somebody turned it off', async () => {
    const { items } = await (await load({ settings: { brief: false } }).host).brief()
    expect(items).toEqual([])
  })
})
