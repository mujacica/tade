import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// What starts by itself and what holds it: a rule met, a dependency that
// stopped, a plan that runs into the tree it was written against.

describe('the window, and the work waiting in it', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  it("writes a task's own rule down once it is met, and only then", async () => {
    const worktree = join(repo.root, '..', 'worktrees', 'app-refunds')
    const file = join(worktree, '.tade', 'task.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}done: committed\n`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Its agent ran and ended a turn, but nothing is committed: not yet.
    await client.log.append({ type: 'run_started', task: 'app/refunds', detail: {} })
    await client.log.append({ type: 'turn_done', task: 'app/refunds', detail: { status: 'ok' } })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(await client.events({ types: ['task_done'] })).toEqual([])
    repo.commit('refunds charge once', { 'refunds.ts': 'once' }, worktree)
    await until(
      'the rule written down',
      async () => (await client.events({ types: ['task_done'] })).length === 1,
      15_000,
    )
    const [done] = await client.events({ types: ['task_done'] })
    expect(done).toMatchObject({ task: 'app/refunds', detail: { by: 'rule', rule: 'committed' } })
  }, 30_000)

  it('starts what can start, and the rest once what it waits on has finished', async () => {
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const answer = await window.queueTools().plan({
      project: 'app',
      said: 'charge once, then give refunds back',
      agents: [
        { name: 'charge-once', said: 'charge once', prompt: '', after: [], touches: ['charge.ts'] },
        {
          name: 'refund-back',
          said: 'then give refunds back',
          prompt: '',
          after: [{ agent: 'charge-once', why: 'both change charge.ts' }],
          touches: ['charge.ts'],
        },
      ],
    })
    expect(answer).toContain('Started charge-once.')
    expect(answer).toContain('Queued refund-back (after app/charge-once).')
    expect(client.runs().map((run) => run.task)).toEqual(['app/charge-once'])

    // Nobody asks: the first finishing is what starts the second.
    await client.markDone('app/charge-once', { by: 'you' })
    await until(
      'the second started',
      () => client.runs().some((run) => run.task === 'app/refund-back'),
      SPAWNING_MS,
    )
    await until(
      'why it started, written down',
      async () =>
        (await client.events({ types: ['queue_started'], task: 'app/refund-back' }))[0]?.detail
          .why === 'app/charge-once has finished',
    )
  }, 60_000)

  it('shows queued work under the agents, opens it, and starts it from its card', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'look first, then fix',
      agents: [
        { name: 'look-first', said: 'look first', prompt: '', after: [], touches: [] },
        {
          name: 'fix-after',
          said: 'then fix',
          prompt: 'fix what look-first found',
          after: [{ agent: 'look-first', why: 'it needs what that finds' }],
          touches: [],
        },
      ],
    })
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('SMART QUEUE')),
    )
    const tab = find('fix-after')
    terminal.written = ''
    click(tab.col + 1, tab.row)
    await until('its card', () => terminal.written.includes('it needs what that finds'))
    expect(terminal.written).toContain('fix what look-first found')
    // Looking at queued work is not starting it: clicking the row shows what it
    // waits on and what it will be told, and nothing has run.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(client.runs().some((run) => run.task === 'app/fix-after')).toBe(false)
    const button = find('Start now')
    click(button.col + 2, button.row)
    await until(
      'it started',
      () => client.runs().some((run) => run.task === 'app/fix-after'),
      SPAWNING_MS,
    )
  }, 60_000)

  it('warns when a plan runs into work the project already has, which no plan can see', async () => {
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'fix the charge, then bill for it',
      agents: [
        { name: 'charge-first', said: 'fix the charge', prompt: '', after: [], touches: [] },
        {
          name: 'bill-after',
          said: 'then bill for it',
          prompt: '',
          after: [{ agent: 'charge-first', why: 'it changes how a charge is made' }],
          touches: ['src/charge.ts'],
        },
      ],
    })
    const answer = await window.queueTools().plan({
      project: 'app',
      said: 'now refunds',
      agents: [
        {
          name: 'refunds-next',
          said: 'now refunds',
          prompt: '',
          after: [],
          touches: ['src/charge.ts'],
        },
      ],
    })
    expect(answer).toContain(
      'Watch out: refunds-next and app/bill-after, which is queued, both change src/charge.ts',
    )
  }, 60_000)

  it('pauses one piece of queued work from its card, and there is no pause-everything button', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'one now, one after',
      agents: [
        { name: 'first-one', said: 'one now', prompt: '', after: [], touches: [] },
        {
          name: 'second-one',
          said: 'one after',
          prompt: '',
          after: [{ agent: 'first-one', why: 'they touch the same thing' }],
          touches: [],
        },
      ],
    })
    // The scope, as the plain skin draws it: the one showing is a chip that is
    // on, the other a chip at rest. Nothing here is on a clock, so the `timed`
    // switch is not drawn at all — a control that could neither show nor hide
    // anything reads as a label.
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('<all> [next]')),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('timed'))).toBe(false)
    // Nothing over the queue pauses everything at once: the controls, and no more.
    expect(screenOf(terminal.written).some((row) => row.includes('‖ pause'))).toBe(false)

    // Looking at it is not starting it: its card says which one you are pausing.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.slice(0, 28).includes('second-one'))
    expect(row).toBeGreaterThanOrEqual(0)
    click((lines[row]?.indexOf('second-one') ?? 0) + 1, row)
    await until('its card', () =>
      screenOf(terminal.written).some(
        (line) => line.includes('‖ Pause') && line.includes('second-one'),
      ),
    )
    const pause = find('‖ Pause')
    click(pause.col + 1, pause.row)
    await until('that one paused', async () =>
      /app\/second-one — paused/.test(await window.queueTools().describe()),
    )
    // Its own work finishing starts nothing while it is paused.
    await client.markDone('app/first-one', { by: 'you' })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)

    const resume = find('▶ Resume')
    click(resume.col + 1, resume.row)
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      SPAWNING_MS,
    )
  }, 60_000)

  it('still holds a whole project’s queue when the orchestrator asks, with no button for it', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'one now, one after',
      agents: [
        { name: 'first-one', said: 'one now', prompt: '', after: [], touches: [] },
        {
          name: 'second-one',
          said: 'one after',
          prompt: '',
          after: [{ agent: 'first-one', why: 'they touch the same thing' }],
          touches: [],
        },
      ],
    })
    await window.queueTools().change({ project: 'app', change: 'pause' })
    // Its own work finishing starts nothing while the queue is held.
    await client.markDone('app/first-one', { by: 'you' })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)
    expect(await window.queueTools().describe()).toContain('paused with the queue')

    await window.queueTools().change({ project: 'app', change: 'resume' })
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      SPAWNING_MS,
    )
  }, 60_000)

  it('looks at the tree before it starts queued work, and holds what has moved under it', async () => {
    const told: string[] = []
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'fix the charge, have a look, then write both of them up',
      agents: [
        {
          name: 'fix-charge',
          said: 'fix the charge',
          prompt: 'fix it',
          after: [],
          touches: ['charge.ts'],
        },
        { name: 'look-around', said: 'have a look', prompt: 'look', after: [], touches: [] },
        {
          name: 'write-up',
          said: 'write up the charge',
          prompt: 'write up how charging works',
          after: [{ agent: 'look-around', why: 'it needs what that finds' }],
          touches: ['charge.ts'],
        },
        {
          name: 'mail-notes',
          said: 'write up the mailer',
          prompt: 'write up how mail works',
          after: [{ agent: 'look-around', why: 'it needs what that finds' }],
          touches: ['mail.ts'],
        },
      ],
    })
    await until('the first two started', () => client.runs().length === 2, SPAWNING_MS)

    // The agent at work commits the very file the write-up was planned
    // around. Its trailer is what says whose the commit is.
    repo.write({ 'charge.ts': 'charge once\n' })
    repo.git('add', 'charge.ts')
    repo.git('commit', '-q', '-m', 'charge once\n\nTade-Task: app/fix-charge')
    await client.markDone('app/look-around', { by: 'you' })

    // Nobody has been near the mailer, so that one starts by rule as it always did.
    await until(
      'the one nobody collided with started',
      () => client.runs().some((run) => run.task === 'app/mail-notes'),
      SPAWNING_MS,
    )
    // The other is held on the evidence, with the files and whose they are.
    const [held] = await client.events({ types: ['queue_held'], task: 'app/write-up' })
    expect(held).toMatchObject({
      task: 'app/write-up',
      detail: { changed: ['charge.ts'], by: ['app/fix-charge'] },
    })
    expect(String(held?.detail.because)).toBe(
      'app/fix-charge, which is working, has already changed charge.ts, which this was planned to change',
    )
    expect(client.runs().some((run) => run.task === 'app/write-up')).toBe(false)
    await until('the orchestrator told', () =>
      told.some((text) => text.includes('app/write-up is held')),
    )
    expect(told.find((text) => text.includes('app/write-up is held'))).toContain(
      'It was planned against code that has moved since',
    )

    // Said once: the hold is not repeated at every look while it waits.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect((await client.events({ types: ['queue_held'], task: 'app/write-up' })).length).toBe(1)

    // The person's answer is written down, read back, and it starts.
    expect(await tools.change({ task: 'app/write-up', change: 'start', by: 'you' })).toBe(
      'Done. Started app/write-up.',
    )
    const [started] = await client.events({ types: ['queue_started'], task: 'app/write-up' })
    expect(started?.detail.why).toBe('it was started anyway')
  }, 60_000)

  it('holds work whose dependency stopped, tells the orchestrator, and starts it when told to', async () => {
    const told: string[] = []
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'first, then second',
      agents: [
        { name: 'first', said: 'first', prompt: '', after: [], touches: [] },
        {
          name: 'second',
          said: 'second',
          prompt: '',
          after: [{ agent: 'first', why: '' }],
          touches: [],
        },
      ],
    })
    await client.stopAgent('app/first')
    await until(
      'the hold written down',
      async () => (await client.events({ types: ['queue_held'] })).length === 1,
      10_000,
    )
    await until('the orchestrator told', () =>
      told.some((text) => text.includes('app/second is held')),
    )
    expect(await tools.describe()).toContain(
      'app/second — held: app/first was stopped before it finished',
    )

    expect(await tools.change({ task: 'app/second', change: 'start' })).toBe(
      'Done. Started app/second.',
    )
    expect(client.runs().some((run) => run.task === 'app/second')).toBe(true)
  }, 60_000)
})
