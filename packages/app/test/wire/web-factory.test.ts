import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigSchema,
  draftYaml,
  type InboxRow,
  type Schedule,
  type Template,
  templateDirs,
} from '@tade/core'
import type { WatchOffer } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import {
  Bodies,
  doorsOf,
  factoryHeld,
  runsFromOf,
  titlesOf,
  workflowsRead,
} from '../../src/wire/web-factory.ts'

// The window's own fold of the factory floor: the doors, the bodies and the
// workflows.
//
// Three things are worth asking of it, and each is a thing a surface would be
// silent about if the fold got it wrong:
//
// 1. **Is a door with no schedule said as unwatched**, rather than drawn as one
//    waiting for a look that is never coming?
// 2. **Is a body read once per request and once per edit**, so a request
//    somebody rewrote is read again and one that has not moved is not?
// 3. **Is a draft that will not parse said as a problem**, rather than as a
//    workflow with nothing wrong with it?

const offer = (over: Partial<WatchOffer> = {}): WatchOffer => ({
  id: 'intake.github',
  extension: 'intake',
  title: 'labelled issues',
  means: 'takes in labelled issues',
  every: '10m',
  input: null,
  offers: 'ask',
  standing: false,
  network: true,
  most: null,
  needs: [],
  intake: 'github',
  rechecks: true,
  replies: true,
  problem: null,
  ...over,
})

const schedule = (
  over: Partial<Schedule> & { paused?: boolean } = {},
): Schedule & { paused?: boolean } => ({
  id: 'github-issues',
  name: 'github issues',
  project: 'sentry',
  said: '',
  when: { every: '15m' },
  does: { kind: 'watch', watch: 'intake.github', input: {}, found: 'ask', most: 2 },
  missed: 'once',
  by: 'you',
  created: '2026-10-01T09:00:00.000Z',
  ...over,
})

const config = () => {
  const made = ConfigSchema.parse({})
  return {
    ...made,
    surfaces: {
      ...made.surfaces,
      intake: {
        enabled: true,
        sources: {
          ...made.surfaces.intake.sources,
          github: {
            ...made.surfaces.intake.sources.github,
            accept: true,
            projects: ['sentry'],
            from: ['octocat'],
          },
        },
      },
    },
  }
}

const checked = (detail: Record<string, unknown>) => ({
  type: 'watch_checked',
  detail: { schedule: 'github-issues', ...detail },
})

describe('the doors, folded out of the config, the watches and the journal', () => {
  it('answers about every source there is, not only the ones with a watch', () => {
    // A door nobody looks through is still a door, and its absence from a list
    // is exactly the silence this collection exists to break.
    const doors = doorsOf({ config: config(), events: [], schedules: [], watches: null })
    expect(doors.map((one) => one.source)).toEqual(['cli', 'github', 'slack', 'linear'])
    // And each says *its own* reason: the three nobody granted are `ungranted`
    // and the one that is granted with nothing looking is `unwatched`. One word
    // over all four would be the silence this collection exists to break.
    expect(doors.map((one) => one.state)).toEqual([
      'ungranted',
      'unwatched',
      'ungranted',
      'ungranted',
    ])
  })

  it('finds the watch by what it declares, never by matching a name', () => {
    const doors = doorsOf({
      config: config(),
      events: [],
      schedules: [schedule()],
      watches: [offer()],
    })
    const github = doors.find((one) => one.source === 'github')
    expect(github?.watch).toBe('intake.github')
    expect(github?.schedule).toBe('github-issues')
    // The schedule's own `every` beats the watch's default: it is what somebody
    // turned it on with.
    expect(github?.every).toBe('15m')
    expect(github?.state).toBe('unlooked')
  })

  it('says a watch with no schedule as unwatched, with the watch still named', () => {
    const doors = doorsOf({
      config: config(),
      events: [],
      schedules: [],
      watches: [offer()],
    })
    const github = doors.find((one) => one.source === 'github')
    expect(github?.state).toBe('unwatched')
    expect(github?.watch).toBe('intake.github')
    expect(github?.schedule).toBe('')
  })

  it('reads the looks out of the journal, and the kind of trouble with them', () => {
    const doors = doorsOf({
      config: config(),
      events: [
        checked({ found: 2, fresh: ['a'], left: 0, since: null }),
        checked({ problem: 'github said no', trouble: 'rate-limited', until: 1_000 }),
      ],
      schedules: [schedule()],
      watches: [offer()],
    })
    const github = doors.find((one) => one.source === 'github')
    expect(github?.state).toBe('rate-limited')
    expect(github?.until).toBe(1_000)
    // And what the last look that **worked** found, which is a different fact.
    expect(github?.found).toBe(2)
  })

  it('reads a paused schedule as paused rather than as a look that never came', () => {
    const doors = doorsOf({
      config: config(),
      events: [],
      schedules: [schedule({ paused: true })],
      watches: [offer()],
    })
    expect(doors.find((one) => one.source === 'github')?.state).toBe('paused')
  })
})

describe('the titles a watch found', () => {
  it('reads them out of the journal’s own findings, by the request', () => {
    const titles = titlesOf([
      { type: 'watch_found', detail: { key: 'github:1402:r1', title: 'Export button 500s' } },
      { type: 'watch_checked', detail: {} },
      { type: 'watch_found', detail: { key: 'github:1403:r1' } },
    ])
    expect(titles.get('github:1402')).toBe('Export button 500s')
    // A finding with no title is not a finding with an empty one.
    expect(titles.has('github:1403')).toBe(false)
  })
})

describe('the request bodies', () => {
  const row = (over: Partial<InboxRow> = {}): InboxRow =>
    ({
      item: 'cli:one',
      source: 'cli',
      externalId: 'one',
      requester: 'me',
      project: 'sentry',
      grant: 'surfaces.intake.sources.cli',
      template: null,
      revision: 'r1',
      taken: 'r1',
      hash: 'sha256:aaa',
      ref: 'spool/one',
      url: '',
      watch: 'intake.cli',
      schedule: 'cli-spool',
      mode: 'propose',
      tasks: [],
      work: [],
      state: 'noticed',
      because: 'picked up',
      attempts: 0,
      tries: 3,
      replies: 0,
      said: [],
      unsent: [],
      at: 0,
      ...over,
    }) as InboxRow

  it('says a request Tade never wrote a body for, rather than nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-bodies-'))
    const bodies = new Bodies()
    await bodies.fill(home, [row()])
    const held = bodies.byItem([row()])
    expect(held.get('cli:one')?.body).toBeNull()
    expect(held.get('cli:one')?.problem).toContain('keeps no copy of a request')
  })

  it('drops what a request has moved past, so the map does not grow for ever', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-bodies-moved-'))
    const bodies = new Bodies()
    await bodies.fill(home, [row()])
    // The same request at a new revision: a new hash, so it is read again and
    // the old answer is not kept beside it.
    const moved = row({ hash: 'sha256:bbb', revision: 'r2' })
    await bodies.fill(home, [moved])
    expect(bodies.byItem([moved]).size).toBe(1)
    // And the old hash has nothing held for it any more.
    expect(bodies.byItem([row()]).size).toBe(0)
  })

  it('reads the body Tade wrote into a task’s context file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-bodies-read-'))
    await mkdir(join(home, 'projects', 'sentry', 'tasks', 'cli-one'), { recursive: true })
    await writeFile(
      join(home, 'projects', 'sentry', 'tasks', 'cli-one', 'context.md'),
      'somebody else’s words',
      'utf8',
    )
    const one = row({ tasks: ['sentry/cli-one'] })
    const bodies = new Bodies()
    await bodies.fill(home, [one])
    expect(bodies.byItem([one]).get('cli:one')?.body).toContain('somebody else’s words')
  })
})

describe('which request each run came from', () => {
  const row = (over: Partial<InboxRow>): InboxRow =>
    ({
      item: 'github:1402',
      source: 'github',
      externalId: '1402',
      requester: 'octocat',
      project: 'sentry',
      grant: '',
      template: { name: 'reproduce-and-fix', version: 3 },
      revision: 'r1',
      taken: 'r1',
      hash: 'h',
      ref: 'r',
      url: '',
      watch: '',
      schedule: '',
      mode: 'propose',
      tasks: ['sentry/one'],
      work: [],
      state: 'accepted',
      because: '',
      attempts: 2,
      tries: 3,
      replies: 0,
      said: [],
      unsent: [],
      at: 0,
      ...over,
    }) as InboxRow

  it('reads it out of the inbox, because the task files do not say', () => {
    const from = runsFromOf([row({})], new Map([['sentry/one', 'shop']]))
    expect(from.get('shop')).toEqual({
      item: 'github:1402',
      source: 'github',
      stamp: { name: 'reproduce-and-fix', version: 3 },
      retries: 2,
    })
  })

  it('says nothing about a run nobody asked for from outside', () => {
    expect(runsFromOf([], new Map()).size).toBe(0)
    expect(runsFromOf([row({})], new Map()).size).toBe(0)
  })

  it('keeps the first request where two name one effort', () => {
    const from = runsFromOf(
      [row({ item: 'github:1' }), row({ item: 'github:2', tasks: ['sentry/two'] })],
      new Map([
        ['sentry/one', 'shop'],
        ['sentry/two', 'shop'],
      ]),
    )
    expect(from.get('shop')?.item).toBe('github:1')
  })
})

describe('the workflows, read off disk', () => {
  const draft: Template = {
    template: 'reproduce-and-fix',
    version: 4,
    title: 'Reproduce, then fix',
    about: 'two steps',
    project_input: 'repo',
    said_input: 'about',
    inputs: {
      repo: { kind: 'project', required: true, about: '' },
      about: { kind: 'text', required: true, about: '' },
    },
    agents: [
      {
        name: 'reproduce',
        prompt: 'Write a failing test.',
        touches: [],
        after: [],
        reads: [],
        leaves_checks: 'red',
      },
    ],
  }

  async function homeWith(text: string | null): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'tade-workflows-'))
    if (text !== null) {
      const dirs = templateDirs(home)
      await mkdir(dirs.drafts, { recursive: true })
      await writeFile(join(dirs.drafts, 'reproduce-and-fix.yaml'), text, 'utf8')
    }
    return home
  }

  it('carries the draft, its hash, and what the validator said', async () => {
    const home = await homeWith(draftYaml(draft))
    const held = await workflowsRead(home, config(), new Map([['reproduce-and-fix', 2]]), true)
    const one = held.find((each) => each.name === 'reproduce-and-fix')
    expect(one?.shows).toBe('draft')
    expect(one?.draft?.version).toBe(4)
    expect(one?.rev).toMatch(/^sha256:/)
    expect(one?.runs).toBe(2)
    expect(one?.editable).toBe(true)
  })

  it('says a draft that will not parse as a problem, not as one with none', async () => {
    // The failure this prevents: a broken file drawn as a workflow that would
    // publish as it stands.
    const home = await homeWith('this: [is not, a template')
    const held = await workflowsRead(home, config(), new Map(), true)
    const one = held.find((each) => each.name === 'reproduce-and-fix')
    expect(one?.problems.length).toBeGreaterThan(0)
    expect(one?.shows).toBe('nothing')
    expect(one?.editable).toBe(false)
  })

  it('never offers a workflow Tade ships for saving, whatever the setting says', async () => {
    // Its bytes are in Tade's own source and `writeDraft` refuses the name —
    // said here as a fact rather than discovered at the save.
    const held = await workflowsRead(await homeWith(null), config(), new Map(), true)
    for (const one of held.filter((each) => each.builtIn))
      expect(one.editable, one.name).toBe(false)
  })

  it('offers nothing for saving while the setting is off', async () => {
    const home = await homeWith(draftYaml(draft))
    const held = await workflowsRead(home, config(), new Map(), false)
    for (const one of held) expect(one.editable, one.name).toBe(false)
  })
})

describe('the whole fold, as the away view takes it', () => {
  it('is empty and answers, with nothing handed over yet', () => {
    const floor = factoryHeld({
      rows: [],
      bodies: new Map(),
      titles: new Map(),
      efforts: new Map(),
      would: new Map(),
      doors: doorsOf({ config: config(), events: [], schedules: [], watches: null }),
      workflows: [],
    })
    expect(floor.intake).toEqual([])
    expect(floor.workflows).toEqual([])
    expect(floor.runFrom.size).toBe(0)
    // And the doors are there, which is the whole point: an empty inbox with
    // four rows saying why is not an empty screen.
    expect(floor.sources).toHaveLength(4)
  })
})
