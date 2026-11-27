import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Inventory, type RemoteConfig } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { MachineAnswer, OrchestratorStanding } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { checkoutAt, HANDED_REF } from '../../src/wire/fleet-checkout.ts'
import { CHECK_FILE, type CheckoutHere, FleetReload } from '../../src/wire/fleet-reload.ts'
import { RemoteMachines } from '../../src/wire/remote-machine.ts'
import { Remotes } from '../../src/wire/remotes.ts'

// Reload, every machine at once (`fleet-reload.ts`), the way the rehearsal
// drives two VPSes and a Mac — here over the scripted link, to far ends that
// are real away views (`far.ts`): `ipax` the hub, `hetz` the other server,
// and this Mac's window holding both links. One press moves the one that is
// behind to this Mac's version by its own `tade host upgrade` in a terminal
// over the link, starts the other again through its own `/api/restart`, says
// each as it comes back, and reloads this window last; the window that comes
// back checks that the conversation is one across them. And what is never
// left silent: a machine that cannot be reached, one whose lanes would stop.
// And the hint: said once when a sign-in there means a reload would bring
// the orchestrators together, and gone once the reload has.

const made: { fars: FarEnd[]; homes: string[]; remotes: Remotes[]; timers: NodeJS.Timeout[] } = {
  fars: [],
  homes: [],
  remotes: [],
  timers: [],
}

afterEach(async () => {
  for (const timer of made.timers.splice(0)) clearInterval(timer)
  await Promise.all(made.remotes.splice(0).map((one) => one.stop()))
  const fars = made.fars.splice(0)
  await Promise.all(fars.map((far) => far.close()))
  await Promise.all(
    [...fars.map((far) => far.home), ...made.homes.splice(0)].map((home) =>
      rm(home, { recursive: true, force: true }),
    ),
  )
})

const HERE = '0.4.3'

const UP: OrchestratorStanding = {
  state: 'up',
  said: null,
  shares: true,
  joined: null,
  model: null,
}
const NOT_SIGNED_IN: OrchestratorStanding = {
  ...UP,
  state: 'failed',
  said: 'Claude Code is not signed in here: `tade accounts sign-in claude-code`',
  shares: false,
}

const machine = (version: string, orchestrator: OrchestratorStanding, inventory?: Inventory) =>
  ({
    at: new Date().toISOString(),
    version,
    newer: null,
    public: null,
    problems: [],
    schedules: [],
    documents: [],
    orchestrator,
    ...(inventory && { inventory }),
  }) satisfies MachineAnswer

const VROLTA: Inventory = {
  machine: 'ipax',
  at: new Date().toISOString(),
  shell: 'bash',
  service: true,
  items: [
    {
      id: 'sign-in:claude-code:vrolta',
      kind: 'sign-in',
      label: 'Claude Code · vrolta',
      state: 'set',
      digest: null,
      until: null,
      where: [],
      said: null,
      variables: [],
      service: null,
    },
  ],
}

/**
 * This Mac, linked as an owner to a far end per name: its remotes and what
 * asks each what it is, beating on their own as the window's beat does, and a
 * reload of every machine over them. `tade` there is a line that writes down
 * what it was asked, as `tade host upgrade` would be run there.
 */
async function mac(names: readonly string[], home?: string, checkout?: CheckoutHere) {
  const fars = new Map<string, FarEnd>()
  for (const name of names) {
    const far = await startFarEnd({ projects: ['tade'] })
    made.fars.push(far)
    far.machine = machine(HERE, UP)
    fars.set(name, far)
  }
  const at = home ?? (await mkdtemp(join(tmpdir(), 'tade-fleet-reload-')))
  if (home === undefined) made.homes.push(at)
  const configPath = join(at, 'config.yaml')
  await writeFile(configPath, '')
  const tade = join(at, 'tade-there')
  const asked = join(at, 'asked-there')
  writeFileSync(tade, `#!/bin/sh\necho "$@" >> '${asked}'\n`)
  chmodSync(tade, 0o755)
  const remotes: Record<string, RemoteConfig> = {}
  const table = new Map<string, ScriptedRemote>()
  for (const [name, far] of fars) {
    const session = await far.pair('mac')
    remotes[name] = {
      ssh: name,
      tade,
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    table.set(name, far)
  }
  const config = ConfigSchema.parse({ remotes })
  const one = new Remotes({
    home: at,
    remotes: () => config.remotes,
    configPath,
    lastInputAt: () => null,
    now: () => Date.now(),
    log: async () => {},
    say: () => {},
    links: {
      ssh: (options) => makeScriptedLink({ ...options, remotes: table, terminals: true }),
    },
    here: 'this Mac',
    go: () => {},
    draw: () => {},
    carrying: {
      config: () => config,
      fold: async () => {},
      secrets: () => new Set(),
      from: () => 'mac',
      onScreenWith: async () => {},
      said: () => {},
      draw: () => {},
      lines: async () => [],
      found: async () => {},
      take: async () => {},
      conflicted: async () => {},
    },
    settingsOpen: () => false,
  }).withMachines(
    (remotes) =>
      new RemoteMachines({
        home: at,
        reach: (name) => remotes.reachFor(name),
        now: () => Date.now(),
        draw: () => {},
      }),
  )
  made.remotes.push(one)
  const beating = setInterval(() => one.beat(), 25)
  made.timers.push(beating)
  const said: string[] = []
  const screens: string[][] = []
  /** What `tade host upgrade` there did once its terminal ended, by machine: a test says. */
  const upgrading = new Map<string, () => void>()
  const reloaded: number[] = []
  /** The hub this Mac's conversation was last one with: what its exchange would say. */
  const conversation = { oneWith: null as string | null }
  const fleet = new FleetReload({
    home: at,
    names: () => one.inventories().map((remote) => remote.name),
    reach: (name) => one.reachFor(name),
    held: (name) => one.held().find((held) => held.remote === name) ?? null,
    answer: (name) => one.asked()?.held(name) ?? null,
    ask: async (name) => await one.asked()?.ask(name),
    hub: () => 'ipax',
    oneWith: () => conversation.oneWith,
    here: () => ({ ...UP, joined: conversation.oneWith }),
    version: () => HERE,
    // This Mac as an install, unless a test says it runs from a checkout.
    checkout: checkout ?? checkoutAt(null),
    hereName: 'this Mac',
    // The terminal over the window, run as the person would watch it run.
    onScreenWith: async (flow) =>
      flow({
        say: () => {},
        run: async (title: string, command: string, args: readonly string[]) => {
          screens.push([title, ...args])
          const ran = spawnSync(command, [...args], { encoding: 'utf8' })
          upgrading.get(title.replace('Tade on ', ''))?.()
          return ran.status ?? 1
        },
      } as never),
    reloadHere: async () => {
      reloaded.push(Date.now())
    },
    say: (line) => said.push(line),
    now: () => Date.now(),
    times: { back: 20_000, poll: 50, upgraded: 5_000, check: 20_000, settle: 300 },
  })
  const until = async (what: string, holds: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms
    while (!holds()) {
      if (Date.now() > deadline)
        throw new Error(`waited ${ms}ms for ${what}; said:\n${said.join('\n')}`)
      fleet.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const linked = async () => {
    await until('every machine linked and answered', () =>
      names.every(
        (name) => one.reachFor(name)?.live === true && one.asked()?.held(name)?.answer != null,
      ),
    )
    // The window beats on: what they answered is what this one heard first.
    fleet.beat()
  }
  return {
    home: at,
    fars,
    fleet,
    remotes: one,
    said,
    screens,
    upgrading,
    reloaded,
    conversation,
    until,
    linked,
    asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8') : ''),
  }
}

describe('one press reloads every machine', () => {
  it('moves the one behind to this version there, restarts the other, says each, and reloads here last', async () => {
    const box = await mac(['ipax', 'hetz'])
    const ipax = box.fars.get('ipax')!
    const hetz = box.fars.get('hetz')!
    ipax.machine = machine('0.4.2', NOT_SIGNED_IN)
    hetz.machine = machine(HERE, { ...UP, joined: 'ipax' })
    await box.linked()
    // `tade host upgrade --yes` there moves it and restarts its service itself.
    box.upgrading.set('ipax', () => {
      ipax.machine = machine(HERE, UP)
      void ipax.restart()
    })
    await box.fleet.reload()

    expect(box.asked()).toBe(`host upgrade --yes --to ${HERE}\n`)
    expect(box.screens.map((one) => one[0])).toEqual(['Tade on ipax'])
    // Restarted by its own upgrade, so never asked to again; the other through its door.
    expect(ipax.restarted).toEqual([])
    expect(hetz.restarted).toHaveLength(1)
    expect(box.said[0]).toBe(
      'Reloading every machine: ipax and hetz first, then this Mac. Agents keep working.',
    )
    expect(box.said).toContain(`ipax runs Tade 0.4.2: updating it to ${HERE} first.`)
    expect(box.said).toContain(`ipax is back on Tade ${HERE}.`)
    expect(box.said).toContain('hetz is restarting.')
    expect(box.said).toContain(`hetz is back on Tade ${HERE}.`)
    expect(box.said.at(-1)).toBe('this Mac reloads now.')
    expect(box.reloaded).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(box.home, CHECK_FILE), 'utf8')).machines).toEqual([
      'ipax',
      'hetz',
    ])

    // The window that comes back: the same home, nothing held, and the check owed.
    for (const one of made.remotes.splice(0)) await one.stop()
    const after = await macAgain(box.home, box.fars)
    after.conversation.oneWith = 'ipax'
    await after.until('the check after the reload', () =>
      after.said.some((one) => one.startsWith('After the reload:')),
    )
    expect(after.said).toContain(
      'After the reload: the conversation is one across this Mac and ipax and hetz, and no orchestrator reports a sign-in or model problem.',
    )
    expect(existsSync(join(box.home, CHECK_FILE))).toBe(false)
  }, 60_000)

  it('says plainly the machine it cannot reach and the one whose lanes would stop, and still reloads here', async () => {
    const box = await mac(['ipax', 'hetz'])
    const ipax = box.fars.get('ipax')!
    const hetz = box.fars.get('hetz')!
    await box.linked()
    hetz.restartStops = 2
    await ipax.close()
    await box.until('ipax down', () => box.remotes.reachFor('ipax')?.live === false)
    await box.fleet.reload()
    expect(box.said.find((one) => one.startsWith('ipax could not be reached'))).toMatch(
      /^ipax could not be reached, so it was not reloaded/,
    )
    expect(box.said).toContain(
      'hetz was not restarted, because 2 lanes there would stop: agents keep working, and it reloads once nothing runs inside its Tade (or restart it there)',
    )
    expect(hetz.restarted).toEqual([])
    expect(box.reloaded).toHaveLength(1)
    // Nothing came back, so nothing is owed a check.
    expect(existsSync(join(box.home, CHECK_FILE))).toBe(false)
  }, 60_000)

  it('says what stands in the way after it: an orchestrator there that did not start', async () => {
    const box = await mac(['ipax'])
    const ipax = box.fars.get('ipax')!
    await box.linked()
    ipax.onRestart = () => {
      ipax.machine = machine(HERE, { ...NOT_SIGNED_IN })
    }
    await box.fleet.reload()
    for (const one of made.remotes.splice(0)) await one.stop()
    const after = await macAgain(box.home, box.fars)
    await after.until('the check after the reload', () =>
      after.said.some((one) => one.startsWith('After the reload:')),
    )
    expect(after.said.find((one) => one.startsWith('After the reload:'))).toBe(
      'After the reload: ipax’s orchestrator did not start: Claude Code is not signed in here: `tade accounts sign-in claude-code`.',
    )
  }, 60_000)
})

describe('a machine that runs from a checkout moves to this one’s HEAD', () => {
  /** This Mac's checkout, a commit ahead of the clone ipax runs from; and that clone. */
  function checkouts() {
    const mine = mkrepo()
    const there = `${tmp('tade-run-')}/tade-run`
    runGit(mine.root, 'clone', '-q', mine.root, there)
    const was = runGit(there, 'rev-parse', 'HEAD').trim()
    mine.commit('ahead of origin', { 'a.txt': 'a\n' })
    const head = runGit(mine.root, 'rev-parse', 'HEAD').trim()
    return { mine, there, was, head }
  }
  const at = (root: string, commit: string) => ({ root, commit })

  it('hands it this commit, moves it there by `--commit`, and says it is back on it', async () => {
    const { mine, there, was, head } = checkouts()
    const box = await mac(['ipax'], undefined, checkoutAt(mine.root))
    const ipax = box.fars.get('ipax')!
    // The same version on both: only the commit says it is behind.
    ipax.machine = { ...machine(HERE, UP), checkout: at(there, was) }
    await box.linked()
    box.upgrading.set('ipax', () => {
      ipax.machine = { ...machine(HERE, UP), checkout: at(there, head) }
      void ipax.restart()
    })
    await box.fleet.reload()

    expect(box.asked()).toBe(`host upgrade --yes --commit ${head}\n`)
    // Handed into Tade's own ref, no branch there touched by it.
    expect(runGit(there, 'rev-parse', HANDED_REF).trim()).toBe(head)
    expect(runGit(there, 'rev-parse', 'main').trim()).toBe(was)
    expect(box.said).toContain(
      `ipax runs from ${was.slice(0, 9)}: moving it to this Mac’s ${head.slice(0, 9)} first.`,
    )
    expect(box.said).toContain(`ipax is back on ${head.slice(0, 9)}, Tade ${HERE}.`)
    expect(ipax.restarted).toEqual([])
    expect(box.reloaded).toHaveLength(1)
  }, 60_000)

  it('only restarts one already on this commit, and says if it came back on another', async () => {
    const { mine, there, head } = checkouts()
    const box = await mac(['ipax'], undefined, checkoutAt(mine.root))
    const ipax = box.fars.get('ipax')!
    ipax.machine = { ...machine(HERE, UP), checkout: at(there, head) }
    await box.linked()
    await box.fleet.reload()
    expect(box.asked()).toBe('')
    expect(ipax.restarted).toHaveLength(1)
    expect(box.said).toContain(`ipax is back on ${head.slice(0, 9)}, Tade ${HERE}.`)
  }, 60_000)

  it('never moves one back: a checkout not behind this HEAD is restarted on what it has, and that is said', async () => {
    const { mine, there, head } = checkouts()
    runGit(
      there,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'its own',
    )
    const theirs = runGit(there, 'rev-parse', 'HEAD').trim()
    const box = await mac(['ipax'], undefined, checkoutAt(mine.root))
    const ipax = box.fars.get('ipax')!
    ipax.machine = { ...machine(HERE, UP), checkout: at(there, theirs) }
    await box.linked()
    await box.fleet.reload()
    expect(box.asked()).toBe('')
    expect(() => runGit(there, 'rev-parse', '--verify', '--quiet', HANDED_REF)).toThrow()
    expect(box.said).toContain(
      `ipax runs from ${theirs.slice(0, 9)}, which is not behind this Mac’s ${head.slice(0, 9)}: a checkout only moves forward, so it is restarted on what it has.`,
    )
    expect(ipax.restarted).toHaveLength(1)
    expect(box.said).toContain(`ipax is back on Tade ${HERE}.`)
  }, 60_000)

  it('says git here could not tell, rather than not behind, and restarts it on what it has', async () => {
    const { mine, there, was, head } = checkouts()
    // Its commit is here and git cannot read it, so `--is-ancestor` fails rather than answers.
    chmodSync(join(mine.root, '.git', 'objects', was.slice(0, 2), was.slice(2)), 0)
    const box = await mac(['ipax'], undefined, checkoutAt(mine.root))
    const ipax = box.fars.get('ipax')!
    ipax.machine = { ...machine(HERE, UP), checkout: at(there, was) }
    await box.linked()
    await box.fleet.reload()
    expect(box.asked()).toBe('')
    expect(box.said).toContain(
      `ipax runs from ${was.slice(0, 9)}, and git here could not tell whether that is behind this Mac’s ${head.slice(0, 9)}: it is restarted on what it has.`,
    )
    expect(box.said.some((one) => one.includes('which is not behind'))).toBe(false)
    expect(ipax.restarted).toHaveLength(1)
  }, 60_000)

  it('restarts nothing where the commit could not be handed over', async () => {
    const { mine, head } = checkouts()
    const box = await mac(['ipax'], undefined, checkoutAt(mine.root))
    const ipax = box.fars.get('ipax')!
    const was = runGit(mine.root, 'rev-parse', 'HEAD~1').trim()
    ipax.machine = { ...machine(HERE, UP), checkout: at(join(tmp('tade-gone-'), 'nothing'), was) }
    await box.linked()
    await box.fleet.reload()
    expect(box.asked()).toBe('')
    expect(ipax.restarted).toEqual([])
    const said = box.said.find((one) => one.startsWith(`${head.slice(0, 9)} could not be handed`))
    expect(said).toMatch(/^\w+ could not be handed to ipax, so it was not restarted: /)
  }, 60_000)
})

describe('this checkout, asked whether a commit is behind its HEAD', () => {
  it('answers behind, not behind, or cannot tell — and a failed look is never not behind', async () => {
    const mine = mkrepo()
    const was = runGit(mine.root, 'rev-parse', 'HEAD').trim()
    mine.commit('after', { 'a.txt': 'a\n' })
    const head = runGit(mine.root, 'rev-parse', 'HEAD').trim()
    const tree = runGit(mine.root, 'rev-parse', 'HEAD^{tree}').trim()
    const apart = runGit(mine.root, 'commit-tree', tree, '-m', 'apart').trim()
    const here = checkoutAt(mine.root)
    expect(await here.behind(was, head)).toBe('behind')
    expect(await here.behind(head, was)).toBe('not behind')
    expect(await here.behind(apart, head)).toBe('not behind')
    // A commit this machine has not got is not before its HEAD...
    expect(await here.behind('d'.repeat(40), head)).toBe('not behind')
    // ...but whether HEAD is before one it has not got, it cannot say.
    expect(await here.behind(head, 'd'.repeat(40))).toBe('cannot tell')
    // Not a repository at all, and no checkout: git failed, or was never asked.
    expect(await checkoutAt(tmp('tade-not-a-repo-')).behind(was, head)).toBe('cannot tell')
    expect(await checkoutAt(null).behind(was, head)).toBe('cannot tell')
    expect(await here.behind('not a commit', head)).toBe('cannot tell')
    // A shallow clone has not got what is past its edge, so absent says nothing there.
    const shallow = `${tmp('tade-shallow-')}/s`
    runGit(mine.root, 'clone', '-q', '--depth', '1', `file://${mine.root}`, shallow)
    expect(await checkoutAt(shallow).behind('d'.repeat(40), head)).toBe('cannot tell')
    // Here, and unreadable: git exits 128 as for one it has not got, and that is not an answer.
    chmodSync(join(mine.root, '.git', 'objects', apart.slice(0, 2), apart.slice(2)), 0)
    expect(await here.behind(apart, head)).toBe('cannot tell')
  })
})

describe('a reload due, said once', () => {
  it('appears once a sign-in there would bring the two together, and goes away after the reload', async () => {
    const box = await mac(['ipax'])
    const ipax = box.fars.get('ipax')!
    ipax.machine = machine(HERE, NOT_SIGNED_IN)
    await box.linked()
    expect(box.fleet.due()).toBeNull()
    // Signed in there, its orchestrator still the one that could not start.
    ipax.machine = machine(HERE, NOT_SIGNED_IN, VROLTA)
    await box.remotes.asked()?.ask('ipax')
    const hint =
      'Claude Code · vrolta is newly signed in on ipax, so ipax’s orchestrator can now share this conversation — Reload to bring the two together'
    await box.until('the hint', () => box.said.includes(hint))
    // Beats, and another answer saying the same: never said again.
    await box.remotes.asked()?.ask('ipax')
    for (let beat = 0; beat < 20; beat++) {
      box.fleet.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
    expect(box.said.filter((one) => one === hint)).toHaveLength(1)
    expect(box.fleet.due()).toBe(hint)

    ipax.onRestart = () => {
      ipax.machine = machine(HERE, UP, VROLTA)
      box.conversation.oneWith = 'ipax'
    }
    await box.fleet.reload()
    expect(box.fleet.due()).toBeNull()
    for (let beat = 0; beat < 20; beat++) {
      box.fleet.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
    expect(box.said.filter((one) => one === hint)).toHaveLength(1)
    expect(box.fleet.due()).toBeNull()
  }, 60_000)

  it('is never said where it settles by itself, as a sign-in there that restarts its own orchestrator does', async () => {
    const box = await mac(['ipax'])
    const ipax = box.fars.get('ipax')!
    ipax.machine = machine(HERE, NOT_SIGNED_IN)
    await box.linked()
    ipax.machine = machine(HERE, NOT_SIGNED_IN, VROLTA)
    await box.remotes.asked()?.ask('ipax')
    box.fleet.beat()
    ipax.machine = machine(HERE, UP, VROLTA)
    box.conversation.oneWith = 'ipax'
    await box.remotes.asked()?.ask('ipax')
    for (let beat = 0; beat < 30; beat++) {
      box.fleet.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
    expect(box.said.filter((one) => one.includes('newly signed in'))).toEqual([])
    expect(box.fleet.due()).toBeNull()
  }, 60_000)
})

/** This Mac's window opened again on the same home and far ends: new links, the same machines. */
async function macAgain(home: string, fars: ReadonlyMap<string, FarEnd>) {
  const names = [...fars.keys()]
  const box = await mac([], home)
  // `mac` paired nothing: pair again with the far ends there already are, as the window's config holds.
  const remotes: Record<string, RemoteConfig> = {}
  const table = new Map<string, ScriptedRemote>()
  for (const [name, far] of fars) {
    const session = await far.pair('mac')
    remotes[name] = {
      ssh: name,
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    table.set(name, far)
  }
  const config = ConfigSchema.parse({ remotes })
  const one = new Remotes({
    home,
    remotes: () => config.remotes,
    configPath: join(home, 'config.yaml'),
    lastInputAt: () => null,
    now: () => Date.now(),
    log: async () => {},
    say: () => {},
    links: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
    here: 'this Mac',
    go: () => {},
    draw: () => {},
    carrying: {
      config: () => config,
      fold: async () => {},
      secrets: () => new Set(),
      from: () => 'mac',
      onScreenWith: async () => {},
      said: () => {},
      draw: () => {},
      lines: async () => [],
      found: async () => {},
      take: async () => {},
      conflicted: async () => {},
    },
    settingsOpen: () => false,
  }).withMachines(
    (remotes) =>
      new RemoteMachines({
        home,
        reach: (name) => remotes.reachFor(name),
        now: () => Date.now(),
        draw: () => {},
      }),
  )
  made.remotes.push(one)
  made.timers.push(setInterval(() => one.beat(), 25))
  const fleet = new FleetReload({
    home,
    names: () => names,
    reach: (name) => one.reachFor(name),
    held: (name) => one.held().find((held) => held.remote === name) ?? null,
    answer: (name) => one.asked()?.held(name) ?? null,
    ask: async (name) => await one.asked()?.ask(name),
    hub: () => 'ipax',
    oneWith: () => box.conversation.oneWith,
    here: () => ({ ...UP, joined: box.conversation.oneWith }),
    version: () => HERE,
    hereName: 'this Mac',
    onScreenWith: async () => {},
    say: (line) => box.said.push(line),
    now: () => Date.now(),
    times: { check: 20_000 },
  })
  const until = async (what: string, holds: () => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms
    while (!holds()) {
      if (Date.now() > deadline)
        throw new Error(`waited ${ms}ms for ${what}; said:\n${box.said.join('\n')}`)
      fleet.beat()
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  return { ...box, fleet, until }
}
