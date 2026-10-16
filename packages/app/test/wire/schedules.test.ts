import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskDir, watchSchedule } from '@tade/core'
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

// A schedule that comes due, and a watch — which is a schedule that looks
// before it acts, whether it finds work to start or something to say.

describe('the window, and what it watches', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  it('runs a schedule when it comes due: its agent starts, or the orchestrator is asked', async () => {
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
    // One that decides itself, which is the old way: its agent starts as
    // soon as there is room. Left to the orchestrator: `proposals.test.ts`.
    const answer = await tools.schedule({
      name: 'Release notes',
      project: 'app',
      said: 'draft the release notes in a moment, without asking anybody',
      when: { at: soon },
      agent: 'Draft the release notes from what merged today.',
      decides: 'itself',
    })
    expect(answer).toMatch(/^Release notes \(release-notes\): once, .+, starts an agent\. Next: /)
    // An ask starts nothing, so there is nothing for anybody to decide.
    await expect(
      tools.schedule({
        name: 'Ping',
        project: 'app',
        said: 'ask me later',
        when: { at: soon },
        ask: 'Anything?',
        decides: 'itself',
      }),
    ).rejects.toThrow(/starts none/)
    await tools.schedule({
      name: 'Morning brief',
      project: 'app',
      said: 'in a moment, tell me what happened',
      when: { at: soon },
      ask: 'Say what the agents did, and what needs the person first.',
    })
    await until('both in the queue', () =>
      screenOf(terminal.written).some((row) => row.includes('Morning brief')),
    )

    await until(
      'its agent started',
      () => client.runs().some((run) => run.task.startsWith('app/release-notes-')),
      SPAWNING_MS,
    )
    await until('the orchestrator asked', () =>
      told.some((text) => text.includes('It is time for "Morning brief"')),
    )
    const fired = await client.events({ types: ['schedule_fired'] })
    expect(fired.map((event) => event.detail.schedule).sort()).toEqual([
      'morning-brief',
      'release-notes',
    ])
    // Once is once: nothing comes due again.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(await client.events({ types: ['schedule_fired'] })).toHaveLength(2)
  })

  it('turns a watch on from the Extensions panel, puts what it finds to the orchestrator once, and says when it cannot look', async () => {
    terminal.columns = 120
    terminal.rows = 50
    let clock = Date.now()
    const found: { key: string; title: string }[] = []
    let radar: string | null = null
    /** A quiet fact a look comes back with: nothing to look at, and not a failure. */
    let quiet: string | null = null
    const told: string[] = []
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
              check: async () => {
                if (radar) throw new Error(radar)
                return { found, ...(quiet ? { said: quiet } : {}) }
              },
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
    const window = await start({
      extensions,
      now: () => clock,
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const extensionsButton = find('Extensions ]')
    click(extensionsButton.col + 2, extensionsButton.row)
    await until('the watch offered', () =>
      screenOf(terminal.written).some((row) => row.includes('Turn on ]')),
    )
    const watch = find('Turn on ]')
    click(watch.col + 2, watch.row)
    await until('it is on, and says when it looks', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Rain is on in app: it looks every hour, first at'),
      ),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('Show ]'))).toBe(true)
    expect(client.schedules()).toMatchObject([
      {
        id: 'rain',
        name: 'Rain',
        project: 'app',
        by: 'you',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'weather.rain', found: 'agent', most: 2 },
      },
    ])

    // Asked to look now, it says what it found, nothing included.
    const tools = window.queueTools()
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: found nothing.',
    )

    // On its clock: the first two new things are made — parked, everything
    // their agents would be told kept — and put to the orchestrator to decide;
    // the third waits for the next look. Nothing starts.
    found.push(
      { key: 'shed', title: 'rain over the shed' },
      { key: 'yard', title: 'rain over the yard' },
      { key: 'roof', title: 'rain over the roof' },
    )
    clock += 3_600_000 + 1_000
    await until('the orchestrator told about the first two', () =>
      told.some((text) => text.includes('(weather.rain), found 2 new things to start work on')),
    )
    const first = told.find((text) => text.includes('found 2 new things')) ?? ''
    expect(first).toContain('"Rain", a watch the person turned on in app')
    expect(first).toContain('- app/bring-in-shed: rain over the shed (key shed)')
    // One look, two findings: each is the other's relation, and says it waits too.
    expect(first).toContain(
      '  - app/bring-in-yard, parked, waiting for your decision too: rain over the yard (found by the same watch)',
    )
    expect(first).toContain('1 more waits for its next look.')
    expect(first).toContain('tade_proposal_decide')
    expect(client.runs()).toEqual([])
    for (const task of ['app/bring-in-shed', 'app/bring-in-yard']) {
      expect((await readTaskFile(home, task))?.parked).toBe(true)
    }
    const file = readFileSync(join(taskDir(home, 'app/bring-in-shed'), 'task.yaml'), 'utf8')
    expect(file).toContain('by: schedule:rain')
    // The panel is over the conversation, which is where Tade says what a
    // watch found: close it, and there it is.
    terminal.press('\x1b')
    await until('said where you would look', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Rain found 3 new: app/bring-in-shed and app/bring-in-yard wait'),
      ),
    )

    // The orchestrator decides each, and each goes through the queue's own door.
    await expect(
      tools.decide({ task: 'app/bring-in-shed', decision: 'later', because: 'x' }),
    ).rejects.toThrow('later is not a decision: start, after, steer, leave')
    await expect(
      tools.decide({ task: 'app/bring-in-shed', decision: 'start', because: ' ' }),
    ).rejects.toThrow(/say why in a sentence/)
    await expect(
      tools.decide({ task: 'app/refunds', decision: 'start', because: 'why not' }),
    ).rejects.toThrow(/is not work a schedule or a watch put to you/)
    await tools.decide({
      task: 'app/bring-in-shed',
      decision: 'start',
      because: 'nothing else is bringing it in',
    })
    await until(
      'its agent started',
      () => client.runs().some((run) => run.task === 'app/bring-in-shed'),
      SPAWNING_MS,
    )
    await expect(
      tools.decide({ task: 'app/bring-in-yard', decision: 'after', because: 'one at a time' }),
    ).rejects.toThrow(/after needs on/)
    expect(
      await tools.decide({
        task: 'app/bring-in-yard',
        decision: 'after',
        because: 'one person at the line at a time',
        on: 'app/bring-in-shed',
      }),
    ).toContain('app/bring-in-yard waits on app/bring-in-shed')
    expect((await readTaskFile(home, 'app/bring-in-yard'))?.parked).toBeFalsy()
    expect(client.runs().some((run) => run.task === 'app/bring-in-yard')).toBe(false)
    // Decided once is decided: asked again, it says so rather than deciding twice.
    await expect(
      tools.decide({ task: 'app/bring-in-shed', decision: 'leave', because: 'changed my mind' }),
    ).rejects.toThrow(/already settled/)

    // The one that waited is found by the next look, and what is already on
    // the same thing is named with where it stands.
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 1 new: app/bring-in-roof waits for the orchestrator to decide.',
    )
    await until('the orchestrator told about the roof', () =>
      told.some((text) => text.includes('- app/bring-in-roof: rain over the roof')),
    )
    const second = told.find((text) => text.includes('- app/bring-in-roof')) ?? ''
    expect(second).toMatch(
      / {2}- app\/bring-in-shed, [^:]+: rain over the shed \(found by the same watch\)/,
    )
    expect(second).toMatch(
      / {2}- app\/bring-in-yard, [^:]+: rain over the yard \(found by the same watch\)/,
    )
    // Handed to the agent already on it: told, with what this one would have read.
    await expect(
      tools.decide({
        task: 'app/bring-in-roof',
        decision: 'steer',
        because: 'one line',
        on: 'app/bring-in-yard',
        message: 'the roof too',
      }),
    ).rejects.toThrow(/no agent is running on app\/bring-in-yard/)
    expect(
      await tools.decide({
        task: 'app/bring-in-roof',
        decision: 'steer',
        because: 'it is the same washing line',
        on: 'app/bring-in-shed',
        message: 'Bring in what is on the roof as well.',
      }),
    ).toContain("app/bring-in-shed's agent is told, and app/bring-in-roof is dropped")
    expect(await readTaskFile(home, 'app/bring-in-roof')).toBeNull()
    const shedContext = readFileSync(join(taskDir(home, 'app/bring-in-shed'), 'context.md'), 'utf8')
    expect(shedContext).toContain('by schedule:rain')
    expect(shedContext).toContain('rain over the roof')
    // Every decision written down, with its reason in the decider's own words.
    const decided = await client.events({ types: ['proposal_decided'] })
    expect(
      decided.map((event) => [event.task, event.detail.decision, event.detail.on ?? null]),
    ).toEqual([
      ['app/bring-in-shed', 'start', null],
      ['app/bring-in-yard', 'after', 'app/bring-in-shed'],
      ['app/bring-in-roof', 'steer', 'app/bring-in-shed'],
    ])
    expect(decided[2]?.detail).toMatchObject({
      key: 'roof',
      because: 'it is the same washing line',
    })
    // Found again, none of it is new: a finding is offered once, whatever became of it.
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: nothing new.',
    )
    expect(await tools.describe()).toContain('last looked')

    // A look that had nothing to look at may say so, and it is said on the same
    // terms: when it starts being true, not at every look while it stays true.
    // Never as trouble — nobody has to do anything about a branch nobody has
    // pushed except push it — which is the whole reason it is not a `problem`.
    found.length = 0
    quiet = 'nothing pushed yet'
    const quietly = () =>
      screenOf(terminal.written).filter((row) => row.includes('Rain: nothing pushed yet')).length
    clock += 3_600_000
    await until('said once', () => quietly() === 1)
    clock += 3_600_000
    await until(
      'looked again',
      async () =>
        (await client.events({ types: ['watch_checked'] })).filter((event) => event.detail.said)
          .length === 2,
      15_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(quietly()).toBe(1)
    quiet = null

    // What it could not look at is said when it starts going wrong, not at every look.
    radar = 'the radar is down'
    const wrong = () =>
      screenOf(terminal.written).filter((row) => row.includes('Rain could not look')).length
    clock += 3_600_000
    await until('said once', () => wrong() === 1)
    clock += 3_600_000
    await until(
      'looked again',
      async () =>
        (await client.events({ types: ['watch_checked'] })).filter((event) => event.detail.problem)
          .length === 2,
      15_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(wrong()).toBe(1)
    terminal.press('\x1b')
    await until('marked in the schedules', () =>
      screenOf(terminal.written).some((row) => /! Rain/.test(row)),
    )
    // The reason on its own row down the side, in words, with a `×` to say you
    // have read it. Down the side, and not the transcript line saying the same
    // thing: the whole point is a warning that stops being drawn.
    const side = () => screenOf(terminal.written).map((one) => one.slice(0, 32))
    const said = () => side().findIndex((one) => one.includes('the radar is down'))
    await until('the reason down the side', () => said() >= 0)
    const at = said()
    click((side()[at] ?? '').indexOf('×'), at)
    // Hushed, the reason goes and the mark does not: the watch still cannot
    // look, and the heading still counts it.
    await until('hushed', () => said() < 0)
    expect(side().some((one) => /! Rain/.test(one))).toBe(true)
    // And the heading still counts it, in the room a narrow side leaves for it.
    expect(side().some((one) => /SCHEDULES.*!1/.test(one))).toBe(true)
  })

  it('writes a standing watch once, and never again over somebody removing it', async () => {
    let key: string | null = null
    const weather = (id: string, standing: boolean) => ({
      id,
      title: id === 'rain' ? 'Rain' : 'Frost',
      means: 'Looks at the sky.',
      every: '1h',
      standing,
      check: async () => ({ found: [] }),
      agent: () => ({ title: 'never', prompt: 'never' }),
    })
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          // With no key it is not ready, and nothing that stands is written.
          ready: () => (key ? null : 'it needs a key'),
          watches: [weather('rain', true), weather('frost', false)],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({ extensions, thinker: { ask: async () => 'ok' } })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Not ready: no schedule at all, which is the whole of the degradation.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(client.schedules()).toEqual([])

    key = 'k'
    await extensions.reconfigure({})
    await until(
      'the standing watch is on',
      () => client.schedules().some((one) => one.id === 'weather-rain-app'),
      15_000,
    )
    expect(client.schedules()).toMatchObject([
      {
        id: 'weather-rain-app',
        name: 'Rain',
        project: 'app',
        by: 'extension:weather',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'weather.rain', found: 'agent', most: 2 },
      },
    ])
    // Said where you would look, so a schedule nobody asked for can be found.
    await until('said in the conversation', () =>
      screenOf(terminal.written).some((row) => row.includes('Rain is on in app')),
    )
    // A watch that does not stand is not written, however long it is open.
    expect(
      client
        .schedules()
        .some((one) => one.does.kind === 'watch' && one.does.watch === 'weather.frost'),
    ).toBe(false)

    await window.queueTools().change({ schedule: 'weather-rain-app', change: 'remove' })
    expect(client.schedules()).toEqual([])
    // Removed is a decision, and it stays made: the file is append-only, so
    // the id it held is still a fact after the schedule itself is gone.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(client.schedules()).toEqual([])
  })

  it('turns a watch on for the orchestrator: what it finds is told, and what cannot be kept is refused', async () => {
    const told: string[] = []
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
              means: 'Looks for rain.',
              every: '30m',
              input: {
                type: 'object',
                properties: { heavier: { type: 'number', description: 'in mm' } },
              },
              check: async () => ({
                found: [
                  {
                    key: 'shed',
                    title: 'rain over the shed',
                    links: [{ title: 'radar', url: 'https://radar.example/shed' }],
                  },
                  { key: 'yard', title: 'rain over the yard' },
                ],
              }),
              agent: () => ({ title: 'never', prompt: 'never' }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
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
    const tools = window.queueTools()
    await expect(
      tools.schedule({ name: 'Snow', project: 'app', said: '', watch: 'weather.snow' }),
    ).rejects.toThrow('there is no watch called weather.snow (there is weather.rain)')
    // Turning a watch on through this door is the same act as through the
    // watch tool, so it is held to the same words: a rule with an unguarded
    // door beside it is worse than no rule.
    await expect(
      tools.schedule({ name: 'Rain', project: 'app', said: '', watch: 'weather.rain' }),
    ).rejects.toThrow(/Nothing they have said names Rain/)
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'tell me when it rains — turn the rain watch on' },
    })
    await expect(
      tools.schedule({
        name: 'Rain',
        project: 'app',
        said: '',
        watch: 'weather.rain',
        input: { heavier: 'lots' },
      }),
    ).rejects.toThrow('heavier should be a number')
    await expect(
      tools.schedule({ name: 'Rain', project: 'app', said: '', watch: 'weather.rain', most: 0 }),
    ).rejects.toThrow('a whole number, 1 or more')
    await expect(
      tools.schedule({
        name: 'Rain',
        project: 'app',
        said: '',
        watch: 'weather.rain',
        ask: 'is it raining?',
      }),
    ).rejects.toThrow('with one of')

    expect(
      await tools.schedule({
        name: 'Rain',
        project: 'app',
        said: 'tell me when it rains',
        watch: 'weather.rain',
        input: { heavier: 2 },
        found: 'ask',
      }),
    ).toMatch(
      /^Rain \(rain\): every 30 minutes, looks with weather\.rain, and tells the orchestrator what it finds\. Next: /,
    )
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 2 new: the orchestrator is told.',
    )
    await until('the orchestrator told', () =>
      told.some((text) =>
        text.includes('"Rain", a watch you turned on in app (weather.rain), found 2 new things:'),
      ),
    )
    const message = told.find((text) => text.includes('"Rain", a watch')) ?? ''
    expect(message).toContain('- rain over the shed (https://radar.example/shed)')
    expect(message).toContain('start work only on what they ask for')
    expect(client.runs()).toEqual([])
    // Told once: found again, it is not new.
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: nothing new.',
    )
  })
  it('lets the orchestrator read the watches, and turn one only where they asked', async () => {
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
              check: async () => ({ found: [] }),
              agent: () => ({ title: 'never', prompt: 'never' }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({ extensions, thinker: { ask: async () => 'ok' } })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const watches = window.watchTools()
    const theySaid = (text: string) =>
      client.log.append({ type: 'said', task: null, detail: { text } })

    // Reading is ungated, and says what each one costs and where it stands.
    const listed = await watches.watches('')
    expect(listed).toContain('weather.rain')
    expect(listed).toContain('app: off')
    expect(listed).toContain(
      'proposes an agent on each thing it finds, and the orchestrator decides whether it starts',
    )
    expect(await watches.watches('nothing like this')).toContain('Nothing matches')

    // Nobody asked: refused, and the refusal says what to ask for.
    await expect(
      watches.change({ watch: 'weather.rain', project: 'app', on: true, said: '' }),
    ).rejects.toThrow(/asks for it/)
    await theySaid('how are the watches getting on?')
    await expect(
      watches.change({ watch: 'weather.rain', project: 'app', on: true, said: 'they want it on' }),
    ).rejects.toThrow(/Nothing they have said names Rain/)
    expect(client.schedules()).toEqual([])

    // A watch Tade does not have, and a project it does not have, are each
    // refused in their own words rather than written anyway.
    await expect(
      watches.change({ watch: 'weather.snow', project: 'app', on: true, said: 'watch for snow' }),
    ).rejects.toThrow(/no watch called weather.snow/)
    await expect(
      watches.change({ watch: 'weather.rain', project: 'nope', on: true, said: 'watch for rain' }),
    ).rejects.toThrow(/not a project/)

    // Off is the direction that needs the words most, so it takes them too.
    // Turned on by the person, as the button on the Extensions page does it.
    await client.setSchedule(
      watchSchedule(
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
      ),
      'you',
    )
    await expect(
      watches.change({ watch: 'weather.rain', project: 'app', on: false, said: 'off with it' }),
    ).rejects.toThrow(/Nothing they have said names Rain/)
    expect(client.schedules()).toMatchObject([{ id: 'rain', paused: false }])

    // Named, it goes off — paused rather than removed, so nothing it has
    // already found is forgotten and turning it back on starts no work twice.
    await theySaid('turn off the rain watch')
    expect(
      await watches.change({
        watch: 'weather.rain',
        project: 'app',
        on: false,
        said: 'turn off the rain watch',
      }),
    ).toContain('is off in app')
    expect(client.schedules()).toMatchObject([{ id: 'rain', paused: true }])
    expect(await watches.watches('rain')).toContain('app: off, paused')

    // And back on is the same schedule resumed, not a second one.
    expect(
      await watches.change({
        watch: 'weather.rain',
        project: 'app',
        on: true,
        said: 'turn the rain watch back on',
      }),
    ).toContain('Rain is back on in app')
    expect(client.schedules()).toMatchObject([{ id: 'rain', paused: false }])
  })
})
