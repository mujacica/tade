import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replayRecords } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { gradeEntrant, landedCases, startReplay } from '../src/replays.ts'
import { taskSaid } from '../src/task-said.ts'
import { beginFrom, readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// A replay against real git and a real journal: what landed read back as
// cases, started at each one's own base in a worktree of its own, and graded
// with the original's tests laid over its work — the entrant's branch exactly
// where it was afterwards.

/** Runs every test file in `test/`: the project's one check. */
const TESTS = `sh -c 'for f in test/*.sh; do sh "$f" || exit 1; done'`

describe('a replay', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  let base: string
  let landed: string

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-replays-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n    test_command: ${JSON.stringify(TESTS)}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    base = repo.head()
    // The original: a greeting and the test it added, committed under its trailer.
    landed = repo.commit('Greet\n\nTade-Task: app/greet', {
      'src/greet.txt': 'hello\n',
      'test/greet.test.sh': 'grep -q hello src/greet.txt\n',
    })
    repo.commit('later work by somebody else', { 'README.md': '# moved on\n' })
    const at = (task: string, type: string, detail: Record<string, unknown>) =>
      client.log.append({ type: type as never, task, detail })
    await at('app/greet', 'task_created', {
      workspace: 'checkout',
      intent_spoken: 'add a greeting file that says hello',
      base,
    })
    await at('app/greet', 'run_started', { harness: 'claude-code', model: 'opus' })
    await at('app/greet', 'commit_seen', {
      sha: landed,
      project: 'app',
      at: '2026-10-10T10:00:00.000Z',
      added: 2,
      removed: 0,
    })
    await at('app/greet', 'task_done', { by: 'you', summary: 'done' })
    // And one whose words were an answer to a conversation nobody kept.
    await at('app/yes', 'task_created', { workspace: 'checkout', intent_spoken: 'yes do it', base })
    await at('app/yes', 'run_started', { harness: 'claude-code' })
    await at('app/yes', 'commit_seen', {
      sha: landed,
      project: 'app',
      at: '2026-10-09T10:00:00.000Z',
    })
    await at('app/yes', 'task_done', { by: 'you', summary: 'done' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const deps = () => ({
    home,
    config: client.config,
    log: client.log,
    planTasks: client.planTasks.bind(client),
    now: Date.now(),
  })

  it('reads what landed as cases: its words, its base, its size and the tests it added', async () => {
    const cases = await landedCases({
      home,
      config: client.config,
      project: 'app',
      events: await client.events({}),
      now: Date.now(),
    })
    // Newest finished first.
    expect(cases.map((one) => one.task)).toEqual(['app/yes', 'app/greet'])
    expect(cases[1]).toMatchObject({
      said: 'add a greeting file that says hello',
      base,
      baseThere: true,
      harness: 'claude-code',
      size: { added: 2, removed: 0 },
      tests: ['test/greet.test.sh'],
      head: landed,
    })
  })

  it('holds each case on the harness it first ran on and moves only the model', async () => {
    const made = await startReplay(deps(), {
      project: 'app',
      name: 'sonnet',
      said: 'eval sonnet on my last two',
      candidate: { model: 'sonnet' },
      ceilingUsd: 3,
      by: 'you',
    })
    const file = await readTaskFile(home, 'app/sonnet-1')
    expect(file).toMatchObject({ replay: 'sonnet', harness: 'claude-code' })
    expect(file?.start?.model?.id).toContain('sonnet')
    // Never in the scorecards: a measurement is not work that was asked for.
    const created = await client.events({ types: ['task_created'], task: 'app/sonnet-1' })
    expect(created[0]?.detail.replay).toBe('sonnet')
    expect(made.made.made).toHaveLength(1)
    // A measurement is never pushed or put up for review: what its agent is told reads this.
    expect((await taskSaid(home, 'app/sonnet-1')).replay).toBe(true)
    expect((await taskSaid(home, 'app/greet')).replay).toBe(false)
  })

  it('varies the harness alone, and grades the work with the original’s tests laid over it', async () => {
    const made = await startReplay(deps(), {
      project: 'app',
      name: 'pi-run',
      said: 'benchmark pi on the last two',
      candidate: { harness: 'pi' },
      ceilingUsd: 3,
      by: 'you',
    })
    expect(made.cases).toMatchObject([
      { of: 'app/yes', task: null, couldNot: expect.stringContaining('too few') },
      {
        of: 'app/greet',
        task: 'app/pi-run-1',
        couldNot: null,
        original: { head: landed, tests: ['test/greet.test.sh'], size: { added: 2, removed: 0 } },
      },
    ])
    const [entrant] = made.made.made
    if (!entrant) throw new Error('no entrant')
    expect(entrant.workspace).toBe('worktree')
    const file = await readTaskFile(home, entrant.id)
    expect(file).toMatchObject({
      replay: 'pi-run',
      harness: 'pi',
      intent_spoken: 'add a greeting file that says hello',
      done: 'committed',
    })
    expect(file?.start?.prompt).toBe('add a greeting file that says hello')
    expect(file?.start?.from).toBe(base)
    const started = replayRecords(await client.events({ types: ['replay_started'] }))
    expect(started.started.get('app/pi-run')).toMatchObject({
      candidate: { harness: 'pi' },
      ceilingUsd: 3,
      said: 'benchmark pi on the last two',
    })
    // What the queue does when it starts it: the worktree moved to the base.
    await beginFrom(home, entrant.worktree, entrant.id, [base])
    expect(runGit(entrant.worktree, 'rev-parse', 'HEAD').trim()).toBe(base)

    // Its agent's work: a greeting that does not say hello, so the original's test fails.
    repo.commit('Greet', { 'src/greet.txt': 'hi\n' }, entrant.worktree)
    const grade = () =>
      gradeEntrant({
        config: client.config,
        project: 'app',
        task: entrant.id,
        replay: 'pi-run',
        worktree: entrant.worktree,
        from: landed,
        tests: ['test/greet.test.sh'],
        home,
        tadeHome: home,
        log: client.log,
      })
    const head = runGit(entrant.worktree, 'rev-parse', 'HEAD').trim()
    expect(await grade()).toEqual({ state: 'failed', failed: ['tests'] })
    // Back on its own branch, at its own head, with nothing of the original's left in it.
    expect(runGit(entrant.worktree, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(entrant.branch)
    expect(runGit(entrant.worktree, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(runGit(entrant.worktree, 'status', '--porcelain').trim()).toBe('')

    repo.commit('Say hello', { 'src/greet.txt': 'hello there\n' }, entrant.worktree)
    expect(await grade()).toEqual({ state: 'passed', failed: [] })
    const graded = replayRecords(await client.events({ types: ['replay_graded'] })).graded
    expect(graded.get(entrant.id)).toMatchObject({
      state: 'passed',
      laid: ['test/greet.test.sh'],
    })
  })

  it('will not grade a worktree with changes nobody committed', async () => {
    const made = await startReplay(deps(), {
      project: 'app',
      name: 'dirty',
      said: 'benchmark pi',
      candidate: { harness: 'pi' },
      ceilingUsd: 3,
      by: 'you',
    })
    const [entrant] = made.made.made
    if (!entrant) throw new Error('no entrant')
    await beginFrom(home, entrant.worktree, entrant.id, [base])
    writeFileSync(join(entrant.worktree, 'README.md'), 'half done\n')
    const graded = await gradeEntrant({
      config: client.config,
      project: 'app',
      task: entrant.id,
      replay: 'dirty',
      worktree: entrant.worktree,
      from: landed,
      tests: ['test/greet.test.sh'],
      home,
      tadeHome: home,
      log: client.log,
    })
    expect(graded.state).toBe('could not run')
  })
})
