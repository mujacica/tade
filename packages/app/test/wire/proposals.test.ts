import { ConfigSchema, checkProposal, undecidedProposals, watchSchedule } from '@tade/core'
import { ExtensionHost, type Finding } from '@tade/extensions-core'
import { readTaskFile, type Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// What a schedule or a watch would start, put to the orchestrator first:
// made parked, told now with what may already be on the same thing, and
// started only by a decision. A watch's whole round — two findings, each the
// other's relation, decided start, after and steer — is in `schedules.test.ts`
// with the rest of that watch; here is a schedule's run, what happens when
// there is nobody to decide, and the two kinds of parked work that were once
// left to a person: a check a watch proposes, which is the orchestrator's now,
// and work from outside this machine, which stays the person's to approve.

describe('the window, and what a schedule or a watch puts to the orchestrator', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  it('puts a schedule’s run to the orchestrator, parked, and starts it on its decision', async () => {
    terminal.columns = 120
    terminal.rows = 60
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
    const soon = new Date(Date.now() + 1_500).toISOString()
    const answer = await tools.schedule({
      name: 'Release notes',
      project: 'app',
      said: 'draft the release notes in a moment',
      when: { at: soon },
      agent: 'Draft the release notes from what merged today.',
    })
    // Whether its agent starts is the orchestrator's to decide, unless it says otherwise.
    expect(answer).toMatch(
      /^Release notes \(release-notes\): once, .+, proposes an agent to the orchestrator\. Next: /,
    )
    await until('put to the orchestrator', () =>
      told.some((text) =>
        text.includes('It is time for "Release notes", a schedule you made in app to run once'),
      ),
    )
    const fired = await client.events({ types: ['schedule_fired'] })
    expect(fired).toHaveLength(1)
    expect(fired[0]?.detail).toMatchObject({ schedule: 'release-notes', proposed: true })
    const proposed = fired[0]?.task ?? ''
    expect((await readTaskFile(home, proposed))?.parked).toBe(true)
    const message = told.find((text) => text.includes('"Release notes"')) ?? ''
    expect(message).toContain(`- ${proposed}: Release notes`)
    expect(message).toContain('Nothing Tade can see is working on anything like it.')
    expect(client.runs()).toEqual([])
    await until('said where you would look', () =>
      screenOf(terminal.written).some((row) =>
        row.includes(`Release notes ran: ${proposed} waits for the orchestrator`),
      ),
    )
    // Decided, it starts — through the queue, like any queued work.
    await tools.decide({ task: proposed, decision: 'start', because: 'it is release day' })
    await until(
      'its agent started',
      () => client.runs().some((run) => run.task === proposed),
      SPAWNING_MS,
    )
    expect(
      (await client.events({ types: ['proposal_decided'] })).map((event) => event.detail),
    ).toEqual([
      {
        schedule: 'release-notes',
        decision: 'start',
        because: 'it is release day',
        by: 'orchestrator',
      },
    ])
    expect(undecidedProposals(await client.events({}))).toEqual([])
  })

  /** A watch whose findings start work, turned on in app by the person. */
  const raining = async (found: { key: string; title: string }[]) => {
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          watches: [
            {
              id: 'rain',
              title: 'Rain',
              means: 'Looks for rain, and starts an agent to bring the washing in.',
              every: '1h',
              check: async () => ({ found }),
              agent: (finding) => ({
                title: `bring in ${finding.key}`,
                prompt: `It is raining: ${finding.title}.`,
                context: 'The washing is on the line.',
              }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const schedule = watchSchedule(
      {
        id: 'weather.rain',
        title: 'Rain',
        every: '1h',
        offers: 'agent',
        standing: false,
        problem: null,
      },
      { id: 'rain', name: 'Rain', project: 'app', by: 'you' },
      Date.now(),
    )
    return { extensions, schedule }
  }

  it('keeps what a watch would start parked when no orchestrator is running, and says so', async () => {
    terminal.columns = 160
    const { extensions, schedule } = await raining([{ key: 'shed', title: 'rain over the shed' }])
    // No orchestrator at all: there is nobody to decide, and nothing may start instead.
    const window = await start({ extensions })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.setSchedule(schedule, 'you')
    const tools = window.queueTools()
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 1 new: app/bring-in-shed waits parked for the orchestrator, which is not running yet.',
    )
    await until('said out loud', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('no orchestrator is running to decide'),
      ),
    )
    expect((await readTaskFile(home, 'app/bring-in-shed'))?.parked).toBe(true)
    expect(client.runs()).toEqual([])
    // Not dropped: the journal still has it waiting, which is what the next
    // briefing reads, and the key is kept so it is never offered twice.
    expect(undecidedProposals(await client.events({})).map((one) => one.task)).toEqual([
      'app/bring-in-shed',
    ])
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: nothing new.',
    )
  })

  it('says so when the orchestrator cannot be told, and starts work itself only where the schedule says it decides', async () => {
    terminal.columns = 160
    const found = [{ key: 'shed', title: 'rain over the shed' }]
    const { extensions, schedule } = await raining(found)
    const window = await start({
      extensions,
      thinker: {
        ask: async () => 'ok',
        tell: async () => {
          throw new Error('pi is gone')
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.setSchedule(schedule, 'you')
    const tools = window.queueTools()
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 1 new: app/bring-in-shed waits for the orchestrator to decide.',
    )
    await until('said out loud', () =>
      screenOf(terminal.written).some((row) => row.includes('could not be told (pi is gone)')),
    )
    expect((await readTaskFile(home, 'app/bring-in-shed'))?.parked).toBe(true)
    expect(client.runs()).toEqual([])

    // A schedule that decides itself starts what it finds the old way, as
    // soon as there is room — the person's choice, written on the schedule.
    if (schedule.does.kind !== 'watch') throw new Error('a watch')
    await client.setSchedule({ ...schedule, does: { ...schedule.does, decides: 'itself' } }, 'you')
    found.push({ key: 'yard', title: 'rain over the yard' })
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 1 new: queued app/bring-in-yard.',
    )
    expect((await readTaskFile(home, 'app/bring-in-yard'))?.parked).toBeFalsy()
    expect((await client.events({ types: ['watch_found'] })).at(-1)?.detail).not.toHaveProperty(
      'proposed',
    )
  })

  /** A watch shaped like jev.mistakes: its work is a check, always put to a decision. */
  const mistakes = async (found: Finding[]) => {
    const mistake = {
      project: 'app',
      name: 'test_missing',
      what: 'A change was made without a test that covers it.',
      seen: [{ task: 'app/refunds' }, { task: 'app/search' }],
      by: 'verdicts' as const,
    }
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'judge',
          title: 'Judge',
          description: 'Reads changes.',
          watches: [
            {
              id: 'mistakes',
              title: 'Mistakes made twice',
              means: 'Proposes a check for a mistake confirmed twice.',
              every: '1h',
              check: async () => ({ found }),
              // What jev.mistakes answers with (`WatchAgent.parked`).
              agent: () => ({ ...checkProposal(mistake), parked: true }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const schedule = watchSchedule(
      {
        id: 'judge.mistakes',
        title: 'Mistakes made twice',
        every: '1h',
        offers: 'agent',
        standing: true,
        problem: null,
      },
      { id: 'mistakes', name: 'Mistakes made twice', project: 'app', by: 'you' },
      Date.now(),
    )
    return { extensions, schedule }
  }

  const confirmed = {
    key: 'test_missing',
    title: 'test_missing was confirmed real about app/refunds, app/search: a check is proposed',
  }

  it('puts a check a watch proposes to the orchestrator, and starts it on its decision', async () => {
    terminal.columns = 160
    const told: string[] = []
    const { extensions, schedule } = await mistakes([confirmed])
    const window = await start({
      extensions,
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.setSchedule(schedule, 'you')
    const tools = window.queueTools()
    const task = 'app/check-for-test-missing'
    // Not parked for somebody to pick up: put to the orchestrator, like any watch's work.
    expect(await tools.change({ schedule: 'mistakes', change: 'start' })).toBe(
      `Mistakes made twice found 1 new: ${task} waits for the orchestrator to decide.`,
    )
    await until('put to the orchestrator', () => told.some((text) => text.includes(task)))
    const message = told.find((text) => text.includes(task)) ?? ''
    expect(message).toContain(
      '"Mistakes made twice", a watch the person turned on in app (judge.mistakes), found something new',
    )
    expect(message).toContain(`- ${task}: ${confirmed.title} (key test_missing)`)
    expect(message).toContain('Nothing Tade can see is working on anything like it.')
    expect(message).toContain('Decide it with tade_proposal_decide')
    expect((await client.events({ types: ['watch_found'] })).at(-1)).toMatchObject({
      task,
      detail: { schedule: 'mistakes', key: 'test_missing', proposed: true },
    })
    expect((await readTaskFile(home, task))?.parked).toBe(true)
    expect(undecidedProposals(await client.events({})).map((one) => one.task)).toEqual([task])
    // The queue looks and leaves it: nothing but a decision starts it.
    expect(await tools.advance()).not.toContain(task)
    expect(client.runs()).toEqual([])

    await tools.decide({
      task,
      decision: 'start',
      because: 'nothing else is changing the commit hook or the tests',
    })
    await until(
      'its agent started',
      () => client.runs().some((run) => run.task === task),
      SPAWNING_MS,
    )
    expect(
      (await client.events({ types: ['proposal_decided'] })).map((event) => event.detail),
    ).toEqual([
      {
        schedule: 'mistakes',
        key: 'test_missing',
        decision: 'start',
        because: 'nothing else is changing the commit hook or the tests',
        by: 'orchestrator',
      },
    ])
    const parks = await client.events({ types: ['state_change'], task })
    expect(parks.map((one) => [one.detail.state, one.detail.by])).toEqual([
      ['parked', 'schedule:mistakes'],
      ['resumed', 'orchestrator'],
    ])
    expect(undecidedProposals(await client.events({}))).toEqual([])
  })

  it('puts a check to the orchestrator even where the schedule decides itself', async () => {
    terminal.columns = 160
    const { extensions, schedule } = await mistakes([confirmed])
    const window = await start({
      extensions,
      thinker: { ask: async () => 'ok', tell: async () => {} },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    if (schedule.does.kind !== 'watch') throw new Error('a watch')
    // The schedule may start what it finds by rule; a check is never one of those.
    await client.setSchedule({ ...schedule, does: { ...schedule.does, decides: 'itself' } }, 'you')
    const tools = window.queueTools()
    expect(await tools.change({ schedule: 'mistakes', change: 'start' })).toBe(
      'Mistakes made twice found 1 new: app/check-for-test-missing waits for the orchestrator to decide.',
    )
    expect((await readTaskFile(home, 'app/check-for-test-missing'))?.parked).toBe(true)
    expect(await tools.advance()).toEqual([])
    expect(client.runs()).toEqual([])
  })

  it('decides a check the orchestrator proposed itself, which has no schedule behind it', async () => {
    const window = await start({ thinker: { ask: async () => 'ok', tell: async () => {} } })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // What `tade_propose_check` makes (`host-lessons.ts`): a task the
    // orchestrator made, parked, and marked as a proposal on its own line.
    const made = await client.createTask({
      project: 'app',
      slug: 'check-no-floating-promises',
      intent: 'Add a lint rule for floating promises.',
      by: 'orchestrator',
      start: { after: [], prompt: 'Add a lint rule for floating promises.', touches: [] },
      proposed: { title: 'check for no-floating-promises' },
    })
    await client.parkTask(made.id, true, { by: 'orchestrator' })
    expect(undecidedProposals(await client.events({}))).toMatchObject([
      { task: made.id, schedule: null, key: null, title: 'check for no-floating-promises' },
    ])
    const tools = window.queueTools()
    await tools.decide({
      task: made.id,
      decision: 'start',
      because: 'nothing else is on the lint config',
    })
    await until(
      'its agent started',
      () => client.runs().some((run) => run.task === made.id),
      SPAWNING_MS,
    )
    expect(
      (await client.events({ types: ['proposal_decided'] })).map((event) => event.detail),
    ).toEqual([
      { decision: 'start', because: 'nothing else is on the lint config', by: 'orchestrator' },
    ])
  })

  it('leaves work from outside this machine parked for the person, and never puts it to the orchestrator', async () => {
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      surfaces: {
        intake: {
          enabled: true,
          sources: { cli: { accept: true, projects: ['app'], from: ['kim'] } },
        },
      },
    })
    client.config = config
    const told: string[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'door',
          title: 'Door',
          description: 'Requests handed in.',
          watches: [
            {
              id: 'cli',
              title: 'Handed in',
              means: 'Takes requests handed in at the door.',
              every: '5m',
              check: async () => ({
                found: [
                  {
                    key: 'cli:req-1:1',
                    title: 'cli req-1',
                    intake: {
                      source: 'cli',
                      externalId: 'req-1',
                      revision: '1',
                      url: 'https://example.invalid/req-1',
                      requester: { id: 'kim', label: 'Kim', bot: false },
                      from: 'app',
                      verbatim: 'the export button 500s when the selection is empty',
                      material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
                      attachments: [],
                      sourceAt: '2026-10-09T00:00:00.000Z',
                      seenAt: '2026-10-09T00:01:00.000Z',
                      correlation: 'req-1-1',
                    },
                  },
                ],
              }),
              agent: () => ({ title: 'cli req-1', prompt: 'A request came in from cli (req-1).' }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({
      extensions,
      config,
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.setSchedule(
      watchSchedule(
        {
          id: 'door.cli',
          title: 'Handed in',
          every: '5m',
          offers: 'agent',
          standing: false,
          problem: null,
        },
        { id: 'door-cli', name: 'Handed in', project: 'app', by: 'you' },
        Date.now(),
      ),
      'you',
    )
    const tools = window.queueTools()
    await tools.change({ schedule: 'door-cli', change: 'start' })
    const found = (await client.events({ types: ['watch_found'] })).at(-1)
    const task = found?.task ?? ''
    expect(task).not.toBe('')
    // The owner's grant decided it is a proposal for the person: parked, and not the orchestrator's.
    expect(found?.detail).not.toHaveProperty('proposed')
    expect((await readTaskFile(home, task))?.parked).toBe(true)
    expect(undecidedProposals(await client.events({}))).toEqual([])
    expect(told.some((text) => text.includes(task))).toBe(false)
    await expect(
      tools.decide({ task, decision: 'start', because: 'it looks fine' }),
    ).rejects.toThrow(/is not work a schedule or a watch put to you/)
    expect(await tools.advance()).not.toContain(task)
    expect(client.runs()).toEqual([])
  })
})
