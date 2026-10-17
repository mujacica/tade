import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Config, ConfigSchema, loadConfig, type RemoteConfig } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import { afterEach, describe, expect, it } from 'vitest'
import { Remotes, type RemotesDeps } from '../../src/wire/remotes.ts'

// The Mac's window linked to two other machines' Tades at once — the proof V6
// asked for (REMOTE-TADE.md §13) — through the window's own wiring: the
// config's `remotes`, the beat, the wake, the presence and the journal. The
// far ends are real away views (`far.ts`) and the link is the scripted one, so
// what is here is the window's half; the ssh link through a real `sshd` is its
// own suite.

interface Rig {
  remotes: Remotes
  lines: { type: string; detail: Record<string, string | number> }[]
  said: string[]
  configPath: string
  clock: { at: number; lastInputAt: number | null }
  config: Record<string, RemoteConfig>
  /** Read the config file again, as `Settings.use` hands the window a new one. */
  read: () => Promise<void>
}

const made: { fars: FarEnd[]; homes: string[]; remotes: Remotes[] } = {
  fars: [],
  homes: [],
  remotes: [],
}

afterEach(async () => {
  await Promise.all(made.remotes.map((one) => one.stop()))
  await Promise.all(made.fars.map((far) => far.close()))
  await Promise.all(
    [...made.fars.map((far) => far.home), ...made.homes].map((home) =>
      rm(home, { recursive: true, force: true }),
    ),
  )
  made.fars.length = 0
  made.homes.length = 0
  made.remotes.length = 0
})

const table = new Map<string, ScriptedRemote>()

/**
 * What carrying needs of the window, as a window with nothing set up has it:
 * a config read from the rig's file, no declared keys, and nobody at a screen.
 */
function carrying(
  config: () => Config,
  said: string[] = [],
  open = { settings: false },
): Pick<RemotesDeps, 'carrying' | 'settingsOpen'> {
  return {
    carrying: {
      config,
      secrets: () => new Set(),
      from: () => 'mac',
      onScreenWith: async () => {},
      said: (saved, error) => {
        said.push(error ?? saved ?? '')
      },
      draw: () => {},
    },
    settingsOpen: () => open.settings,
  }
}

async function far(projects: string[]): Promise<FarEnd> {
  const one = await startFarEnd({ projects })
  made.fars.push(one)
  return one
}

/** A remote block for a far end, paired the way `tade remote add` pairs. */
async function block(address: string, one: FarEnd): Promise<RemoteConfig> {
  table.set(address, one)
  const session = await one.pair('mac')
  return {
    ssh: address,
    tade: 'tade',
    device: session.device,
    session: session.cookie,
    csrf: session.csrf,
    host: session.host,
  }
}

/** A config file naming these remotes, after whatever else this machine was set up with. */
function yamlOf(config: Record<string, RemoteConfig>, mine = ''): string {
  return [
    mine,
    'remotes:',
    ...Object.entries(config).flatMap(([name, block]) => [
      `  ${name}:`,
      ...Object.entries(block).map(([key, value]) => `    ${key}: ${value}`),
    ]),
    '',
  ].join('\n')
}

async function rig(
  config: Record<string, RemoteConfig>,
  opts: { mine?: string; open?: { settings: boolean } } = {},
): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), 'tade-remotes-'))
  made.homes.push(home)
  const configPath = join(home, 'config.yaml')
  await writeFile(configPath, opts.mine === undefined ? '' : yamlOf(config, opts.mine))
  const clock = { at: Date.now(), lastInputAt: null as number | null }
  const lines: Rig['lines'] = []
  const said: string[] = []
  // The window's config: what the file says, read again whenever a test writes it.
  const mac = { config: ConfigSchema.parse({ remotes: config }) }
  const read = async () => {
    const loaded = await loadConfig(configPath)
    if (loaded.ok) mac.config = loaded.config
  }
  await read()
  const deps: RemotesDeps = {
    home,
    remotes: () => config,
    configPath,
    lastInputAt: () => clock.lastInputAt,
    now: () => clock.at,
    log: async (told) => {
      lines.push(told)
    },
    say: (line) => said.push(line),
    // Every remote here is reached the way `linkOf` says, which is `ssh`: the
    // scripted link stands in under that name and reaches the far ends by
    // the address in each block.
    links: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    ...carrying(() => mac.config, said, opts.open),
  }
  const remotes = new Remotes(deps)
  made.remotes.push(remotes)
  return { remotes, lines, said, configPath, clock, config, read }
}

/** Beat until it holds, on the rig's clock moved forward with real time. */
async function until(one: Rig, what: string, holds: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!holds()) {
    if (Date.now() > deadline)
      throw new Error(
        `waited ${ms}ms for ${what}: ${JSON.stringify(one.remotes.held().map((h) => [h.remote, h.link]))}`,
      )
    one.clock.at = Math.max(one.clock.at, Date.now())
    one.remotes.beat()
    await new Promise((done) => setTimeout(done, 25))
  }
}

const live =
  (one: Rig, ...names: string[]) =>
  () =>
    names.every((name) => one.remotes.held().find((h) => h.remote === name)?.link.kind === 'live')

const projects = (one: Rig, name: string) =>
  one.remotes
    .held()
    .find((h) => h.remote === name)
    ?.projection?.projects.map((p) => p.name) ?? []

describe('the window’s remotes', () => {
  it('links to two remotes at once, each holding its own projects, and writes each up once', async () => {
    const north = await far(['api', 'web'])
    const south = await far(['infra'])
    const one = await rig({ vps: await block('north', north), box: await block('south', south) })
    await until(one, 'both links up', live(one, 'vps', 'box'))
    expect(projects(one, 'vps')).toEqual(['api', 'web'])
    expect(projects(one, 'box')).toEqual(['infra'])
    north.show(['api', 'web', 'docs'])
    await until(one, 'docs on the first', () => projects(one, 'vps').includes('docs'))
    expect(projects(one, 'box')).toEqual(['infra'])
    // One line each for coming up, however many beats and frames there were.
    expect(one.lines.map((line) => [line.type, line.detail.remote]).sort()).toEqual([
      ['remote_linked', 'box'],
      ['remote_linked', 'vps'],
    ])
    expect(one.lines.find((line) => line.detail.remote === 'vps')?.detail.epoch).toBe(north.epoch)
  })

  it('carries this window’s last keypress to every remote', async () => {
    const north = await far(['api'])
    const south = await far(['infra'])
    const one = await rig({ vps: await block('north', north), box: await block('south', south) })
    await until(one, 'both links up', live(one, 'vps', 'box'))
    one.clock.lastInputAt = Date.now() - 2_000
    await until(
      one,
      'both far ends to hear it',
      () => north.presentAt !== null && south.presentAt !== null,
    )
  })

  it('writes a remote going down and coming back, and says one that signed this machine out', async () => {
    const north = await far(['api'])
    const config = { vps: await block('north', north) }
    const one = await rig(config)
    await until(one, 'the link up', live(one, 'vps'))
    await north.close()
    await until(one, 'the link down', () =>
      one.lines.some((line) => line.type === 'remote_unlinked'),
    )
    expect(one.lines.at(-1)?.detail).toMatchObject({
      remote: 'vps',
      state: 'down',
      problem: 'failed',
    })
    // What it last said is still held: never an empty world.
    expect(projects(one, 'vps')).toEqual(['api'])
    await north.reopen()
    await until(one, 'the link back', live(one, 'vps'))
    expect(one.lines.filter((line) => line.type === 'remote_linked')).toHaveLength(2)
    await north.revoke(config.vps.device)
    await until(one, 'the link ended', () => one.said.length > 0)
    expect(one.said[0]).toContain('vps signed this machine out')
    expect(one.lines.at(-1)?.detail).toMatchObject({ remote: 'vps', state: 'ended' })
  })

  it('lets go and links again at once when the gap between two beats says the machine slept', async () => {
    const north = await far(['api'])
    const one = await rig({ vps: await block('north', north) })
    await until(one, 'the link up', live(one, 'vps'))
    const was = one.remotes.held()[0]?.link
    const since = was?.kind === 'live' ? was.since : 0
    // Two hours between two beats is a lid that was closed.
    one.clock.at += 2 * 3_600_000
    one.remotes.beat()
    await until(one, 'a new stream', () => {
      const held = one.remotes.held()[0]
      return held?.link.kind === 'live' && held.link.since > since
    })
    // A redial is not news: the journal heard it come up once.
    expect(one.lines.filter((line) => line.type === 'remote_linked')).toHaveLength(1)
  })

  it('says a remote no link here can reach, once, rather than leaving it out in silence', async () => {
    const north = await far(['api'])
    const one = await rig({ vps: await block('north', north) })
    const quiet = new Remotes({
      home: '/nonexistent/home',
      remotes: () => ({ vps: { ...(one.config.vps as RemoteConfig) } }),
      configPath: one.configPath,
      lastInputAt: () => null,
      now: () => Date.now(),
      log: async () => {},
      say: (line) => one.said.push(line),
      links: {},
      ...carrying(() => ConfigSchema.parse({})),
    })
    made.remotes.push(quiet)
    quiet.beat()
    quiet.beat()
    expect(one.said).toEqual(['vps is reached by a link this Tade does not have (ssh)'])
    expect(quiet.held()).toEqual([])
  })

  it('follows the config: a remote removed is closed, and one added from a shell is linked', async () => {
    const north = await far(['api'])
    const south = await far(['infra'])
    const one = await rig({ vps: await block('north', north) })
    await until(one, 'the link up', live(one, 'vps'))
    // `tade remote add` writes the file from a shell; the window sees it move.
    const added = await block('south', south)
    const yaml = [
      'remotes:',
      '  box:',
      ...Object.entries(added).map(([key, value]) => `    ${key}: ${value}`),
      '',
    ].join('\n')
    await new Promise((done) => setTimeout(done, 20))
    await writeFile(one.configPath, yaml)
    await until(one, 'the added remote up', live(one, 'box'))
    // The file is the remotes now, so the one it does not name was closed.
    await until(one, 'the first closed', () => one.remotes.held().every((h) => h.remote !== 'vps'))
    await until(one, 'nothing streaming at the first', () => north.streams === 0)
  })
})

describe('this machine’s setup, kept in step there', () => {
  const KEY = 'jev-0123456789abcdef'
  const there = async (one: FarEnd): Promise<Config> => {
    const loaded = await loadConfig(join(one.home, 'config.yaml'))
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues))
    return loaded.config
  }
  /** Beat until the far end's config says so, with a ceiling. */
  const thereWhen = async (one: Rig, far: FarEnd, holds: (config: Config) => boolean) => {
    const deadline = Date.now() + 15_000
    while (!holds(await there(far))) {
      if (Date.now() > deadline)
        throw new Error(`waited for ${far.home}: ${JSON.stringify((await there(far)).agents)}`)
      one.clock.at = Math.max(one.clock.at, Date.now())
      one.remotes.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
  }

  it('carries the preferences when the link comes up, again when one changes here, and keys only on the press', async () => {
    const north = await far(['api'])
    const config = { vps: await block('north', north) }
    const mine = `agents:\n  commit: as-you-go\nextensions:\n  jev:\n    enabled: true\n    key: ${KEY}\n`
    const open = { settings: false }
    const one = await rig(config, { mine, open })
    await until(one, 'the link up', live(one, 'vps'))
    await thereWhen(one, north, (c) => c.agents.commit === 'as-you-go')
    const first = await there(north)
    expect(first.extensions.jev?.enabled).toBe(true)
    expect(first.extensions.jev?.key).toBeUndefined()

    // Changed here: the window hands on a new config, and the beat carries it.
    await writeFile(one.configPath, yamlOf(config, mine.replace('as-you-go', 'never')))
    await one.read()
    await thereWhen(one, north, (c) => c.agents.commit === 'never')

    // The Remotes page: the key waits on a press, and the press is offered.
    open.settings = true
    const shown = one.remotes.panel()?.remotes ?? []
    expect(shown[0]).toMatchObject({ name: 'vps', address: 'north', live: true })
    expect(shown[0]?.list?.waiting).toEqual(['extensions.jev.key'])
    expect((one.remotes.inputs().remoteActions ?? []).map((one) => one.id)).toContain(
      'remote:keys:vps',
    )

    await one.remotes.action('remote:keys:vps')
    expect((await there(north)).extensions.jev?.key).toBe(KEY)
    expect(one.said.at(-1)).toBe('Sent to vps: extensions.jev.key.')
    const line = one.lines.filter((l) => l.type === 'remote_carried').at(-1)
    expect(line?.detail).toMatchObject({ remote: 'vps', by: 'window', sent: 'extensions.jev.key' })
    expect(JSON.stringify(one.lines)).not.toContain(KEY)
    expect(JSON.stringify(north.lines)).not.toContain(KEY)
  })

  it('draws nothing of it while Settings is closed', async () => {
    const north = await far(['api'])
    const one = await rig({ vps: await block('north', north) })
    expect(one.remotes.panel()).toEqual({})
    expect(one.remotes.inputs()).toEqual({})
  })
})
