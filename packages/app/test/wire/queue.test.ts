import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { Live } from '../../src/live.ts'
import type { AppState } from '../../src/model.ts'
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

/** The window's look at the trees, which one test holds a pass inside. */
type Straddled = Pick<Live, 'lookAtTrees'>

describe('the window, and the work waiting in it', () => {
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

  it("writes a task's own rule down once it is met, and only then", async () => {
    const worktree = join(repo.root, '..', 'worktrees', 'app-refunds')
    const file = join(taskDir(home, 'app/refunds'), 'task.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}done: committed\n`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Its agent ran and ended a turn, but nothing is committed: not yet.
    await client.log.append({ type: 'run_started', task: 'app/refunds', detail: {} })
    await client.log.append({ type: 'turn_done', task: 'app/refunds', detail: { status: 'ok' } })
    await beats(3)
    expect(await client.events({ types: ['task_done'] })).toEqual([])
    repo.commit('refunds charge once', { 'refunds.ts': 'once' }, worktree)
    await until(
      'the rule written down',
      async () => (await client.events({ types: ['task_done'] })).length === 1,
      15_000,
    )
    const [done] = await client.events({ types: ['task_done'] })
    expect(done).toMatchObject({ task: 'app/refunds', detail: { by: 'rule', rule: 'committed' } })
  })

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
  })

  it('begins work a watch said where to begin on that ref, never on the base', async () => {
    // A review that conflicts is merged into from its own head, so the watch's
    // work says where its tree begins, and it is the start that reads it.
    repo.git('checkout', '-q', '-b', 'shop/refunds-retry')
    const head = repo.commit('retry refunds once', { 'retry.ts': 'once' })
    repo.git('checkout', '-q', 'main')
    repo.commit('main moves on', { 'main.ts': 'on' })
    await client.setSchedule(
      {
        id: 'conflicts-app',
        name: 'review.conflicts',
        project: 'app',
        said: 'merge main into my reviews when they conflict',
        when: { every: '10m' },
        does: { kind: 'watch', watch: 'review.conflicts', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-09-15T08:00:00.000Z',
      },
      'you',
    )
    const made = await client.watchFound(
      'conflicts-app',
      { key: 'github.com/acme/app#412:conflicts@abc', title: 'PR #412 conflicts with main' },
      {
        agent: {
          title: 'pr 412 conflicts with main',
          prompt: 'Merge main in.',
          alone: true,
          from: 'shop/refunds-retry',
        },
      },
    )
    const task = made.task ?? ''
    await start()
    await until(
      'the watch’s work started',
      () => client.runs().some((run) => run.task === task),
      SPAWNING_MS,
    )
    const worktree = join(home, 'worktrees', task.replace('/', '-'))
    expect(repo.git('-C', worktree, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

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
  })

  /**
   * A queued agent opened from the side, whose prompt is longer than any pane
   * here: forty lines, the last of which is what the page has to reach.
   */
  const openLongQueued = async () => {
    terminal.columns = 120
    terminal.rows = 40
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
          prompt: Array.from({ length: 40 }, (_, i) => `step ${i + 1} of the plan`).join('\n'),
          after: [{ agent: 'look-first', why: 'it needs what that finds' }],
          touches: [],
        },
      ],
    })
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('SMART QUEUE')),
    )
    const tab = find('fix-after')
    click(tab.col + 1, tab.row)
    await until('its page', () => onScreen('WILL BE TOLD'))
    expect(onScreen('step 1 of the plan')).toBe(true)
    expect(onScreen('step 40 of the plan')).toBe(false)
  }
  const onScreen = (text: string) => screenOf(terminal.written).some((row) => row.includes(text))
  /** Where the page is: the row its heading is on, and the first step of the prompt in view. */
  const pageAt = () => {
    const rows = screenOf(terminal.written)
    const heading = rows.findIndex((row) => row.includes('WILL BE TOLD'))
    return `${heading} ${rows.find((row) => /step \d+ of the plan/.test(row)) ?? ''}`
  }

  it('scrolls a queued agent’s page to the end of what it will be told, under the wheel', async () => {
    await openLongQueued()
    const notch = (at: { col: number; row: number }) =>
      terminal.press(`\x1b[<65;${at.col + 2};${at.row + 1}M`)
    // Over the picture of the chain, a notch down moves the page and not the
    // picture: the chain is a part of what is being read, so a page with its
    // chain at the top can still be read to its end.
    const chain = screenOf(terminal.written).findIndex((row) => row.includes('THE CHAIN IT IS IN'))
    const box = find('┏━')
    let was = pageAt()
    notch(box)
    await until('the page to move under the picture', () => pageAt() !== was)
    const now = screenOf(terminal.written).findIndex((row) => row.includes('THE CHAIN IT IS IN'))
    expect(now).toBeLessThan(chain)
    // Then over the words, a notch at a time, until the last of them is in view.
    const over = find('step ')
    for (let left = 80; left > 0 && !onScreen('step 40 of the plan'); left--) {
      was = pageAt()
      notch(over)
      await until('the page to move', () => pageAt() !== was)
    }
    expect(onScreen('step 40 of the plan')).toBe(true)
    // The heading did not scroll with it: starting it is still one press.
    expect(onScreen('Start now')).toBe(true)
  })

  it('pages a queued agent’s page with page down and page up', async () => {
    await openLongQueued()
    for (let left = 20; left > 0 && !onScreen('step 40 of the plan'); left--) {
      const was = pageAt()
      terminal.press('\x1b[6~')
      await until('the page to move', () => pageAt() !== was)
    }
    expect(onScreen('step 40 of the plan')).toBe(true)
    // And back to its top, where what it waits on is said.
    for (let left = 20; left > 0 && !onScreen('Waits on look-first'); left--) {
      const was = pageAt()
      terminal.press('\x1b[5~')
      await until('the page to move back', () => pageAt() !== was)
    }
    expect(onScreen('Waits on look-first')).toBe(true)
    expect(onScreen('step 1 of the plan')).toBe(true)
  })

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
  })

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
    // on, the other a chip at rest. One question and one pair, and nothing else
    // over the queue — what is on a clock is SCHEDULES', and the `timed` switch
    // that used to hide it went with the split.
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
    // Its own work finishing starts nothing while it is paused, however many
    // times the queue looks.
    await client.markDone('app/first-one', { by: 'you' })
    for (let look = 0; look < 3; look++) await window.queueTools().advance()
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)

    // The queue saying so is not the card drawing it: a loaded machine draws a
    // frame later, so the button is waited on where it is pressed.
    await until('its card offers Resume', () =>
      screenOf(terminal.written).some((line) => line.includes('▶ Resume')),
    )
    const resume = find('▶ Resume')
    click(resume.col + 1, resume.row)
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      SPAWNING_MS,
    )
  })

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
    // Its own work finishing starts nothing while the queue is held, however
    // many times it looks.
    await client.markDone('app/first-one', { by: 'you' })
    for (let look = 0; look < 3; look++) await window.queueTools().advance()
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)
    expect(await window.queueTools().describe()).toContain('paused with the queue')

    await window.queueTools().change({ project: 'app', change: 'resume' })
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      SPAWNING_MS,
    )
  })

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
    const heldSaid = told.find((text) => text.includes('app/write-up is held')) ?? ''
    expect(heldSaid).toContain('It was planned against code that has moved since')
    // It heals, and says so, with the one call that makes it a wait instead —
    // on the agent whose commit it ran into, by the id the tools take.
    expect(heldSaid).toContain('It starts by itself once app/fix-charge has finished')
    expect(heldSaid).toContain(
      'tade_queue_change with change: after, task: app/write-up, after: [{task: app/fix-charge, why:',
    )
    // Nobody set queue.holds, so it is the orchestrator's to decide.
    expect(heldSaid).toContain('Deciding is yours (queue.holds)')
    expect(heldSaid).not.toContain('The person decides')

    // Said once: the hold is not repeated at every look while it waits —
    // counted in looks, since the first may be the one that wrote it.
    for (let look = 0; look < 3; look++) await tools.advance()
    expect((await client.events({ types: ['queue_held'], task: 'app/write-up' })).length).toBe(1)

    // The person's answer is written down, read back, and it starts — and is
    // said to have started when the look that starts it is one already under
    // way, which reads the start as it lands. Beside another suite, git kept
    // that look slow enough to straddle the change; here it is held there.
    const live = (window as unknown as { wire: { live: Straddled } }).wire.live
    const look = live.lookAtTrees.bind(live)
    let inLook = () => {}
    const looking = new Promise<void>((resolve) => {
      inLook = resolve
    })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    live.lookAtTrees = async (items) => {
      inLook()
      await released
      return look(items)
    }
    await looking
    const answer = tools.change({ task: 'app/write-up', change: 'start', by: 'you' })
    await until('the start written', async () =>
      (await client.events({ types: ['queue_changed'], task: 'app/write-up' })).some(
        (event) => event.detail.change === 'start',
      ),
    )
    release()
    expect(await answer).toBe('Done. Started app/write-up.')
    const [started] = await client.events({ types: ['queue_started'], task: 'app/write-up' })
    expect(started?.detail.why).toBe('it was started anyway')
  })

  it('keeps work held on the tree held while git cannot read the tree, and says why once', async () => {
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
    // Changed under it and not committed, which only `git status` can see.
    repo.write({ 'charge.ts': 'charge once\n' })
    await client.markDone('app/look-around', { by: 'you' })
    const holds = async () => client.events({ types: ['queue_held'], task: 'app/write-up' })
    await until('held on the tree', async () => (await holds()).length === 1, 10_000)

    // Now git fails in the middle of the look: `git status` cannot read the
    // index, while `git log` still answers. That used to read as nothing
    // dirty, and the next look let the work go.
    const index = join(repo.root, '.git', 'index')
    const whole = readFileSync(index)
    writeFileSync(index, 'DIRC')
    const unread = () =>
      (window as unknown as { wire: { state: AppState } }).wire.state.transcript.entries.flatMap(
        (entry) =>
          entry.kind === 'tade' && entry.text.startsWith("could not read app's checkout")
            ? [entry.text]
            : [],
      )
    try {
      for (let look = 0; look < 3; look++) await tools.advance()
      expect(client.runs().some((run) => run.task === 'app/write-up')).toBe(false)
      expect((await holds()).length).toBe(1)
      // Said once, with why, however many looks could not read it.
      expect(unread()).toEqual([
        "could not read app's checkout before starting work in it: git exited 128: fatal: .git/index: index file smaller than expected. Nothing held on its files is let go until a look can read them.",
      ])
    } finally {
      writeFileSync(index, whole)
    }

    // A look that can read the tree, and finds the file settled, heals it.
    rmSync(join(repo.root, 'charge.ts'))
    await until(
      'it started once the tree could be read',
      () => client.runs().some((run) => run.task === 'app/write-up'),
      SPAWNING_MS,
    )
    expect(unread().length).toBe(1)
  })

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
    // The call to make, spelled out: a model told only "tade_queue_change does
    // each of those" sent `{"change":"wait"}` twelve times running and blamed
    // the harness for losing a `task` it never wrote.
    expect(told.find((text) => text.includes('app/second is held'))).toContain('task: app/second')
    // And a call without one says what it was missing and what there is to
    // name, rather than "say which" to a model that believes it already did.
    await expect(tools.change({ change: 'wait' })).rejects.toThrow(
      'wait is for one piece of queued work, and this call named none: say which as task — queued now: app/second',
    )

    expect(await tools.change({ task: 'app/second', change: 'start' })).toBe(
      'Done. Started app/second.',
    )
    expect(client.runs().some((run) => run.task === 'app/second')).toBe(true)
  })

  it('holds nothing for work parked between a look and its start, and starts it once picked up', async () => {
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // A watch makes its work, then parks it: a pass that looked in between
    // finds it ready, and the start door finds it parked. That refusal is the
    // park's, and written down as a failed start it held the work for good.
    const startQueued = client.startQueued.bind(client)
    let refused = false
    client.startQueued = async (req) => {
      if (req.task === 'app/found-later' && !refused) {
        refused = true
        await client.parkTask(req.task, true, { by: 'schedule:rain' })
      }
      return startQueued(req)
    }
    await client.createTask({
      project: 'app',
      slug: 'found-later',
      intent: 'found by a watch',
      by: 'schedule:rain',
      start: { after: [], prompt: 'Bring it in.', touches: [] },
    })
    await until('the start refused for the park', () => refused, SPAWNING_MS)
    await window.queueTools().advance()
    expect(await client.events({ types: ['queue_held'] })).toEqual([])

    await client.parkTask('app/found-later', false, { by: 'orchestrator' })
    await until(
      'its agent started',
      async () => {
        await window.queueTools().advance()
        return client.runs().some((run) => run.task === 'app/found-later')
      },
      SPAWNING_MS,
    )
  })
})
