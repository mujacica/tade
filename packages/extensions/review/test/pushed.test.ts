import { ExtensionHost, Unreachable } from '@tade/extensions-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget } from '../src/forge.ts'
import { NOW, project, reallyExec } from './repo.ts'

// What `origin` has, asked with a real `git ls-remote` — by the watch for
// branches pushed with no review, and by `review_open` before it opens one.
//
// `origin` is GitHub's URL, rewritten by git's own `insteadOf` to the bare
// repository next door, to a port on this machine nothing listens on, or to a
// folder with no repository in it: three real answers git gives, and nothing
// here reaches the network. The forge is the GitHub replay.

const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }
const GITHUB = 'git@github.com:acme/api.git'

/** A project whose `origin` git really reaches at `url`, with `tade/new-thing` pushed. */
function origin(url?: string) {
  const { repo } = project()
  repo.git('push', '-q', 'origin', 'main:tade/new-thing')
  repo.git('config', `url.${url ?? repo.remote}.insteadOf`, GITHUB)
  return repo
}

/** The extension over a project at `root`, asking a GitHub that answers as `forge` says. */
function load(root: string, forge: Omit<ReplayOptions, 'clock'> = {}) {
  const replay = githubReplay({ clock: () => NOW, ...forge })
  return ExtensionHost.load({
    builtin: [reviewExtension],
    config: { extensions: { review: {} }, projects: { api: { root } } },
    home: tmp('tade-pushed-home-'),
    env,
    fetch: replay.fetch,
    exec: async (command: string, args: readonly string[]) =>
      command === 'gh' ? replay.exec(command, args) : reallyExec(command, args),
    now: () => NOW,
  })
}

const look = async (root: string, forge: Omit<ReplayOptions, 'clock'> = {}) =>
  (await load(root, forge)).look('review.pushed', {
    project: 'api',
    input: {},
    since: null,
    turnedOn: '2026-09-01T00:00:00Z',
  })

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )

beforeEach(() => forget())

describe('branches pushed with no review', () => {
  it('finds a branch of ours on origin with nothing open for it', async () => {
    const looked = await look(origin().root)
    expect(looked.found.map((one) => one.key)).toEqual(['acme/api:tade/new-thing:first-push'])
  })

  it('names the host when nothing answered, rather than finding nothing pushed', async () => {
    // An empty list is "nothing pushed", which is what every look said all
    // through an outage. `Unreachable` is what lets the scheduler's reach ask
    // whether this machine has a network before a red line names github.com.
    const err = await failure(look(origin('http://127.0.0.1:1/acme/api.git').root))
    expect(err).toBeInstanceOf(Unreachable)
    expect((err as Unreachable).host).toBe('github.com')
    expect((err as Error).message).toMatch(/could not ask origin .*tade\/\*: .*127\.0\.0\.1/)
  })

  it('keeps an origin that answered no as an ordinary failure, in git’s words', async () => {
    // Something answered, so this is no outage: it is a remote that is wrong,
    // and the machine's network is not asked about it.
    const err = await failure(look(origin(tmp('tade-pushed-nothing-')).root))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(Unreachable)
    expect((err as Error).message).toMatch(/does not appear to be a git repository/)
  })

  it('finds nothing when the forge could not be reached to ask about a review', async () => {
    // Origin answered and GitHub did not: read as "no review open", every
    // tade/* branch on origin became a finding parked for the orchestrator.
    const err = await failure(look(origin().root, { unreachable: true }))
    expect(err).toBeInstanceOf(Unreachable)
    expect((err as Unreachable).host).toBe('github.com')
  })

  it('finds nothing when the forge answered with a failure, and keeps its words', async () => {
    // A 500 is GitHub answering, so it is no outage and names no host — but it
    // is still a look that failed rather than a branch with nothing open.
    const err = await failure(look(origin().root, { serverError: true }))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(Unreachable)
    expect((err as Error).message).toMatch(/500|Server Error/)
  })
})

describe('opening a review', () => {
  it('says origin could not be asked rather than that the branch is not pushed', async () => {
    // "Push it first" sends an agent to push what is already there.
    const repo = origin('http://127.0.0.1:1/acme/api.git')
    repo.git('checkout', '-q', '-b', 'tade/new-thing')
    const err = await failure(
      (await load(repo.root)).call('review_open', {}, { caller: { kind: 'orchestrator' } }),
    )
    expect(err).toBeInstanceOf(Unreachable)
    expect((err as Error).message).toMatch(/could not ask origin .*tade\/new-thing/)
    expect((err as Error).message).not.toMatch(/not on the remote yet/)
  })
})
