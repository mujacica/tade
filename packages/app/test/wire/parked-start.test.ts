import type { Workbench } from '@tade/workbench'
import { readTaskFile } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, SPAWNING_MS, screenOf, until, windowUnderTest } from './harness.ts'

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
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    home = wired.home
  })

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
    ).rejects.toThrow(/is not work a schedule or a watch put to you: tade_queue_change/)

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

  it('says in words what else still holds it', async () => {
    const [check] = await parkedChecks()
    const task = check ?? ''
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    // A whole project's queue paused is another hold, and a start that picks
    // the work up leaves it standing — said, not swallowed.
    await tools.change({ project: 'app', change: 'pause' })
    const answer = await tools.change({ task, change: 'start' })
    expect(answer).toContain(`Done: ${task} is picked up.`)
    expect(answer).toContain(`${task} is paused with its project's queue`)
    expect(client.runs().some((run) => run.task === task)).toBe(false)
  })
})
