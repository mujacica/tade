import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExtensionContext, ExtensionHost, type Finding } from '@tade/extensions-core'
import { makeScriptedForge, type ScriptedReview } from '@tade/forge-scripted'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay } from '../../../../test/fixtures/forge/github.ts'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { conflictKey, conflictsIn, conflictWork, readConflictKey } from '../src/conflicts.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget } from '../src/forge.ts'
import { NOW, reallyExec } from './repo.ts'

// A review Tade opened that conflicts with its base, and the one agent put on it.
//
// **What the forge says is a table** — the scripted forge, or the GitHub replay
// where the extension finds its forge the way it does for real — and **git is
// real**: the review's branch and `main` really changed one line apart, are
// really pushed to a bare repository next door, and the fetch the watch does
// before it starts anything is a real fetch. The things this is about are all
// git's answers: whether the head that was found is on origin's branch, which
// files a merge would clash in, and that nothing anybody else is in was touched
// on the way.

const BRANCH = 'shop/refunds-retry'

/**
 * A real repository whose review branch and `main` changed the same line since
 * they parted, both pushed — and the branch never fetched here since, so a
 * remote-tracking ref for it is evidence the watch fetched it.
 */
function conflicted() {
  const repo = mkrepo({ remote: true })
  repo.commit('refunds', { 'src/refunds.ts': 'export const tries = 1\n' })
  repo.git('push', '-q', 'origin', 'main')
  repo.git('checkout', '-q', '-b', BRANCH)
  const head = repo.commit('retry refunds once', { 'src/refunds.ts': 'export const tries = 2\n' })
  repo.git('push', '-q', 'origin', BRANCH)
  repo.git('checkout', '-q', 'main')
  repo.git('branch', '-q', '-D', BRANCH)
  repo.git('update-ref', '-d', `refs/remotes/origin/${BRANCH}`)
  repo.commit('refunds never retry', { 'src/refunds.ts': 'export const tries = 0\n' })
  repo.git('push', '-q', 'origin', 'main')
  return { repo, head, bare: repo.remote ?? '' }
}

/**
 * That repository, made once for the tests that only read it. Every one of them
 * fetches, which moves nothing but a remote-tracking ref to where the remote
 * already is, and the one that adds a branch adds one nobody else asks about.
 */
let made: ReturnType<typeof conflicted> | null = null
const shared = () => {
  made ??= conflicted()
  return made
}

/** #412 as the scripted forge holds it: ours, opened by a task, and conflicting. */
const review = (head: string, over: Partial<ScriptedReview> = {}): ScriptedReview => ({
  ref: { host: 'scripted.test', repo: 'acme/api', number: 412 },
  title: 'retry refunds once',
  head: { branch: BRANCH, sha: head },
  base: { branch: 'main', sha: null },
  conflicts: true,
  task: 'api/refunds-retry',
  files: [{ path: 'src/refunds.ts', added: 1, removed: 1 }],
  ...over,
})

/** What a watch looks with, around a real git and a home of its own. */
function contextFor(
  root: string,
  options: { home?: string; settings?: Record<string, unknown> } = {},
): ExtensionContext {
  return {
    extension: 'review',
    settings: options.settings ?? {},
    projects: [{ name: 'api', root }],
    project: () => ({ name: 'api', root }),
    env: {},
    secret: () => null,
    fetch: () => Promise.reject(new Error('nothing here reaches the network')),
    exec: (command, args) => reallyExec(command, args),
    home: options.home ?? tmp('tade-conflicts-home-'),
    now: () => NOW,
  }
}

/** The one finding the scripted forge's table makes, as the watch keys it. */
async function foundIn(forge: ReturnType<typeof makeScriptedForge>): Promise<Finding> {
  const [first] = await conflictsIn(forge, 'acme/api')
  if (!first) throw new Error('the table should conflict')
  return first
}

/**
 * Merges this watch already started on #412, as the journal records them: a
 * real `schedules.jsonl` line and real `watch_found` lines, because that is
 * what `attemptsUnder` counts.
 */
function alreadyMerged(home: string, ago: number[]): string {
  writeFileSync(
    join(home, 'schedules.jsonl'),
    `${JSON.stringify({
      op: 'set',
      by: 'you',
      at: '2026-09-01T00:00:00.000Z',
      schedule: {
        id: 'conflicts-api',
        name: 'review.conflicts',
        project: 'api',
        said: 'merge main into my reviews when they conflict',
        when: { every: '10m' },
        does: { kind: 'watch', watch: 'review.conflicts', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-09-01T00:00:00.000Z',
      },
    })}\n`,
  )
  writeFileSync(
    join(home, 'events.jsonl'),
    ago
      .map(
        (ms, n) =>
          `${JSON.stringify({
            seq: n + 1,
            ts: new Date(NOW - ms).toISOString(),
            type: 'watch_found',
            urgency: 'notable',
            task: `api/merge-main-${n + 1}`,
            detail: {
              schedule: 'conflicts-api',
              key: `scripted.test/acme/api#412:conflicts@${String(n + 1).repeat(40)}`,
              title: 'review #412 conflicts with main',
            },
          })}\n`,
      )
      .join(''),
  )
  return home
}

const HOUR = 60 * 60_000

beforeEach(() => forget())

describe('which reviews conflict', () => {
  const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

  it('finds a review Tade opened that conflicts, and nobody else’s', async () => {
    const forge = makeScriptedForge({
      reviews: [
        review(HEAD),
        review(HEAD, { ref: { host: '', repo: 'acme/api', number: 413 }, conflicts: false }),
        // Nothing attributes it to a task: a person's own branch, and a merge
        // pushed under them is theirs to want.
        review(HEAD, { ref: { host: '', repo: 'acme/api', number: 414 }, task: null }),
        review(HEAD, { ref: { host: '', repo: 'acme/api', number: 415 }, author: 'someone' }),
        // Another repository, which the agent would not be started in.
        review(HEAD, { ref: { host: '', repo: 'acme/web', number: 416 } }),
        review(HEAD, { ref: { host: '', repo: 'acme/api', number: 417 }, state: 'merged' }),
      ],
    })
    const found = await conflictsIn(forge, 'acme/api')
    expect(found.map((one) => one.key)).toEqual([`scripted.test/acme/api#412:conflicts@${HEAD}`])
    expect(found[0]?.title).toBe('review #412 conflicts with main — retry refunds once')
    expect(found[0]?.detail).toContain('the work of api/refunds-retry')
  })

  it('is the same finding while the head stays where it is, and a new one once it moves', () => {
    // A merge an agent pushes is a new head: if the base has moved again by
    // then, that is new information. The same conflict looked at twice is not.
    const at = (sha: string) => ({
      ref: { host: 'github.com', repo: 'acme/api', number: 412 },
      head: { branch: BRANCH, sha },
    })
    expect(conflictKey(at(HEAD))).toBe(conflictKey(at(HEAD)))
    expect(conflictKey(at('f'.repeat(40)))).not.toBe(conflictKey(at(HEAD)))
    expect(readConflictKey(conflictKey(at(HEAD)))).toEqual({ ref: at(HEAD).ref, head: HEAD })
    // Another watch's key about the same review is not one of these.
    expect(readConflictKey(`github.com/acme/api#412:tests:${HEAD}`)).toBeNull()
  })

  it('cannot look rather than finding nothing, when the forge will not answer', async () => {
    await expect(
      conflictsIn(makeScriptedForge({ trouble: 'rate', reviews: [review(HEAD)] }), 'acme/api'),
    ).rejects.toThrow(/rate/)
  })
})

describe('the agent put on one', () => {
  it('begins a tree of its own at the review’s head, and merges the base in and pushes to its branch', async () => {
    const { repo, head, bare } = shared()
    const forge = makeScriptedForge({ reviews: [review(head)] })
    const work = await conflictWork(await foundIn(forge), {
      ctx: contextFor(repo.root),
      forge,
      root: repo.root,
    })
    // A tree nobody else is in, begun on the review's head as this repository
    // fetched it a moment ago — never the project's checkout.
    expect(work.alone).toBe(true)
    expect(work.from).toBe(`origin/${BRANCH}`)
    expect(runGit(repo.root, 'rev-parse', `origin/${BRANCH}`).trim()).toBe(head)
    // A merge, pushed as a fast-forward of the review's own branch.
    expect(work.prompt).toContain('git merge origin/main')
    expect(work.prompt).toContain(`git push origin HEAD:refs/heads/${BRANCH}`)
    expect(work.prompt).toContain('Never rebase and never force-push')
    expect(work.prompt).toContain('open no review')
    expect(work.prompt).not.toMatch(/--force|push -f|rebase -i/)
    // What clashes, as git worked it out without touching a tree.
    expect(work.context).toContain('conflicts in:\n\n- `src/refunds.ts`')
    expect(work.context).toContain('the work of api/refunds-retry')
    // And looking touched nobody's work: the checkout is where it was, clean,
    // and nothing was pushed.
    expect(runGit(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    expect(runGit(repo.root, 'status', '--porcelain')).toBe('')
    expect(runGit(bare, 'rev-parse', BRANCH).trim()).toBe(head)
  })

  it('says so where the base merges cleanly here, rather than naming files', async () => {
    // GitHub's answer can be a minute behind a push that resolved it.
    const { repo, head } = shared()
    repo.git('checkout', '-q', '-b', 'tidy', `${head}`)
    const forge = makeScriptedForge({
      reviews: [review(head, { base: { branch: 'tidy', sha: null } })],
    })
    repo.git('push', '-q', 'origin', 'tidy')
    repo.git('checkout', '-q', 'main')
    const work = await conflictWork(await foundIn(forge), {
      ctx: contextFor(repo.root),
      forge,
      root: repo.root,
    })
    expect(work.context).toContain('went through cleanly when Tade tried it here')
  })

  it('only tells, past `attempts` merges in six hours, and merges again once they are older', async () => {
    const { repo, head } = shared()
    const forge = makeScriptedForge({ reviews: [review(head)] })
    const finding = await foundIn(forge)
    const recent = alreadyMerged(tmp('tade-conflicts-recent-'), [HOUR, 2 * HOUR])
    const told = await conflictWork(finding, {
      ctx: contextFor(repo.root, { home: recent }),
      forge,
      root: repo.root,
    })
    expect(told.prompt).toContain('already had 2 automatic merges in the last 6 hours')
    expect(told.prompt).toContain('push nothing')
    expect(told.prompt).not.toContain('git push origin')
    // A bad afternoon last week is not a reason to stop merging today.
    const older = alreadyMerged(tmp('tade-conflicts-older-'), [7 * HOUR, 8 * HOUR])
    const merging = await conflictWork(finding, {
      ctx: contextFor(repo.root, { home: older }),
      forge,
      root: repo.root,
    })
    expect(merging.prompt).toContain(`git push origin HEAD:refs/heads/${BRANCH}`)
  })

  it('only tells where the settings do not let a conflict be resolved without asking', async () => {
    const { repo, head } = shared()
    const forge = makeScriptedForge({ reviews: [review(head)] })
    const work = await conflictWork(await foundIn(forge), {
      ctx: contextFor(repo.root, { settings: { fix: 'checks,bots' } }),
      forge,
      root: repo.root,
    })
    expect(work.prompt).toContain('`conflicts` is not in `extensions.review.fix`')
    expect(work.prompt).toContain('push nothing')
  })

  it('starts nothing on a branch that is not the review’s head on origin', async () => {
    // Rewritten since the look, or somebody else's branch of the same name:
    // either way, a merge pushed there would not be a merge into this review.
    const { repo } = shared()
    const elsewhere = 'deadbeef'.repeat(5)
    const forge = makeScriptedForge({ reviews: [review(elsewhere)] })
    await expect(
      conflictWork(await foundIn(forge), { ctx: contextFor(repo.root), forge, root: repo.root }),
    ).rejects.toThrow(`origin's ${BRANCH} does not have deadbeefdead`)
  })

  it('starts nothing on a review opened from a fork, which has no branch here to push to', async () => {
    const { repo, head } = shared()
    const forge = makeScriptedForge({
      reviews: [review(head, { head: { branch: 'someone/their-fork', sha: head } })],
    })
    await expect(
      conflictWork(await foundIn(forge), { ctx: contextFor(repo.root), forge, root: repo.root }),
    ).rejects.toThrow(/could not fetch someone\/their-fork/)
  })

  it('starts nothing on a review that moved or closed since it was found', async () => {
    const { repo, head } = shared()
    const found = await foundIn(makeScriptedForge({ reviews: [review(head)] }))
    const moved = makeScriptedForge({
      reviews: [review(head, { head: { branch: BRANCH, sha: 'c'.repeat(40) } })],
    })
    await expect(
      conflictWork(found, { ctx: contextFor(repo.root), forge: moved, root: repo.root }),
    ).rejects.toThrow(/has moved on from .* since it was found/)
    const closed = makeScriptedForge({ reviews: [review(head, { state: 'closed' })] })
    await expect(
      conflictWork(found, { ctx: contextFor(repo.root), forge: closed, root: repo.root }),
    ).rejects.toThrow('review #412 is closed now')
  })

  it('will not put a branch name a shell reads as more than a name into a command', async () => {
    const { repo, head } = shared()
    const forge = makeScriptedForge({
      reviews: [review(head, { head: { branch: 'fix`id`', sha: head } })],
    })
    await expect(
      conflictWork(await foundIn(forge), { ctx: contextFor(repo.root), forge, root: repo.root }),
    ).rejects.toThrow(/is not a branch name this watch will put in a command/)
  })
})

describe('the watch, through GitHub', () => {
  const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

  /**
   * The same repository as GitHub would serve it: `origin` read as
   * `git@github.com:acme/api.git`, which is what makes the GitHub forge serve
   * it, and rewritten by git's own `insteadOf` to the bare repository next
   * door, so the fetch is a real fetch and nothing reaches the network.
   */
  let served: ReturnType<typeof conflicted> | null = null
  function load() {
    if (!served) {
      served = conflicted()
      served.repo.git('remote', 'set-url', 'origin', 'git@github.com:acme/api.git')
      served.repo.git('config', `url.${served.bare}.insteadOf`, 'git@github.com:acme/api.git')
    }
    const { repo, head } = served
    const replay = githubReplay()
    const pull = replay.pulls.find((one) => one.number === 412)
    if (pull) pull.headRefOid = head
    return {
      replay,
      head,
      repo,
      host: ExtensionHost.load({
        builtin: [reviewExtension],
        config: { extensions: { review: {} }, projects: { api: { root: repo.root } } },
        home: tmp('tade-conflicts-host-'),
        env,
        fetch: replay.fetch,
        exec: async (command: string, args: readonly string[]) =>
          command === 'gh' ? replay.exec(command, args) : reallyExec(command, args),
        now: () => NOW,
      }),
    }
  }

  const look = (host: ExtensionHost) =>
    host.look('review.conflicts', {
      project: 'api',
      input: {},
      since: null,
      turnedOn: '2026-09-01T00:00:00Z',
    })

  it('is off until somebody turns it on, and holds while the machine is offline', async () => {
    const { host } = load()
    const offer = (await host).watches().find((one) => one.id === 'review.conflicts')
    expect(offer).toMatchObject({ standing: false, network: true, offers: 'agent' })
  })

  it('finds #412 once GitHub says it conflicts, and starts its agent on the review’s branch', async () => {
    const { host, replay, head } = load()
    const loaded = await host
    // #412 merges cleanly, and #418 conflicts but is somebody else's with no
    // task named in it: nothing for this watch.
    expect((await look(loaded)).found).toEqual([])
    const pull = replay.pulls.find((one) => one.number === 412)
    if (pull) pull.mergeable = 'CONFLICTING'
    forget()
    const looked = await look(loaded)
    expect(looked.found.map((one) => one.key)).toEqual([
      `github.com/acme/api#412:conflicts@${head}`,
    ])
    const [finding] = looked.found
    if (!finding) throw new Error('unreachable')
    expect(finding.title).toBe('PR #412 conflicts with main — retry refunds once')
    const work = await looked.agent(finding)
    expect(work.from).toBe(`origin/${BRANCH}`)
    expect(work.alone).toBe(true)
    expect(work.prompt).toContain(`git push origin HEAD:refs/heads/${BRANCH}`)
    // Reading is all GitHub was asked: nothing written there by the look or
    // by working out what the agent is told.
    const mutations = replay.bodies.filter((body) =>
      /^\s*mutation/.test(String((body as { query?: unknown } | null)?.query ?? '')),
    )
    expect(mutations).toEqual([])
    expect(
      replay.calls.filter(
        (call) => /^(POST|PATCH|PUT|DELETE) /.test(call) && !call.endsWith('/graphql'),
      ),
    ).toEqual([])
  })
})
