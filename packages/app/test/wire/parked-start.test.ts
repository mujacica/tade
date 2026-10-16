import { ConfigSchema } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { readTaskFile } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// Work a watch made parked for somebody to pick up — the jev.mistakes watch's
// checks are the case that found it — waits for a person or the orchestrator
// to say go, and nothing else. Saying it used to be refused: Start now on its
// card did nothing, and `tade_queue_change` with `start` threw "is parked:
// pick it up again before it can start". One press is the whole act now
// (`pickUpToStart`), and the journal says whose it was.

describe('parked work in the window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    home = wired.home
    repo = wired.repo
  })

  /**
   * Point at a queue row, so its controls take the place of when, and press
   * its ▶. By as much of its name as the side has room for, which is found
   * there before the card's header, since `find` reads from the bottom up.
   */
  async function play(name: string): Promise<void> {
    const row = find(name)
    terminal.press(`\x1b[<35;${row.col + 1};${row.row + 1}M`)
    await until('its controls', () => (screenOf(terminal.written)[row.row] ?? '').includes('▶'))
    click((screenOf(terminal.written)[row.row] ?? '').indexOf('▶'), row.row)
  }

  /** Two checks the way a watch makes them: queued work, parked by the schedule. */
  async function parkedChecks(): Promise<string[]> {
    await client.setSchedule(
      {
        id: 'jev-mistakes-app',
        name: 'jev.mistakes',
        project: 'app',
        said: 'propose a check for a mistake made twice',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'jev.mistakes', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-10-16T08:00:00.000Z',
      },
      'you',
    )
    const made: string[] = []
    for (const name of ['error-swallowed', 'kind-fixture']) {
      const found = await client.watchFound(
        'jev-mistakes-app',
        { key: name, title: `a mistake made twice: ${name}` },
        {
          agent: { title: `check for ${name}`, prompt: `Add a check for ${name}.`, parked: true },
        },
      )
      made.push(found.task ?? '')
    }
    return made
  }

  it('never starts it by itself, however often the queue looks', async () => {
    const [check] = await parkedChecks()
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await until('the queue has it', async () => (await tools.describe()).includes(check ?? '-'))
    // The pass itself, asked directly, rather than a wait on the clock: each is
    // a whole look at the queue, and none of them starts parked work.
    for (let pass = 0; pass < 3; pass++) expect(await tools.advance()).toEqual([])
    expect(client.runs()).toEqual([])
    expect((await readTaskFile(home, check ?? ''))?.parked).toBe(true)
  })

  it('starts it from its card in one press, as the person', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const [check] = await parkedChecks()
    const task = check ?? ''
    await start()
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('check-for-error-swallowed')),
    )
    const row = find('check-for-error-swallowed')
    terminal.written = ''
    click(row.col + 1, row.row)
    await until('its card', () => terminal.written.includes('Add a check for error-swallowed.'))
    const button = find('Start now')
    click(button.col + 2, button.row)
    await until('it started', () => client.runs().some((run) => run.task === task), SPAWNING_MS)
    expect((await readTaskFile(home, task))?.parked).toBe(false)
    const lines = await client.events({ types: ['state_change', 'queue_changed'], task })
    expect(lines.map((one) => [one.detail.state ?? one.detail.change, one.detail.by])).toEqual([
      ['parked', 'schedule:jev-mistakes-app'],
      ['resumed', 'you'],
      ['start', 'you'],
    ])
  })

  it('starts it when the orchestrator calls tade_queue_change with start', async () => {
    const [, check] = await parkedChecks()
    const task = check ?? ''
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    // Not a proposal: the watch made it for a person, so there is nothing for
    // tade_proposal_decide to decide, and that door says which one to use.
    await expect(
      tools.decide({ task, decision: 'start', because: 'the person asked for it' }),
    ).rejects.toThrow(/is not work put to you to decide — .*: tade_queue_change/)

    const answer = await tools.change({ task, change: 'start' })
    expect(answer).toContain(`Done: ${task} is picked up.`)
    await until('it started', () => client.runs().some((run) => run.task === task), SPAWNING_MS)
    const lines = await client.events({ types: ['state_change', 'queue_changed'], task })
    expect(lines.map((one) => [one.detail.state ?? one.detail.change, one.detail.by])).toEqual([
      ['parked', 'schedule:jev-mistakes-app'],
      ['resumed', 'orchestrator'],
      ['start', 'orchestrator'],
    ])
  })

  // The ▶ a parked row shows under the pointer was a resume, which lifts no
  // park: six presses on 2026-10-16 wrote six `resume` lines and started
  // nothing. It is a start now, the same press as Start now.
  it('starts a parked row with one press of its ▶', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const [check] = await parkedChecks()
    const task = check ?? ''
    await start()
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('check-for-err')),
    )
    await play('check-for-err')
    await until('it started', () => client.runs().some((run) => run.task === task), SPAWNING_MS)
    const lines = await client.events({ types: ['state_change', 'queue_changed'], task })
    expect(lines.map((one) => [one.detail.state ?? one.detail.change, one.detail.by])).toEqual([
      ['parked', 'schedule:jev-mistakes-app'],
      ['resumed', 'you'],
      ['start', 'you'],
    ])
  })

  it('starts a row paused on its own, or with its queue, with its ▶ and nothing else', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    // The whole queue paused before any of it is made, so nothing starts by
    // rule; one piece is paused on its own as well.
    await tools.change({ project: 'app', change: 'pause' })
    await client.planTasks({
      project: 'app',
      said: 'later',
      agents: [
        { name: 'solo', said: 'one', prompt: '', after: [], touches: [] },
        { name: 'grouped', said: 'two', prompt: '', after: [], touches: [] },
        { name: 'stays', said: 'three', prompt: '', after: [], touches: [] },
      ],
    })
    await client.changeQueued({ task: 'app/solo', change: 'pause', by: 'you' })
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('grouped')),
    )
    await play('solo')
    await until(
      'both its pauses lifted by the press',
      () => client.runs().some((run) => run.task === 'app/solo'),
      SPAWNING_MS,
    )
    await play('grouped')
    await until(
      'the queue’s pause lifted for that one',
      () => client.runs().some((run) => run.task === 'app/grouped'),
      SPAWNING_MS,
    )
    // The rest of the queue is still paused: a start is about one piece. The
    // first pass asked for may be the press's own, still under way — a pass is
    // single-flight — so it is the one after it that has to start nothing.
    await tools.advance()
    expect(await tools.advance()).toEqual([])
    expect(client.runs().some((run) => run.task === 'app/stays')).toBe(false)
    expect(await tools.describe()).toContain('app/stays — paused with the queue')
  })

  it('says in words what else still holds it', async () => {
    const [check] = await parkedChecks()
    const task = check ?? ''
    // One agent at a time in this project, and one already at work: picking
    // the parked one up does not make room, and the answer says what it waits for.
    const window = await start({
      config: ConfigSchema.parse({ projects: { app: { root: repo.root, max_parallel: 1 } } }),
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'one at work',
      agents: [{ name: 'at-work', said: 'one', prompt: '', after: [], touches: [] }],
    })
    await until('the slot taken', () => client.runs().some((run) => run.task === 'app/at-work'))
    const answer = await tools.change({ task, change: 'start' })
    expect(answer).toContain(`Done: ${task} is picked up.`)
    expect(answer).toContain(`${task} is next, and starts as soon as its project has room`)
    expect(client.runs().some((run) => run.task === task)).toBe(false)
  })
})
