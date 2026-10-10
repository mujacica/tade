import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { reviewExtension } from '../src/extension.ts'
import { findingId, marker, reviewVersion } from '../src/reviewing.ts'
import { NOW, project, reallyExec } from './repo.ts'

export { NOW }

// What the two reviewing test files share: a window with the review extension
// in it, a GitHub answering from files, and the journal lines that stand for a
// reviewer Tade already started.
//
// Its own file for the reason `repo.ts` is: the tools and the loop are two
// subjects, each at the size a test file is allowed to be, and the fixture is
// neither of them.

export const env = { GITHUB_TOKEN: 'ghp_pretend', PATH: '/usr/bin' }

export const ref = { host: 'github.com', repo: 'acme/api', number: 412 }
export const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const VERSION = reviewVersion(ref, HEAD)

/**
 * A real repository with a real `origin` on `acme/api`, made once.
 *
 * **git is real here**, because the first thing any of this does is ask a
 * checkout which forge its work goes to, and a scripted git would only ever
 * answer what these tests already believe about how a remote is written. It is
 * made once and never written to — nothing below checks anything out, commits
 * or pushes — so a file of tests costs one repository rather than one each.
 */
let made: ReturnType<typeof project> | null = null
export function here(): string {
  made ??= project({ pushed: false })
  return made.repo.root
}

export function load(
  options: ReplayOptions & {
    settings?: Record<string, unknown>
    home?: string
    /** For the one test that has to let a cooldown pass. */
    now?: number
  } = {},
) {
  const replay = githubReplay(options)
  const home = options.home ?? tmp('tade-reviewer-home-')
  return {
    replay,
    home,
    host: ExtensionHost.load({
      builtin: [reviewExtension],
      config: {
        extensions: { review: options.settings ?? {} },
        projects: { api: { root: here() } },
      },
      home,
      env,
      fetch: replay.fetch,
      exec: async (command: string, args: readonly string[]) =>
        command === 'gh' ? replay.exec(command, args) : reallyExec(command, args),
      now: () => options.now ?? NOW,
    }),
  }
}

/** The grants a test writes in the config, host-qualified as a grant must be. */
export const granting = (each: Record<string, string[]>) => ({ ...each })

/**
 * A reviewer Tade started on one change, as the journal records one: a real
 * `schedules.jsonl` line and a real `watch_found`, because that is what
 * `review_publish` reads to decide who may publish.
 */
export function reviewerStarted(home: string, key: string, task: string): void {
  writeFileSync(
    join(home, 'schedules.jsonl'),
    `${JSON.stringify({
      op: 'set',
      by: 'you',
      at: '2026-09-01T00:00:00.000Z',
      schedule: {
        id: 'to-review-api',
        name: 'review.to-review',
        project: 'api',
        said: 'review the pull requests on acme/api',
        when: { every: '15m' },
        does: { kind: 'watch', watch: 'review.to-review', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-09-01T00:00:00.000Z',
      },
    })}\n`,
  )
  writeFileSync(
    join(home, 'events.jsonl'),
    `${JSON.stringify({
      seq: 1,
      ts: new Date(NOW - 10 * 60_000).toISOString(),
      type: 'watch_found',
      urgency: 'notable',
      task,
      detail: { schedule: 'to-review-api', key, title: 'review PR #412' },
    })}\n`,
  )
}

export const asReviewer = (task = 'api/review-412') => ({
  caller: { kind: 'agent' as const, task, project: 'api', cwd: here() },
})

export const findings = [
  {
    kind: 'defect',
    path: 'src/refunds.ts',
    line: 42,
    what: 'the retry drops the idempotency key',
    why: 'a timeout on the first attempt sends two refunds',
  },
]

/** Every comment this replay was asked to create, whatever endpoint it went to. */
export const posted = (replay: ReturnType<typeof githubReplay>) =>
  replay.calls.filter((call) => call.startsWith('POST') && call.includes('comments'))

/** One of this extension's watches, looked at in the project the fixture has. */
export const look = (host: ExtensionHost, watch: string) =>
  host.look(watch, {
    project: 'api',
    input: {},
    since: null,
    turnedOn: '2026-09-01T00:00:00Z',
  })

/**
 * A thread of Tade's own notes on #412, as the forge would report one.
 *
 * `by` is who posted it, and it is a parameter because the account Tade is
 * signed in as is not always the account that opened the review — which is
 * exactly the case where "skip our own replies" cannot be what keeps Tade from
 * answering itself.
 */
export function ourNote(
  replay: ReturnType<typeof githubReplay>,
  line: number,
  body: string,
  by = 'mujacica',
): void {
  const node = replay.pulls.find((one) => one.number === 412) as Record<string, unknown>
  ;(node.reviewThreads as { nodes: unknown[] }).nodes.push({
    id: `PRRT_tade${line}`,
    path: 'src/refunds.ts',
    line,
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [
        {
          id: `PRRC_tade${line}`,
          author: { login: by },
          createdAt: '2026-09-19T07:50:00Z',
          body: `${body}\n${marker(`${VERSION}/${findingId(findings[0] as never)}`)}`,
        },
      ],
    },
  })
}

/**
 * A journal and a schedule for each of the two reviewing watches, with one
 * line per finding Tade has already acted on.
 *
 * Real files, because that is what `found` reads and what decides every bound
 * on the loop: the rounds, the cooldown, who the reviewer of a change is, and
 * whether a fix is already running. A stub would answer whatever these tests
 * already believe.
 */
export function journal(
  home: string,
  each: readonly { key: string; task: string; at: number }[],
): void {
  writeFileSync(
    join(home, 'schedules.jsonl'),
    ['to-review', 'review-fix']
      .map(
        (watch) =>
          `${JSON.stringify({
            op: 'set',
            by: 'you',
            at: '2026-09-01T00:00:00.000Z',
            schedule: {
              id: `${watch}-api`,
              name: `review.${watch}`,
              project: 'api',
              said: `watch ${watch}`,
              when: { every: '15m' },
              does: {
                kind: 'watch',
                watch: `review.${watch}`,
                input: {},
                found: 'agent',
                most: 2,
              },
              missed: 'once',
              by: 'you',
              created: '2026-09-01T00:00:00.000Z',
            },
          })}\n`,
      )
      .join(''),
  )
  writeFileSync(
    join(home, 'events.jsonl'),
    each
      .map(
        (one, n) =>
          `${JSON.stringify({
            seq: n + 1,
            ts: new Date(one.at).toISOString(),
            type: 'watch_found',
            urgency: 'notable',
            task: one.task,
            detail: {
              schedule: one.key.includes('review-fix') ? 'review-fix-api' : 'to-review-api',
              key: one.key,
              title: 'something',
            },
          })}\n`,
      )
      .join(''),
  )
}
