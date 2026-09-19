import { testForge } from '@tade/forges-core/conformance'
import { describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { makeGithubForge } from '../src/index.ts'
import { taskIn } from '../src/map.ts'

// GitHub, against recorded shapes and a fake `fetch`. Nothing here reaches
// the network, and nothing spawns a process: the credential comes from a
// scripted `gh`.

const make = (options: ReplayOptions = {}) => {
  const replay = githubReplay(options)
  const forge = makeGithubForge({ exec: replay.exec, fetch: replay.fetch, env: {} })
  return { forge, replay }
}

testForge('github', () => make().forge, {
  ref: { repo: 'acme/api', number: 412, host: 'github.com' },
  unknown: { repo: 'acme/api', number: 9999, host: 'github.com' },
  remotes: { serves: 'git@github.com:acme/api.git', not: 'git@gitlab.com:acme/api.git' },
  branches: { withReview: 'shop/refunds-retry', without: 'nothing-here' },
  signedOut: () => make({ signedOut: true }).forge,
  limited: () => make({ limited: true }).forge,
  readOnly: () => make({ scopes: 'read:org, gist' }).forge,
})

describe('GitHub, in the port\u2019s words', () => {
  it('reads a pull request as a review, with the task its body names', async () => {
    const { forge } = make()
    const review = await forge.review({ repo: 'acme/api', number: 412, host: 'github.com' })
    expect(review.state).toBe('open')
    expect(review.mine).toBe(true)
    expect(review.checks).toBe('passed')
    expect(review.decision).toBe('approved')
    expect(review.task).toBe('shop/refunds-retry')
    expect(review.head.branch).toBe('shop/refunds-retry')
    expect(review.files[0]?.path).toBe('src/refunds.ts')
  })

  it('reads a draft as a draft, a conflict as a conflict, and a request as waiting on you', async () => {
    const { forge } = make()
    const review = await forge.review({ repo: 'acme/api', number: 418, host: 'github.com' })
    expect(review.state).toBe('draft')
    expect(review.conflicts).toBe(true)
    expect(review.waitingOnYou).toBe(true)
    expect(review.decision).toBe('changes requested')
    expect(review.checks).toBe('failed')
  })

  it('never calls a check that is still going a check that passed', async () => {
    const { forge } = make()
    const runs = await forge.checks({ repo: 'acme/api', number: 412, host: 'github.com' })
    expect(runs.map((one) => `${one.check}:${one.state}`)).toEqual([
      'format:passed',
      'types:running',
      'tests:failed',
    ])
    expect(runs.every((run) => run.where.kind === 'forge')).toBe(true)
  })

  it('reads a bot\u2019s comment as a bot\u2019s, verbatim', async () => {
    const { forge } = make()
    const review = await forge.review({ repo: 'acme/api', number: 412, host: 'github.com' })
    const comment = review.threads[0]?.comments[0]
    expect(comment?.bot).toBe(true)
    expect(comment?.body).toContain('no backoff')
    expect(review.threads[0]?.line).toBe(42)
  })

  it('asks for what is ours and what waits on us, and narrows in the query', async () => {
    const { forge, replay } = make()
    const mine = await forge.reviews({ who: 'mine', repos: ['acme/*'] })
    expect(mine.items.map((one) => one.ref.number)).toEqual([412])
    const waiting = await forge.reviews({ who: 'waiting on you' })
    expect(waiting.items.map((one) => one.ref.number)).toEqual([418])
    const searches = replay.bodies.filter(
      (body) => typeof (body as { query?: string }).query === 'string',
    ) as { variables: { q: string } }[]
    expect(searches.some((one) => one.variables.q.includes('repo:acme/*'))).toBe(true)
    expect(searches.some((one) => one.variables.q.includes('author:@me'))).toBe(true)
  })

  it('finds the credential without writing it anywhere, and says how to make one', async () => {
    const { forge, replay } = make()
    expect(await forge.whoami()).toEqual({ login: 'mujacica', can: 'write' })
    expect(replay.calls.some((call) => call.startsWith('gh auth token'))).toBe(true)
    const out = make({ signedOut: true })
    const who = await out.forge.whoami()
    expect('problem' in who && who.problem).toContain('gh auth login')
  })

  it('prefers a token in the environment to spawning anything', async () => {
    const replay = githubReplay()
    const forge = makeGithubForge({
      exec: replay.exec,
      fetch: replay.fetch,
      env: { GITHUB_TOKEN: 'ghp_fromtheenvironment' },
    })
    await forge.whoami()
    expect(replay.calls.some((call) => call.startsWith('gh '))).toBe(false)
  })

  it('opens a review with the trailer in its body, and reads it back', async () => {
    const { forge, replay } = make()
    const made = await forge.open({
      repo: 'acme/api',
      head: 'shop/new',
      base: 'main',
      title: 'a new one',
      body: 'what it does\n\nTade-Task: shop/new\n',
      draft: true,
    })
    expect(made.ref.number).toBe(999)
    const sent = replay.bodies.find(
      (body) => (body as { title?: string }).title === 'a new one',
    ) as { body: string; draft: boolean }
    expect(sent.draft).toBe(true)
    expect(taskIn(sent.body)).toBe('shop/new')
  })

  it('says it cannot put anything in a merge queue rather than pretending', async () => {
    const { forge } = make()
    await expect(
      forge.merge({ repo: 'acme/api', number: 412, host: 'github.com' }, 'queue'),
    ).rejects.toMatchObject({ trouble: 'unsupported' })
  })

  it('says when to come back when it is rate limited', async () => {
    const { forge } = make({ limited: true })
    await expect(forge.reviews({ who: 'mine' })).rejects.toMatchObject({ trouble: 'rate' })
    expect(forge.limits()?.remaining).toBe(0)
  })
})
