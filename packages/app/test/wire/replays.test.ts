import { finishedFrom, replayRecords } from '@tade/core'
import { readTaskFile, type Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type Repo, until, windowUnderTest } from './harness.ts'

// A replay, through the whole window: started by the orchestrator only on a
// line of the person's asking for an eval, made as queued work that waits for
// the time it was given, and stopped by the queue's own beat once what it has
// cost reaches the ceiling — before anything it would have stopped starts.

describe('the window, and a replay', () => {
  let repo: Repo
  let client: Workbench
  const { start } = windowUnderTest((wired) => {
    repo = wired.repo
    client = wired.client
  })

  /** One task that landed — merged — with its words, its base and its own commit. */
  const landed = async () => {
    const base = repo.head()
    const sha = repo.commit('Greet\n\nTade-Task: app/greet', {
      'src/greet.txt': 'hello\n',
      'test/greet.test.sh': 'grep -q hello src/greet.txt\n',
    })
    const at = (type: string, detail: Record<string, unknown>) =>
      client.log.append({ type: type as never, task: 'app/greet', detail })
    await at('task_created', {
      workspace: 'worktree',
      intent_spoken: 'add a greeting file that says hello',
      base,
    })
    await at('run_started', { harness: 'pi' })
    await at('commit_seen', { sha, project: 'app', at: new Date().toISOString(), added: 2 })
    await at('task_done', { by: 'rule', rule: 'merged' })
    return { base, sha }
  }

  it('starts one only when asked for an eval, waits for its time, and stops at its ceiling', async () => {
    const { base, sha } = await landed()
    const app = await start()
    const tools = app.queueTools().replay
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    const ask = {
      project: 'app',
      name: 'night',
      said: 'eval pi on my last task, a dollar at most',
      candidate: { harness: 'pi' },
      ceilingUsd: 1,
      at: tomorrow,
    }

    await client.log.append({ type: 'said', detail: { text: 'how is the login fix going?' } })
    await expect(tools.start(ask)).rejects.toThrow(/Nothing they have said lately asks for an eval/)
    expect(await readTaskFile(client.home, 'app/night-1')).toBeNull()

    await client.log.append({
      type: 'said',
      detail: { text: 'eval pi on my last task, a dollar at most' },
    })
    expect(await tools.start(ask)).toMatch(/^Replay night made: 1 task asked again/)
    const file = await readTaskFile(client.home, 'app/night-1')
    expect(file).toMatchObject({
      replay: 'night',
      intent_spoken: 'add a greeting file that says hello',
    })
    expect(file?.start).toMatchObject({ from: base, at: tomorrow })
    const started = replayRecords(await client.events({ types: ['replay_started'] }))
    expect(started.started.get('app/night')?.cases[0]?.original).toMatchObject({
      head: sha,
      tests: ['test/greet.test.sh'],
    })
    await until('the replay read, waiting for its time', async () =>
      (await tools.standing({ replay: 'night' })).includes('app/greet → app/night-1: waiting'),
    )

    // What it has cost reaches the ceiling: the next beat stops it before it starts.
    await client.log.append({
      type: 'usage',
      task: 'app/night-1',
      run: 'app/night-1/agent',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 100, usd: 1.5, priced: 'exact' },
    })
    await until('stopped at its ceiling', async () => {
      await app.advanceQueue()
      return (await client.events({ types: ['replay_stopped'] })).length > 0
    })
    const done = finishedFrom(await client.events({ types: ['task_done'] }))
    expect(done.get('app/night-1')?.summary).toBe('stopped: replay night reached its $1.00 ceiling')
    expect((await client.events({ types: ['run_started'], task: 'app/night-1' })).length).toBe(0)
    await until('said as stopped, never as failed', async () => {
      const said = await tools.standing({})
      return said.includes('The ceiling stopped it') && said.includes('stopped at the ceiling')
    })
    // Once: a second beat writes nothing more.
    await app.advanceQueue()
    expect(await client.events({ types: ['replay_stopped'] })).toHaveLength(1)
  })

  it('grades an entrant that finished with work, once, on the queue’s own beat', async () => {
    await landed()
    const app = await start()
    await client.log.append({ type: 'said', detail: { text: 'benchmark pi on my last task' } })
    await app.queueTools().replay.start({
      project: 'app',
      name: 'graded',
      said: 'benchmark pi on my last task',
      candidate: { harness: 'pi' },
      ceilingUsd: 5,
      at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    // What its agent would have left: a commit in its own worktree, and the
    // journal saying it is finished.
    const file = await readTaskFile(client.home, 'app/graded-1')
    const worktree = (await client.events({ types: ['task_created'], task: 'app/graded-1' }))[0]
      ?.detail.worktree
    if (typeof worktree !== 'string' || !file) throw new Error('no entrant')
    repo.commit('Greet\n\nTade-Task: app/graded-1', { 'src/greet.txt': 'hello there\n' }, worktree)
    await client.markDone('app/graded-1', { by: 'rule', summary: 'committed' })
    await until('graded, once', async () => {
      await app.advanceQueue()
      return (await client.events({ types: ['replay_graded'] })).length > 0
    })
    const [graded] = await client.events({ types: ['replay_graded'] })
    // The fixture says nothing to check, which is said as that and never as a pass.
    expect(graded?.task).toBe('app/graded-1')
    expect(graded?.detail).toMatchObject({ state: 'could not run', laid: ['test/greet.test.sh'] })
    await app.advanceQueue()
    expect(await client.events({ types: ['replay_graded'] })).toHaveLength(1)
    await until('read as unscored, with why', async () =>
      (await app.queueTools().replay.standing({ replay: 'graded' })).includes(
        'unscored (its grading run could not run: the project says nothing to check)',
      ),
    )
  })

  it('says there is none, and which there are', async () => {
    const app = await start()
    expect(await app.queueTools().replay.standing({ replay: 'nope' })).toBe(
      'There is no replay called nope. Start one with tade_replay when they ask for an eval.',
    )
  })
})
