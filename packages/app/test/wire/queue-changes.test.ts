import type { PlannedAgent } from '@tade/core'
import { makeCollector, type StatusCollector } from '@tade/status'
import { readTaskFile, type Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Live } from '../../src/live.ts'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// Changing a plan once it is made, through the window: a wait written on the
// work rather than the work removed and planned again, and every change
// answered with where the work stands after the queue has looked again.
//
// On 2026-10-11 two holds became nineteen removals and twenty plans, because
// `wait` answered "waits again" while the task was held again in the same
// second, and there was no way to say "after that one" about work already made.

/** What removing queued work that never started tells the orchestrator, after its name. */
const inPlace =
  'had not started. To change what queued work is told or when it starts, tade_queue_change retell (prompt, touches) and after change it in place; removing it uses its name for good, so planning it again needs a new one.'

describe('changing work already queued', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find, beats } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  /** A window whose orchestrator's messages are kept, so what it was told can be read. */
  async function opened(told: string[]) {
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    return window.queueTools()
  }

  it('answers a wait with the hold it found, and turns that hold into a wait on the work changing the file', async () => {
    const told: string[] = []
    const tools = await opened(told)
    await tools.plan({
      project: 'app',
      said: 'fix the charge, have a look, then write the charge up',
      agents: [
        { name: 'fix-charge', said: 'fix', prompt: 'fix it', after: [], touches: ['charge.ts'] },
        { name: 'look-around', said: 'look', prompt: 'look', after: [], touches: [] },
        {
          name: 'write-up',
          said: 'write it up',
          prompt: 'write up how charging works',
          after: [{ agent: 'look-around', why: 'it needs what that finds' }],
          touches: ['charge.ts'],
        },
      ],
    })
    await until('the first two started', () => client.runs().length === 2, SPAWNING_MS)
    // Changed under it and not committed, by somebody in the same checkout.
    repo.write({ 'charge.ts': 'charge once\n' })
    await client.markDone('app/look-around', { by: 'you' })
    const holds = async () => client.events({ types: ['queue_held'], task: 'app/write-up' })
    await until('held on the tree', async () => (await holds()).length === 1, 10_000)
    const heldSaid = () => told.filter((text) => text.includes('app/write-up is held')).length
    await until('the orchestrator told', () => heldSaid() === 1)

    // `wait` looks again from now. It is not "wait for the files", and the
    // answer says what it found rather than what it was meant to do.
    const waited = await tools.change({ task: 'app/write-up', change: 'wait' })
    expect(waited).toContain(
      'Done. app/write-up is held: charge.ts, which this was planned to change',
    )
    expect(waited).toContain(
      'That heals by itself — the first look that finds those files settled starts it.',
    )
    // Written down again, because a wait is an answer — and told once, in the
    // answer, rather than again a turn later.
    expect((await holds()).length).toBe(2)
    await beats(3)
    expect(heldSaid()).toBe(1)

    // The one call the whole incident needed: wait on the work changing it.
    expect(
      await tools.change({
        task: 'app/write-up',
        change: 'after',
        after: [{ task: 'fix-charge', why: 'it is changing charge.ts' }],
      }),
    ).toBe(
      'Done. app/write-up waits on app/fix-charge, and starts by itself once that has finished.',
    )
    expect((await readTaskFile(home, 'app/write-up'))?.start?.after).toEqual([
      { task: 'app/look-around', why: 'it needs what that finds' },
      { task: 'app/fix-charge', why: 'it is changing charge.ts' },
    ])
    expect(await tools.describe()).toContain('app/write-up — after app/fix-charge')

    repo.git('add', 'charge.ts')
    repo.git('commit', '-q', '-m', 'charge once\n\nTade-Task: app/fix-charge')
    await client.markDone('app/fix-charge', { by: 'you' })
    await until(
      'the write-up started by itself',
      () => client.runs().some((run) => run.task === 'app/write-up'),
      SPAWNING_MS,
    )
    await until(
      'why it started, written down',
      async () =>
        (await client.events({ types: ['queue_started'], task: 'app/write-up' }))[0]?.detail.why ===
        'app/look-around and app/fix-charge have finished',
    )
  })

  it('names what waited on work it removes, and a replaced wait puts it back on its way', async () => {
    const told: string[] = []
    const tools = await opened(told)
    await tools.plan({
      project: 'app',
      said: 'a, then b, then c',
      agents: [
        { name: 'step-a', said: 'a', prompt: '', after: [], touches: [] },
        {
          name: 'step-b',
          said: 'b',
          prompt: '',
          after: [{ agent: 'step-a', why: '' }],
          touches: [],
        },
        {
          name: 'step-c',
          said: 'c',
          prompt: '',
          after: [{ agent: 'step-b', why: 'needs b' }],
          touches: [],
        },
      ],
    })
    await until(
      'a started',
      () => client.runs().some((run) => run.task === 'app/step-a'),
      SPAWNING_MS,
    )

    expect(await tools.change({ task: 'app/step-b', change: 'remove' })).toBe(
      'app/step-b is removed. app/step-c waited on it: app/step-c is held: app/step-b was removed before it finished. It stays held until it is answered: start it anyway, change what it waits on (after, with replace to drop app/step-b), or remove it. ' +
        `app/step-b ${inPlace}`,
    )
    expect(
      await tools.change({
        task: 'app/step-c',
        change: 'after',
        after: [{ task: 'step-a', why: 'what b was for' }],
        replace: true,
      }),
    ).toBe('Done. app/step-c waits on app/step-a, and starts by itself once that has finished.')
    // Each was in the answer the orchestrator read; none is said to it again.
    await beats(3)
    expect(told.filter((text) => text.includes('app/step-c is held'))).toEqual([])

    // A loop is refused with every reason, and nothing is written.
    await expect(
      tools.change({ task: 'app/step-c', change: 'after', after: [{ task: 'ghost', why: '' }] }),
    ).rejects.toThrow('app/step-c cannot wait on ghost, which is not a task Tade has')

    expect(await tools.change({ task: 'app/step-c', change: 'remove' })).toBe(
      `app/step-c is removed. Nothing waited on it. app/step-c ${inPlace}`,
    )
    // Work that has started was not removed to be planned again.
    expect(await tools.change({ task: 'app/step-a', change: 'remove' })).toBe(
      'app/step-a is removed. Nothing waited on it.',
    )
  })

  it('hands the waits of work it removes on to what waited on it, so nothing after it is held', async () => {
    const told: string[] = []
    const tools = await opened(told)
    await tools.plan({
      project: 'app',
      said: 'a, then b, then c and d',
      agents: [
        { name: 'link-a', said: 'a', prompt: '', after: [], touches: [] },
        {
          name: 'link-b',
          said: 'b',
          prompt: '',
          after: [{ agent: 'link-a', why: '' }],
          touches: [],
        },
        {
          name: 'link-c',
          said: 'c',
          prompt: '',
          after: [{ agent: 'link-b', why: 'needs b' }],
          touches: [],
        },
        {
          name: 'link-d',
          said: 'd',
          prompt: '',
          after: [
            { agent: 'link-b', why: '' },
            { agent: 'link-c', why: 'after c' },
          ],
          touches: [],
        },
      ],
    })
    await until(
      'a started',
      () => client.runs().some((run) => run.task === 'app/link-a'),
      SPAWNING_MS,
    )
    await expect(
      tools.change({ task: 'app/link-c', change: 'wait', dependents: 'inherit' }),
    ).rejects.toThrow('dependents says what becomes of what waited on work being removed')

    expect(
      await tools.change({ task: 'app/link-b', change: 'remove', dependents: 'inherit' }),
    ).toBe(
      [
        'app/link-b is removed, and app/link-c and app/link-d take over its waits:',
        '- app/link-c waits on app/link-a, and starts by itself once that has finished',
        '- app/link-d waits on app/link-a and app/link-c, and starts by itself once they have finished',
        `app/link-b ${inPlace}`,
      ].join('\n'),
    )
    const instead = 'in place of app/link-b, which was removed'
    expect((await readTaskFile(home, 'app/link-c'))?.start?.after).toEqual([
      { task: 'app/link-a', why: `needs b; ${instead}` },
    ])
    expect((await readTaskFile(home, 'app/link-d'))?.start?.after).toEqual([
      { task: 'app/link-a', why: instead },
      { task: 'app/link-c', why: 'after c' },
    ])
    const [line] = await client.events({ types: ['queue_changed'], task: 'app/link-c' })
    expect(line?.detail).toMatchObject({
      change: 'after',
      inherited: 'app/link-b',
      by: 'orchestrator',
    })

    // And on its way: what it took over finishing starts it, by itself, and
    // nothing was ever held on the task that went.
    await client.markDone('app/link-a', { by: 'you' })
    await until(
      'c started by itself',
      () => client.runs().some((run) => run.task === 'app/link-c'),
      SPAWNING_MS,
    )
    await until(
      'why it started, written down',
      async () =>
        (await client.events({ types: ['queue_started'], task: 'app/link-c' }))[0]?.detail.why ===
        'app/link-a has finished',
    )
    expect(await client.events({ types: ['queue_held'] })).toEqual([])
    expect(told.filter((text) => text.includes(' is held'))).toEqual([])
    // A person who pressed Remove meant it, and is not told the tools.
    expect(await tools.change({ task: 'app/link-d', change: 'remove', by: 'you' })).toBe(
      'app/link-d is removed. Nothing waited on it.',
    )
  })

  it('changes what queued work waits on and what it is told from its menu', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const tools = await opened([])
    await tools.plan({
      project: 'app',
      said: 'first, then later',
      agents: [
        { name: 'first-step', said: 'first', prompt: '', after: [], touches: [] },
        { name: 'other-step', said: 'other', prompt: '', after: [], touches: [] },
        {
          name: 'later-step',
          said: 'later',
          prompt: 'do the later part',
          after: [{ agent: 'first-step', why: 'it builds on it' }],
          touches: [],
        },
      ],
    })
    // Settled, not merely drawn: the two with nothing to wait on start at once
    // and leave the queue, so its heading is on screen frames before the rows
    // under it stop moving, and on a loaded machine later-step was not on the
    // frame the press was aimed from.
    await until(
      'the queue settled',
      () =>
        client.runs().length === 2 &&
        screenOf(terminal.written).some((row) => row.includes('SMART QUEUE (1)')),
      SPAWNING_MS,
    )
    const menu = async (label: string) => {
      // With a space before it: the answer flashed after a change names app/later-step too.
      const row = find(' later-step')
      terminal.written = ''
      terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}M`)
      terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}m`)
      await until('the menu', () => terminal.written.includes(label))
      const item = find(label)
      click(item.col + 1, item.row)
    }

    // The list starts from what it waits on now, so adding is picking one more:
    // narrowed by typing, ticked with space, saved with enter.
    await menu('Wait on…')
    await until('what it waits on, asked for', () =>
      terminal.written.includes('What later-step waits on'),
    )
    for (const char of 'other-step') terminal.press(char)
    await until('narrowed to it', () =>
      screenOf(terminal.written).some((row) => row.includes('□ other-step')),
    )
    terminal.press(' ')
    await until('picked', () => screenOf(terminal.written).some((row) => row.includes('2 picked')))
    terminal.press('\r')
    // Answered where the person is looking, with where it stands now.
    await until('the answer', () =>
      screenOf(terminal.written).some((row) => row.includes('Done. app/later-step waits on')),
    )
    // The reason already written stays with the wait it was written for.
    expect((await readTaskFile(home, 'app/later-step'))?.start?.after).toEqual([
      { task: 'app/first-step', why: 'it builds on it' },
      { task: 'app/other-step', why: '' },
    ])
    const [line] = await client.events({ types: ['queue_changed'], task: 'app/later-step' })
    expect(line?.detail).toMatchObject({ change: 'after', by: 'you', replace: true })

    await menu('Retell…')
    await until('what it is told, asked for', () =>
      terminal.written.includes('What later-step is told'),
    )
    for (const char of ' and the docs') terminal.press(char)
    terminal.press('\r')
    await until(
      'the prompt written',
      async () =>
        (await readTaskFile(home, 'app/later-step'))?.start?.prompt ===
        'do the later part and the docs',
    )
  })
})

// A wait written while a look at status is under way — which, with a day's
// work in the journal, is nearly always. On 2026-11-23 the answer to `after`
// came from the look that had read the task files before the wait was
// written: "Done" beside every wait but the one just added, again and again,
// and the orchestrator re-sent the list with replace and lost the waits it had
// not repeated. These hold that look at the gate, so it happens every time.
describe('a wait written while the window is looking', () => {
  let client: Workbench
  let home: string
  const { start } = windowUnderTest((wired) => {
    client = wired.client
    home = wired.home
  })
  const closing: StatusCollector[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(closing.splice(0).map((one) => one.close()))
  })

  /**
   * The window's looks at status, each of which can be held once it has read
   * the task files, or answered `unknown` as a look that ran out of time is.
   * Counted as each lands, so a test waits on looks rather than on a clock.
   */
  function looks() {
    const own = makeCollector('here')
    closing.push(own)
    let gate: Promise<void> | null = null
    let open = () => {}
    let held = 0
    let landed = 0
    let unknown = false
    const status: StatusCollector = {
      id: own.id,
      collect: async (ask) => {
        const answer = await own.collect(ask)
        if (gate) {
          held += 1
          await gate
          held -= 1
        }
        landed += 1
        return unknown ? { known: false, why: 'status ran out of time' } : answer
      },
      close: () => own.close(),
    }
    return {
      status,
      hold() {
        gate = new Promise((resolve) => {
          open = () => {
            gate = null
            resolve()
          }
        })
      },
      release: () => open(),
      held: () => held,
      landed: () => landed,
      answerUnknown: () => {
        unknown = true
      },
    }
  }

  /**
   * One agent at work, a design waiting on it and parked, and a check of the
   * day waiting on both — so finishing the first starts nothing by itself.
   */
  async function world(seen: ReturnType<typeof looks>) {
    const window = await start({ status: seen.status })
    const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
      name,
      said: name,
      prompt: '',
      after: [],
      touches: [],
      ...over,
    })
    await client.planTasks({
      project: 'app',
      said: 'early, then a design and a check of the day',
      agents: [
        agent('early'),
        agent('design', {
          produces: 'design.md',
          after: [{ agent: 'early', why: 'designs what it found' }],
        }),
        agent('batch', {
          after: [
            { agent: 'early', why: 'checks the day' },
            { agent: 'design', why: 'checks the design' },
          ],
        }),
      ],
    })
    await until('early at work', () => client.runs().length === 1, SPAWNING_MS)
    await client.parkTask('app/design', true)
    // And the pass that started it over, which looks again on its way out.
    const from = seen.landed()
    await until('two more looks', () => seen.landed() >= from + 2)
    return window.queueTools()
  }

  /** Queued work made and parked a moment ago, waiting on the first. */
  async function hud() {
    await client.planTasks({
      project: 'app',
      said: 'one more',
      agents: [
        {
          name: 'hud',
          said: 'hud',
          prompt: '',
          after: [{ agent: 'early', why: 'after it' }],
          touches: [],
        },
      ],
    })
    await client.parkTask('app/hud', true)
  }

  /** The workbench's own write, with a mark once it has been written. */
  function markWrites() {
    const written = { yes: false }
    const write = client.changeQueued.bind(client)
    client.changeQueued = async (req) => {
      const out = await write(req)
      written.yes = true
      return out
    }
    return written
  }

  it('answers with the wait it was given, not with the look that began before it', async () => {
    const seen = looks()
    const tools = await world(seen)
    // Made, queued and parked moments before, while a look is under way.
    seen.hold()
    await until('a look under way', () => seen.held() === 1)
    await hud()
    // The look under way lets go the moment the change asks for one, which is
    // when the window used to be handed that look as if it were new.
    const written = markWrites()
    const refresh = Live.prototype.refresh
    vi.spyOn(Live.prototype, 'refresh').mockImplementation(function (this: Live, asked = true) {
      if (asked && written.yes) seen.release()
      return refresh.call(this, asked)
    })
    const answer = await tools.change({
      task: 'app/batch',
      change: 'after',
      after: [
        { task: 'design', why: 'checks the design', approved: true },
        { task: 'hud', why: 'checks the hud' },
      ],
    })
    expect(answer).toContain('app/batch waits on app/early, app/design and app/hud')
    expect(answer).toContain('the person has approved what app/design produced')
    expect((await readTaskFile(home, 'app/batch'))?.start?.after.map((dep) => dep.task)).toEqual([
      'app/early',
      'app/design',
      'app/hud',
    ])
  })

  it('answers out of the task file when the look after the change came back unknown', async () => {
    const seen = looks()
    const tools = await world(seen)
    await hud()
    await client.markDone('app/early', { by: 'you' })
    // A look that has heard of the hud, then looks that cannot say.
    const from = seen.landed()
    await until('two more looks', () => seen.landed() >= from + 2)
    seen.answerUnknown()
    const answer = await tools.change({
      task: 'app/batch',
      change: 'after',
      replace: true,
      after: [
        { task: 'early', why: 'checks the day' },
        { task: 'hud', why: 'checks the hud' },
      ],
    })
    expect(answer).toBe(
      'Done. app/batch waits on app/hud, and starts by itself once that has finished. app/early has already finished, so waiting on it holds nothing; the wait is kept.',
    )
    // And the stale look did not start it on the wait it no longer had alone.
    expect(client.runs().some((run) => run.task === 'app/batch')).toBe(false)
  })

  it('never starts work on a look that began before a wait was written on it', async () => {
    const seen = looks()
    await world(seen)
    // Waiting on the first alone, as a look has seen it.
    await client.changeQueued({
      task: 'app/batch',
      change: 'after',
      replace: true,
      after: [{ task: 'early', why: 'checks the day' }],
      by: 'you',
    })
    const seenAlone = seen.landed()
    await until('two more looks', () => seen.landed() >= seenAlone + 2)
    seen.hold()
    await until('a look under way', () => seen.held() === 1)
    // A person's wait, written while that look is out: nothing asks for a new one.
    await client.changeQueued({
      task: 'app/batch',
      change: 'after',
      after: [{ task: 'design', why: 'checks the design' }],
      by: 'you',
    })
    // What the look under way says it waits on has now finished.
    await client.markDone('app/early', { by: 'you' })
    const from = seen.landed()
    seen.release()
    await until('that look and two after it', () => seen.landed() >= from + 3)
    expect(client.runs().some((run) => run.task === 'app/batch')).toBe(false)
    expect(await client.events({ types: ['queue_started'], task: 'app/batch' })).toEqual([])
  })
})
