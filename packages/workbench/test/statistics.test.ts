import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// What agents actually produced, written down once.
//
// Commits and check runs are the two statistics that cannot be recovered by
// asking again later: `git log` gives a different answer after every rebase,
// and a worktree's `.tade/checks.jsonl` goes entirely when the worktree does.
// So both are kept at the moment they are true, keyed by something stable, and
// these are the tests that say so.

describe('writing down what was produced', () => {
  let home: string
  let repo: ReturnType<typeof mkrepo>
  let tade: Workbench | null = null

  const open = () => Workbench.open({ home })

  beforeEach(() => {
    home = tmp('tade-stats-')
    repo = mkrepo()
    // A repository somebody has been working in for a year before they ever
    // installed Tade, which is what every real one looks like. mkrepo's own
    // history is seconds old, and a fixture whose past is younger than the
    // window is kinder than reality: it would let the floor go untested.
    execFileSync('git', ['commit', '--amend', '--no-edit', '--quiet'], {
      cwd: repo.root,
      env: { ...process.env, GIT_COMMITTER_DATE: '2025-01-05T09:00:00Z' },
      stdio: 'pipe',
    })
    writeFileSync(join(home, 'config.yaml'), `projects:\n  shop:\n    root: ${repo.root}\n`, 'utf8')
  })

  afterEach(async () => {
    await tade?.close().catch(() => {})
    tade = null
  })

  it('counts a commit once, however often it is looked at', async () => {
    tade = await open()
    repo.commit('retry refunds\n\nTade-Task: shop/refunds', { 'refunds.ts': 'one\ntwo\n' })

    await tade.lookAtCommits()
    await tade.lookAtCommits()

    const seen = await tade.events({ types: ['commit_seen'] })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.task).toBe('shop/refunds')
    expect(seen[0]?.detail).toMatchObject({ attributed: true, added: 2, removed: 0, files: 1 })
  })

  it('leaves a commit with no trailer belonging to nobody, and still counts it', async () => {
    tade = await open()
    repo.commit('a person committing by hand', { 'by-hand.ts': 'x\n' })

    await tade.lookAtCommits()

    const seen = await tade.events({ types: ['commit_seen'] })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.task).toBeNull()
    // Counted as the project's rather than guessed on to whichever agent
    // happened to be running when it landed.
    expect(seen[0]?.detail).toMatchObject({ attributed: false, project: 'shop' })
  })

  it('does not count the history that was there before Tade ever ran', async () => {
    // mkrepo's own first commit predates this window. A project's first open
    // dumping years of somebody else's history into today is a chart that
    // spikes on the day you installed something, which nobody trusts again.
    tade = await open()
    expect(await tade.events({ types: ['commit_seen'] })).toEqual([])
  })

  it('picks up a check run nobody was watching, once', async () => {
    // `tade check` on the command line runs with no window, and a second
    // writer in one journal would interleave with the window's. So the run it
    // wrote is read by whichever window opens next, keyed by the run's own id.
    mkdirSync(join(repo.root, '.tade'), { recursive: true })
    writeFileSync(
      join(repo.root, '.tade', 'checks.jsonl'),
      `${JSON.stringify({
        id: 'abc1234:types:here:0',
        check: 'types',
        commit: 'abc1234',
        state: 'failed',
        where: { kind: 'here', runner: 'local', host: '' },
        required: true,
        startedAt: '2026-09-20T10:00:00.000Z',
        finishedAt: '2026-09-20T10:00:04.000Z',
        code: 1,
        summary: '3 errors',
        by: 'you',
        tail: '',
      })}\n`,
      'utf8',
    )

    tade = await open()
    await tade.lookAtChecks()

    const ran = await tade.events({ types: ['check_ran'] })
    expect(ran).toHaveLength(1)
    expect(ran[0]?.detail).toMatchObject({
      check: 'types',
      state: 'failed',
      required: true,
      where: 'here',
      runner: 'local',
      ms: 4_000,
    })
  })

  it('opens without trouble where a project root is not a repository', async () => {
    // Counting things may never be the reason a window fails to open.
    writeFileSync(join(home, 'config.yaml'), 'projects:\n  gone:\n    root: /not/here\n', 'utf8')
    tade = await open()
    expect(await tade.events({ types: ['commit_seen'] })).toEqual([])
  })
})
