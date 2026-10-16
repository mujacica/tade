import { undecidedProposals, watchSchedule } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
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
// with the rest of that watch; here is a schedule's run, and what happens
// when there is nobody to decide.

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
})
