import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type RemoteConfig, remoteDocumentPath } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { MachineAnswer } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteMachines } from '../../src/wire/remote-machine.ts'
import { Remotes } from '../../src/wire/remotes.ts'

// What another machine says it is, asked as its owner over the link the window
// holds (`remote-machine.ts`), against a real far away view (`far.ts`): asked
// when the link comes up, folded into the machine with the round trip, kept
// with when it was said once the link is down; one of its documents read into
// a copy in this home; one of its tools that only reads run there.

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

const AT = new Date().toISOString()

const MACHINE: MachineAnswer = {
  at: AT,
  version: '0.2.3',
  newer: 'Tade 0.2.4 is out',
  public: { name: 'tade.example.com', up: true, health: [] },
  problems: [{ from: 'extension', at: null, said: 'Sentry needs setting up: no token' }],
  schedules: [],
  documents: [
    {
      task: 'far/plan',
      project: 'far',
      name: 'PLAN.md',
      state: 'written',
      at: AT,
      bytes: 9,
      triaged: false,
    },
  ],
}

/** The window's remotes, linked to one far end as `vps`, asking it what it is. */
async function linked() {
  const far = await startFarEnd({ projects: ['far'] })
  made.fars.push(far)
  far.machine = MACHINE
  const home = await mkdtemp(join(tmpdir(), 'tade-remote-machine-'))
  made.homes.push(home)
  const configPath = join(home, 'config.yaml')
  await writeFile(configPath, '')
  const session = await far.pair('mac')
  const vps: RemoteConfig = {
    ssh: 'north',
    tade: 'tade',
    device: session.device,
    session: session.cookie,
    csrf: session.csrf,
    host: session.host,
  }
  const table = new Map<string, ScriptedRemote>([['north', far]])
  const config = ConfigSchema.parse({ remotes: { vps } })
  const clock = { at: Date.now() }
  const remotes = new Remotes({
    home,
    remotes: () => config.remotes,
    configPath,
    lastInputAt: () => null,
    now: () => clock.at,
    log: async () => {},
    say: () => {},
    links: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    here: 'this Mac',
    go: () => {},
    draw: () => {},
    carrying: {
      config: () => config,
      secrets: () => new Set(),
      from: () => 'mac',
      onScreenWith: async () => {},
      said: () => {},
      draw: () => {},
    },
    settingsOpen: () => false,
  }).withMachines(
    (one) =>
      new RemoteMachines({
        home,
        reach: (name) => one.reachFor(name),
        now: () => Date.now(),
        draw: () => {},
      }),
  )
  made.remotes.push(remotes)
  const until = async (what: string, holds: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!holds()) {
      if (Date.now() > deadline) throw new Error(`waited ${ms}ms for ${what}`)
      clock.at = Math.max(clock.at, Date.now())
      remotes.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const vpsNow = () => remotes.machines().remotes.find((one) => one.name === 'vps')
  return { far, home, remotes, until, vpsNow }
}

describe('what another machine says it is', () => {
  it('is asked when the link comes up and folded into the machine, with the round trip', async () => {
    const { far, until, vpsNow } = await linked()
    await until('vps said what it is', () => vpsNow()?.detail.about !== null)
    const about = vpsNow()?.detail.about
    expect(about?.version).toBe('0.2.3')
    expect(about?.newer).toBe('Tade 0.2.4 is out')
    expect(about?.problems.map((one) => one.said)).toEqual(['Sentry needs setting up: no token'])
    expect(about?.roundTrip).toBeGreaterThanOrEqual(0)
    expect(far.machineAsked).toBe(1)
  })

  it('keeps what it last said, with when, once its link is down', async () => {
    const { far, until, vpsNow } = await linked()
    await until('vps said what it is', () => vpsNow()?.detail.about !== null)
    const said = vpsNow()?.detail.about?.at
    await far.close()
    await until('the link down', () => vpsNow()?.link === 'down', 30_000)
    expect(vpsNow()?.detail.about?.version).toBe('0.2.3')
    expect(vpsNow()?.detail.about?.at).toBe(said)
    expect(vpsNow()?.asOf).not.toBeNull()
  })

  it('reads one of its documents into a copy in this home, and refuses a name that walks before asking', async () => {
    const { far, home, remotes, until, vpsNow } = await linked()
    far.documents.set('far/plan/PLAN.md', { at: AT, text: '# The plan\n' })
    await until('vps said what it is', () => vpsNow()?.detail.about !== null)
    const asked = remotes.asked()
    const path = await asked?.document('vps', 'far/plan', 'PLAN.md')
    expect(path).toBe(remoteDocumentPath(home, 'vps', 'far/plan', 'PLAN.md'))
    expect(await readFile(path ?? '', 'utf8')).toBe('# The plan\n')
    await expect(asked?.document('vps', 'far/plan', '../../config.yaml')).rejects.toThrow(
      "not a file's name",
    )
    await expect(asked?.document('vps', 'far/plan', 'GONE.md')).rejects.toThrow(
      'vps has no document of far/plan called GONE.md',
    )
  })

  it('runs one of its tools that only reads, there, and says what it said where it failed', async () => {
    const { far, remotes, until, vpsNow } = await linked()
    far.tools.set('sentry_issues', (input) => ({
      text: `two issues in ${String(input.project)}`,
      failed: false,
    }))
    far.tools.set('sentry_broken', () => ({ text: 'no Sentry token there', failed: true }))
    await until('vps said what it is', () => vpsNow()?.detail.about !== null)
    const asked = remotes.asked()
    expect(await asked?.tool('vps', 'sentry_issues', { project: 'far' })).toBe('two issues in far')
    await expect(asked?.tool('vps', 'sentry_broken', {})).rejects.toThrow(
      'sentry_broken on vps: no Sentry token there',
    )
    await expect(asked?.tool('vps', 'sentry_update_issue', {})).rejects.toThrow(
      'vps has no sentry_update_issue that only reads',
    )
  })
})
