import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema, type Workspace } from '@tade/core'
import { ExtensionHost, type TadeExtension } from '@tade/extensions-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import { projector, reachOf, SnapshotSchema } from '@tade/web'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { App } from '../../src/app.ts'
import { awayCollections } from '../../src/away.ts'
import { type Beatable, beatParts } from '../../src/wire/web-beat.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// One machine per repository for every watch on an outside source, through
// the whole window (REMOTE-TADE.md §9.5): a remote whose projection says it
// looks with a watch on the same repository keeps this machine's off, a watch
// already on here is handed over the moment the remote starts looking and said
// once, and taken back it starts from where the remote last had it.
//
// The far end is a real away view (`far.ts`) answering where its work is with
// a real clone of this repository, over the scripted link; the watches are an
// extension of the test's, one reaching off the machine and one that does not.

const REPOSITORY = 'git@github.com:acme/app.git'

/** Every look a watch took, with where it was told to start. */
interface Looked {
  watch: string
  since: string | null
  turnedOn: string
}

function weather(looked: Looked[]): TadeExtension {
  return {
    name: 'weather',
    title: 'Weather',
    description: 'Whether it is raining.',
    watches: [
      {
        id: 'rain',
        title: 'Rain',
        means: 'Asks the radar, which is somewhere else.',
        every: '1h',
        network: true,
        about: 'repository',
        offers: 'ask',
        check: async (ctx) => {
          looked.push({ watch: 'rain', since: ctx.since, turnedOn: ctx.turnedOn })
          return { found: [], since: 'radar-cursor' }
        },
      },
      {
        id: 'attic',
        title: 'Attic',
        means: 'Listens to this house, and nothing else.',
        every: '1h',
        offers: 'ask',
        check: async (ctx) => {
          looked.push({ watch: 'attic', since: ctx.since, turnedOn: ctx.turnedOn })
          return { found: [] }
        },
      },
    ],
  }
}

describe('one machine per repository, in this window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let repo: Repo
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    home = one.home
    repo = one.repo
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)

  /** The window linked to `vps`, whose project `tade` is a clone of this checkout. */
  async function linked(
    looked: Looked[],
    project: { watches?: string } = {},
  ): Promise<{ far: FarEnd; window: App }> {
    repo.git('remote', 'add', 'origin', REPOSITORY)
    const there = join(tmp('tade-there-'), 'repo')
    runGit(repo.root, 'clone', '-q', repo.root, there)
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'])
    far.repositories = [
      {
        project: 'tade',
        root: there,
        repository: 'github.com/acme/app',
        base: 'main',
        branches: [],
      },
    ]
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    const app = { root: repo.root, ...project }
    await writeFile(
      join(home, 'config.yaml'),
      [
        'projects:\n  app:',
        ...Object.entries(app).map(([key, value]) => `    ${key}: ${value}`),
        'remotes:\n  vps:',
        ...Object.entries(vps).map(([key, value]) => `    ${key}: ${value}`),
        '',
      ].join('\n'),
    )
    const extensions = await ExtensionHost.load({
      builtin: [weather(looked)],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    terminal.rows = 50
    terminal.columns = 160
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const window = await wired.start({
      config: ConfigSchema.parse({ projects: { app }, remotes: { vps } }),
      remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
      extensions,
      thinker: { ask: async () => 'ok', tell: async () => {} },
    })
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    return { far, window }
  }

  /** What `tade_watches` says about one watch in `app`. */
  const listed = async (window: App, watch: string) =>
    (await window.watchTools().watches(watch)).split('\n').find((line) => line.includes('app:'))

  const leftLooks = async () =>
    (await client.events({ types: ['watch_checked'] })).filter((one) => one.detail.on === 'vps')

  it('keeps this machine’s watch off where the remote looks with it on the same repository, and says why', async () => {
    const looked: Looked[] = []
    const { far, window } = await linked(looked)
    far.watching.set('tade', ['weather.rain'])
    await until(
      'vps has said what it looks with there',
      async () => (await listed(window, 'rain'))?.includes('on vps') === true,
      30_000,
    )
    expect(await listed(window, 'rain')).toBe(
      '  app: on vps, not here — vps looks with it on the same repository (tade there), so this machine does not',
    )
    const tools = window.queueTools()
    await expect(
      tools.schedule({
        name: 'Rain',
        project: 'app',
        said: 'watch the rain',
        watch: 'weather.rain',
        by: 'you',
      }),
    ).rejects.toThrow(
      'Rain stays off in app: vps looks with it on the same repository (tade there), so this machine does not',
    )
    // A watch that reads only this machine is this machine's, whatever is there.
    await tools.schedule({
      name: 'Attic',
      project: 'app',
      said: 'watch the attic',
      watch: 'weather.attic',
      by: 'you',
    })
    expect(client.schedules().map((one) => one.id)).toEqual(['attic'])
    await tools.change({ schedule: 'attic', change: 'start', by: 'you' })
    expect(looked.map((one) => one.watch)).toEqual(['attic'])
  })

  it('is the remote’s by default where the repository is a project there, and says what it is missing', async () => {
    const looked: Looked[] = []
    const { window } = await linked(looked)
    await until(
      'vps has said where its work is',
      async () => (await listed(window, 'rain'))?.includes('on vps') === true,
      30_000,
    )
    expect(await listed(window, 'rain')).toBe(
      "  app: on vps, not here — app's repository is a project on vps too (tade), so it is vps's to watch, which does not look with it: turn it on there, or set projects.app.watches to here",
    )
  })

  it('hands a watch over the moment the remote starts looking, says so once, and takes it back from where the remote had it', async () => {
    const looked: Looked[] = []
    const { far, window } = await linked(looked, { watches: 'here' })
    // Heard from: what it looks with there is known, and then it stops.
    far.watching.set('tade', ['weather.rain'])
    await until(
      'vps looking with it',
      async () => (await listed(window, 'rain'))?.includes('on vps') === true,
      30_000,
    )
    far.watching.set('tade', [])
    await until(
      'vps not looking with it',
      async () => (await listed(window, 'rain'))?.includes('on vps') === false,
      30_000,
    )
    const tools = window.queueTools()
    await tools.schedule({
      name: 'Rain',
      project: 'app',
      said: 'watch the rain',
      watch: 'weather.rain',
      by: 'you',
    })
    await tools.change({ schedule: 'rain', change: 'start', by: 'you' })
    expect(looked).toHaveLength(1)

    // It starts looking there: this machine's look is written as left to it at
    // once, without waiting an hour for its turn, and nothing asks the radar.
    far.watching.set('tade', ['weather.rain'])
    await until('the watch left to vps', async () => (await leftLooks()).length === 1, 30_000)
    const said =
      'Rain in app is left to vps: vps looks with it on the same repository (tade there), so this machine does not'
    await until('said where a person reads it', () =>
      rows().some((row) => row.includes('Rain in app is left to vps')),
    )
    await tools.change({ schedule: 'rain', change: 'start', by: 'you' })
    expect(looked).toHaveLength(1)
    const [left] = await leftLooks()
    expect(left?.detail).toMatchObject({ since: null, on: 'vps' })
    expect(String(left?.detail.said)).toBe(
      `${said.slice('Rain in app is left to vps: '.length)} — projects.app.watches says here, so turn it off on vps to have it look here`,
    )
    expect(await listed(window, 'rain')).toContain('app: on vps, not here')

    // It stops there: the project says here, so the next look is this
    // machine's — and starts from the last moment vps had it, not from where
    // this machine's own look left off before.
    far.watching.set('tade', [])
    await until(
      'vps not looking with it',
      async () => (await listed(window, 'rain'))?.includes('on vps') === false,
      30_000,
    )
    await tools.change({ schedule: 'rain', change: 'start', by: 'you' })
    const lefts = await leftLooks()
    expect(looked).toHaveLength(2)
    expect(looked[1]).toEqual({ watch: 'rain', since: null, turnedOn: lefts.at(-1)?.ts })
  })
})

describe('what this machine’s projection says it watches', () => {
  const NOW = Date.parse('2026-10-17T10:00:00.000Z')
  const world = {
    generatedAt: new Date(NOW).toISOString(),
    projects: [
      { name: 'app', root: '/nowhere', brief: null, untracked: [], tasks: [] },
      { name: 'web', root: '/elsewhere', brief: null, untracked: [], tasks: [] },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
  const live: Beatable = {
    events: [],
    rootLines: [],
    pending: [],
    seenActions: () => null,
    spendToday: () => ({ byTask: {} }),
    queued: [],
    queueFacts: () => ({ tasks: new Map(), finished: new Map(), events: [], now: NOW }),
    notes: () => [],
    plans: [],
    titles: {},
    tasks: [],
    machineUpSince: null,
    spendSince: null,
    checks: null,
    watching: new Map([['app', ['review.branch-checks', 'sentry.new-errors']]]),
  }

  it('carries each project’s outside watches on its row, to every device that reads the project', () => {
    const made = awayCollections(beatParts(live, world, () => ({ how: null, why: 'none' })))
    const reach = reachOf({ id: 'aaaaaaaaaaaaaaaa', projects: null, granted: [] })
    const snapshot = projector(
      { ...made, talk: null, reach, lifetime: { epoch: 'e', rev: 0, openedAt: NOW } },
      NOW,
    ).snapshot()
    // The strict schema is the allow-list: a field it does not name is a failure.
    expect(SnapshotSchema.parse(snapshot).projects.map((one) => [one.name, one.watching])).toEqual([
      ['app', ['review.branch-checks', 'sentry.new-errors']],
      ['web', []],
    ])
  })
})
