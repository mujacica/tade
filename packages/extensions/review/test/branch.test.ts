import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckRun, CheckState } from '@tade/checks-core'
import { newFindings } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { makeScriptedForge } from '@tade/forge-scripted'
import { beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { redOn, standingOn } from '../src/branch.ts'
import { reviewExtension } from '../src/extension.ts'
import { forget } from '../src/forge.ts'

// CI on the branch the project is on, which is the half of CI that has no
// review to hang off.
//
// The decision — is this commit red, and has it finished being anything else
// — is asked of the scripted forge, which answers from a table. The whole
// watch is asked of the GitHub replay, which answers from files. Nothing here
// reaches the network and nothing spawns a process.

const NOW = Date.parse('2026-09-19T08:00:00Z')
const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

/** Whatever the checkout is standing on: `main`, at a commit, with a subject. */
const RED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const FRESH = '1111111111111111111111111111111111111111'

const ran = (commit: string, check: string, state: CheckState): CheckRun => ({
  id: `${commit}:${check}:scripted:1`,
  check,
  commit,
  state,
  where: { kind: 'forge', forge: 'scripted', job: check, url: null },
  required: true,
  startedAt: '2026-09-19T07:00:00.000Z',
  finishedAt: state === 'running' || state === 'queued' ? null : '2026-09-19T07:04:00.000Z',
  code: null,
  summary: state === 'failed' ? '8 failed' : null,
  by: null,
})

/** GitHub's own check-runs shape, for the commit a branch is on. */
const checkRuns = (...each: [string, string, string | null][]) => ({
  check_runs: each.map(([name, status, conclusion], n) => ({
    id: 600 + n,
    name,
    status,
    conclusion,
    started_at: '2026-09-19T07:00:00Z',
    completed_at: conclusion === null ? null : '2026-09-19T07:04:00Z',
    html_url: `https://github.com/acme/api/runs/${600 + n}`,
    output: { title: conclusion === 'failure' ? '8 failed' : null },
  })),
})

/** git, as a project on `main` at one commit answers. */
function gitLike(options: { branch?: string; commit?: string; remote?: boolean } = {}) {
  return async (command: string, args: readonly string[]) => {
    const said = args.join(' ')
    if (command !== 'git') return { code: 1, stdout: '', stderr: 'no such command' }
    if (said.includes('remote.origin.url')) {
      return options.remote === false
        ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: 'git@github.com:acme/api.git\n', stderr: '' }
    }
    if (said.includes('rev-parse --abbrev-ref HEAD')) {
      return { code: 0, stdout: `${options.branch ?? 'main'}\n`, stderr: '' }
    }
    if (said.includes('log -1 --format=%H%n%s')) {
      return { code: 0, stdout: `${options.commit ?? RED}\nretry refunds once\n`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }
}

function load(
  options: ReplayOptions & {
    settings?: Record<string, unknown>
    git?: { branch?: string; commit?: string; remote?: boolean }
    home?: string
  } = {},
) {
  const replay = githubReplay(options)
  const home = options.home ?? tmp('tade-branch-home-')
  return {
    replay,
    home,
    host: ExtensionHost.load({
      builtin: [reviewExtension],
      config: {
        extensions: { review: options.settings ?? {} },
        projects: { api: { root: '/src/api' } },
      },
      home,
      env,
      fetch: replay.fetch,
      exec: gitLike(options.git ?? {}),
      now: () => NOW,
    }),
  }
}

const look = (host: ExtensionHost) =>
  host.look('review.branch-checks', {
    project: 'api',
    input: {},
    since: null,
    turnedOn: '2026-09-01T00:00:00Z',
  })

beforeEach(() => forget())

describe('whether a commit is red yet', () => {
  it('says nothing while CI has not reached the push, rather than saying it is fine', async () => {
    // Every push looks like this for a minute. An answer of "no failures" and
    // an answer of "nothing has run" are the same empty list to anybody above,
    // which is why this returns null for both rather than an empty array.
    const forge = makeScriptedForge({ commits: {} })
    expect(await redOn(forge, 'acme/api', FRESH)).toBeNull()
  })

  it('waits while anything is still going, so a retry is never raced', async () => {
    const forge = makeScriptedForge({
      commits: {
        [`acme/api@${RED}`]: [
          ran(RED, 'tests', 'failed'),
          // The one that decides: a workflow still running may yet turn this
          // commit green, and an agent started now is an agent started on a
          // failure that was about to be re-run.
          ran(RED, 'types', 'running'),
        ],
      },
    })
    expect(await redOn(forge, 'acme/api', RED)).toBeNull()
  })

  it('says which checks failed once everything has settled', async () => {
    const forge = makeScriptedForge({
      commits: {
        [`acme/api@${RED}`]: [
          ran(RED, 'format', 'passed'),
          ran(RED, 'types', 'skipped'),
          ran(RED, 'tests', 'failed'),
        ],
      },
    })
    const red = await redOn(forge, 'acme/api', RED)
    expect(red?.map((one) => one.check)).toEqual(['tests'])
  })

  it('reads a green commit as nothing to do, not as something to look at', async () => {
    const forge = makeScriptedForge({
      commits: { [`acme/api@${RED}`]: [ran(RED, 'tests', 'passed')] },
    })
    expect(await redOn(forge, 'acme/api', RED)).toBeNull()
  })
})

describe('the branch a project is on', () => {
  const exec = gitLike()
  const ctx = { exec, extension: 'review' } as unknown as Parameters<typeof standingOn>[0]

  it('is read off the checkout, with the commit and its subject', async () => {
    expect(await standingOn(ctx, '/src/api')).toEqual({
      branch: 'main',
      commit: RED,
      subject: 'retry refunds once',
    })
  })

  it('is nobody’s branch in a detached worktree, and nothing is watched there', async () => {
    const detached = { exec: gitLike({ branch: 'HEAD' }) } as unknown as typeof ctx
    expect(await standingOn(detached, '/src/api')).toBeNull()
  })
})

describe('watching CI on the branch', () => {
  it('finds each failing check on the commit the branch is on', async () => {
    const { host } = load({
      runs: {
        [RED]: checkRuns(['format', 'completed', 'success'], ['tests', 'completed', 'failure']),
      },
    })
    const looked = await look(await host)
    expect(looked.found.map((one) => one.key)).toEqual([`github.com/acme/api@${RED}`])
    expect(looked.found[0]?.title).toBe('tests failing on main — retry refunds once')
    expect(looked.found[0]?.detail).toContain(RED.slice(0, 12))
  })

  it('is one finding for one commit, however many of its checks went red', async () => {
    // Three agents editing one repository over one push, in a checkout they
    // all share, is worse than the failure they were started on.
    const { host } = load({
      runs: {
        [RED]: checkRuns(
          ['format', 'completed', 'failure'],
          ['types', 'completed', 'failure'],
          ['tests', 'completed', 'failure'],
        ),
      },
    })
    const looked = await look(await host)
    expect(looked.found).toHaveLength(1)
    expect(looked.found[0]?.title).toBe(
      'format, types and 1 more failing on main — retry refunds once',
    )
    expect(looked.found[0]?.detail).toContain('tests')
  })

  it('keys it by the commit, so a workflow re-run never starts a second agent', async () => {
    const { host } = load({
      runs: { [RED]: checkRuns(['tests', 'completed', 'failure']) },
    })
    const loaded = await host
    const first = await look(loaded)
    const again = await look(loaded)
    expect(again.found.map((one) => one.key)).toEqual(first.found.map((one) => one.key))
    const seen = new Set(first.found.map((one) => one.key))
    expect(newFindings(again.found, seen, 5)).toMatchObject({ fresh: [], acting: [], left: 0 })
  })

  it('finds the same check failing on a new commit, because that is new information', async () => {
    const after = '2222222222222222222222222222222222222222'
    const { host } = load({
      git: { commit: after },
      runs: { [after]: checkRuns(['tests', 'completed', 'failure']) },
    })
    const looked = await look(await host)
    expect(looked.found.map((one) => one.key)).toEqual([`github.com/acme/api@${after}`])
  })

  it('finds nothing while a check is still running on the commit', async () => {
    const { host } = load({
      runs: {
        [RED]: checkRuns(['tests', 'completed', 'failure'], ['types', 'in_progress', null]),
      },
    })
    expect((await look(await host)).found).toEqual([])
  })

  it('finds nothing on a commit CI has not run anything on', async () => {
    const { host } = load({ git: { commit: FRESH } })
    expect((await look(await host)).found).toEqual([])
  })

  it('leaves a branch that has a review open to the watch whose branch it is', async () => {
    // Otherwise two watches find one failure and two agents are started on
    // it, in one checkout, on the same file.
    const { host } = load({
      git: { branch: 'shop/refunds-retry' },
      runs: { [RED]: checkRuns(['tests', 'completed', 'failure']) },
    })
    expect((await look(await host)).found).toEqual([])
  })

  it('is silent in a project with no remote, rather than complaining every look', async () => {
    // It is on without anybody turning it on, so a project that will never
    // have a forge must cost nothing and say nothing.
    const { host } = load({ git: { remote: false } })
    expect((await look(await host)).found).toEqual([])
  })

  it('says it could not look when the forge refuses, rather than finding nothing', async () => {
    const { host } = load({ limited: true })
    await expect(look(await host)).rejects.toThrow(/rate limiting/)
  })
})

describe('what the agent on a red branch is told', () => {
  const failing = {
    runs: { [RED]: checkRuns(['tests', 'completed', 'failure']) },
    logs: { [`${RED}:tests`]: 'FAIL packages/core/test/spend.test.ts\n  8 failed, 412 passed\n' },
  }

  it('gets the commit, what failed and the tail of its log, and is told to reproduce it here', async () => {
    const { host } = load(failing)
    const looked = await look(await host)
    const finding = looked.found[0]
    if (!finding) throw new Error('nothing was found to start work on')
    const started = await looked.agent(finding)
    expect(started.context).toContain(RED.slice(0, 12))
    expect(started.context).toContain('retry refunds once')
    expect(started.context).toContain('8 failed, 412 passed')
    expect(started.prompt).toContain('Reproduce it here before you change anything')
  })

  it('refuses on its own behalf: no force-push, no revert, no merge', async () => {
    const { host } = load(failing)
    const looked = await look(await host)
    const finding = looked.found[0]
    if (!finding) throw new Error('nothing was found to start work on')
    const started = await looked.agent(finding)
    expect(started.prompt).toContain('Never force-push')
    expect(started.prompt).toContain('never revert somebody else’s commit')
    expect(started.prompt).toContain('never merge anything')
  })

  it('only reports when the settings do not let checks be fixed unasked', async () => {
    const { host } = load({ ...failing, settings: { fix: ['bots'] } })
    const looked = await look(await host)
    const finding = looked.found[0]
    if (!finding) throw new Error('nothing was found to start work on')
    const started = await looked.agent(finding)
    expect(started.prompt).toContain('Change nothing and push nothing')
    expect(started.prompt).toContain('do not let checks be fixed without asking')
  })

  it('stops fixing and only reports once this branch has had its attempts', async () => {
    // A watch may only ever add work, and after a few automatic fixes on one
    // branch it says what is wrong instead of trying again all night.
    const home = tmp('tade-branch-attempts-')
    writeFileSync(
      join(home, 'schedules.jsonl'),
      `${JSON.stringify({
        op: 'set',
        by: 'extension:review',
        at: '2026-09-19T00:00:00.000Z',
        schedule: {
          id: 'branch-checks-api',
          name: 'Failing CI on the branch you are on',
          project: 'api',
          said: '',
          when: { every: '10m' },
          does: {
            kind: 'watch',
            watch: 'review.branch-checks',
            input: {},
            found: 'agent',
            most: 2,
          },
          missed: 'once',
          by: 'extension:review',
          created: '2026-09-19T00:00:00.000Z',
        },
      })}\n`,
    )
    const fixed = (n: number, commit: string) =>
      JSON.stringify({
        seq: n,
        ts: new Date(NOW - 60 * 60_000).toISOString(),
        type: 'watch_found',
        urgency: 'notable',
        task: `api/fix-${n}`,
        detail: {
          schedule: 'branch-checks-api',
          key: `github.com/acme/api@${commit}`,
          title: 'tests failing on main',
        },
      })
    writeFileSync(join(home, 'events.jsonl'), `${fixed(1, 'aaaa')}\n${fixed(2, 'bbbb')}\n`)
    const { host } = load({ ...failing, home })
    const looked = await look(await host)
    const finding = looked.found[0]
    if (!finding) throw new Error('nothing was found to start work on')
    const started = await looked.agent(finding)
    expect(started.prompt).toContain('2 automatic fixes in the last 6 hours')
    expect(started.prompt).toContain('Change nothing and push nothing')
  })
})
