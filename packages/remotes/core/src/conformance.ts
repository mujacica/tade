import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { type FarEnd, startFarEnd } from './far.ts'
import { QUIET_MS } from './held.ts'
import type { Held, LinkOptions, Remote, RemoteLink } from './port.ts'

// The suite every RemoteLink must pass (R4), against far ends that are real
// away views (`far.ts`) — so what is held to it is the protocol a remote Tade
// actually speaks, through whatever the implementation carries it over.
//
// The clock is the suite's: a link is made with it, every beat is given it,
// and a stream "going quiet" is the clock moved past its deadline rather than a
// test sleeping twenty seconds. What is waited for is always a condition, with
// a ceiling — never a count over a stretch of wall clock (`CLAUDE.md`).

/** What an implementation hands the suite. */
export interface Rig {
  /** A link of this kind, made with the options the suite gives it. */
  link: RemoteLink
  /**
   * Where a far end is, in the form this link reads, and the command that is
   * Tade there — for the implementations that pair by running one.
   */
  reach(far: FarEnd): Promise<{ address: string; tade: string }>
  /** Undo whatever the rig set up. */
  close(): Promise<void>
}

export type MakeRig = (options: LinkOptions) => Promise<Rig>

/** The suite's clock: real time, plus however far a test moved it. */
interface Clock {
  now: () => number
  move(ms: number): void
}

function clock(): Clock {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    move: (ms) => {
      offset += ms
    },
  }
}

export function testRemoteLink(name: string, make: MakeRig, opts: { skip?: string } = {}): void {
  const suite = opts.skip === undefined ? describe : describe.skip
  suite(`RemoteLink conformance: ${name}${opts.skip === undefined ? '' : ` (${opts.skip})`}`, () => {
    let time: Clock
    let rig: Rig
    let link: RemoteLink
    const fars: FarEnd[] = []

    async function setUp(): Promise<void> {
      time = clock()
      rig = await make({ home: `/nonexistent/tade-conformance-${name}`, now: time.now })
      link = rig.link
    }

    afterEach(async () => {
      await link?.shutdown()
      await Promise.all(fars.map((far) => far.close()))
      await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
      fars.length = 0
      await rig?.close()
    })

    async function far(projects: readonly string[] = ['far']): Promise<FarEnd> {
      const made = await startFarEnd({ projects })
      fars.push(made)
      return made
    }

    /** Pair with a far end the way this link pairs, and the remote that makes. */
    async function paired(one: FarEnd, as = 'vps'): Promise<Remote> {
      const where = await rig.reach(one)
      const session = await link.pair({ ...where, label: 'conformance' })
      return { name: as, ...where, session }
    }

    /** Beat until it holds, and say what it held instead where it never did. */
    async function until(what: string, holds: () => boolean, ms = 20_000): Promise<void> {
      const deadline = Date.now() + ms
      while (!holds()) {
        if (Date.now() > deadline) {
          throw new Error(
            `waited ${ms}ms for ${what}; holding ${JSON.stringify(link.names().map((n) => brief(link.held(n))))}`,
          )
        }
        link.beat(time.now())
        await new Promise((done) => setTimeout(done, 25))
      }
    }

    const live = (name: string) => () =>
      link.held(name)?.link.kind === 'live' && link.held(name)?.projection !== null

    it('declares what it is, and what it needs of the machine', async () => {
      await setUp()
      expect(link.id).toBe(name)
      expect(typeof link.capabilities.pairs).toBe('boolean')
      for (const program of link.programs) {
        expect(program.command, 'a program it runs').not.toBe('')
        expect(program.title, program.command).not.toBe('')
        expect(program.why, program.command).not.toBe('')
        expect(
          program.versionArgs.length,
          `${program.command} says how to ask its version`,
        ).toBeGreaterThan(0)
      }
    })

    it('pairs with a far end, as an owner there bound to its own address', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      expect(remote.session.host).toBe(`localhost:${one.port}`)
      expect(remote.session.cookie.startsWith(`${remote.session.device}.`)).toBe(true)
      const { readDevices } = await import('@tade/web')
      const there = (await readDevices(one.home)).devices.find(
        (d) => d.id === remote.session.device,
      )
      expect(there?.owner).toBe(true)
    })

    it('holds the far end’s projection once linked, with its cursor', async () => {
      await setUp()
      const one = await far(['alpha', 'beta'])
      const remote = await paired(one)
      expect(link.held('vps')).toBeNull()
      link.open(remote)
      expect(link.held('vps')?.link.kind).toBe('idle')
      await until('the link to come up', live('vps'))
      const held = link.held('vps') as Held
      expect(held.projection?.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
      expect(held.cursor?.epoch).toBe(one.epoch)
      expect(held.heardAt).not.toBeNull()
      expect(link.names()).toEqual(['vps'])
    })

    it('takes a change there as one delta, not another snapshot', async () => {
      await setUp()
      const one = await far(['alpha'])
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      const before = link.held('vps')?.cursor
      one.show(['alpha', 'gamma'])
      await until('gamma to arrive', () =>
        (link.held('vps')?.projection?.projects ?? []).some((p) => p.name === 'gamma'),
      )
      const after = link.held('vps')?.cursor
      expect(after?.epoch).toBe(before?.epoch)
      expect(after?.rev).toBe((before?.rev ?? 0) + 1)
    })

    it('holds two remotes at once, each its own, and a change at one moves only that one', async () => {
      await setUp()
      const first = await far(['north'])
      const second = await far(['south', 'west'])
      link.open(await paired(first, 'one'))
      link.open(await paired(second, 'two'))
      await until('both links to come up', () => live('one')() && live('two')())
      expect(link.names()).toEqual(['one', 'two'])
      expect(link.held('one')?.projection?.projects.map((p) => p.name)).toEqual(['north'])
      expect(link.held('two')?.projection?.projects.map((p) => p.name)).toEqual(['south', 'west'])
      expect(link.held('one')?.cursor?.epoch).toBe(first.epoch)
      expect(link.held('two')?.cursor?.epoch).toBe(second.epoch)
      const still = link.held('two')?.cursor
      first.show(['north', 'east'])
      await until('east to reach the first', () =>
        (link.held('one')?.projection?.projects ?? []).some((p) => p.name === 'east'),
      )
      expect(link.held('two')?.cursor).toEqual(still)
      expect(link.held('two')?.projection?.projects.map((p) => p.name)).toEqual(['south', 'west'])
    })

    it('reads a far end that restarted from a snapshot, by its new epoch', async () => {
      await setUp()
      const one = await far(['alpha'])
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      const was = one.epoch
      await one.restart()
      expect(one.epoch).not.toBe(was)
      await until(
        'the new epoch',
        () => link.held('vps')?.cursor?.epoch === one.epoch && live('vps')(),
      )
    })

    it('keeps what it held while the far end does not answer, and links again when it does', async () => {
      await setUp()
      const one = await far(['alpha'])
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      await one.close()
      await until('the link to go down', () => link.held('vps')?.link.kind === 'down')
      const down = link.held('vps') as Held
      // Never an empty world: what it last said, and when it was last heard.
      expect(down.projection?.projects.map((p) => p.name)).toEqual(['alpha'])
      expect(down.heardAt).not.toBeNull()
      if (down.link.kind === 'down') expect(down.link.said).not.toBe('')
      await one.reopen()
      await until('the link to come back', live('vps'))
    })

    it('stops for good when the far end signs it out, and dials it no more', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      link.open(remote)
      await until('the link to come up', live('vps'))
      await one.revoke(remote.session.device)
      await until('the link to end', () => link.held('vps')?.link.kind === 'ended')
      for (let beat = 0; beat < 5; beat++) {
        time.move(60_000)
        link.beat(time.now())
        await new Promise((done) => setTimeout(done, 20))
      }
      expect(link.held('vps')?.link.kind).toBe('ended')
      await until('nothing streaming there', () => one.streams === 0)
    })

    it('ends a session the far end never knew, rather than dialling it for ever', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      const unknown = { ...remote.session, cookie: `${remote.session.device}.${'x'.repeat(43)}` }
      link.open({ ...remote, session: unknown })
      await until('the link to end', () => link.held('vps')?.link.kind === 'ended')
    })

    it('carries the person’s presence there, as an age in the far end’s own clock', async () => {
      await setUp()
      const one = await far()
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      const pressed = time.now() - 1_000
      link.present(pressed)
      await until('the far end to hear it', () => one.presentAt !== null)
      // An age, so the far end's moment is its own clock's: a second ago there,
      // within what carrying it took.
      const at = one.presentAt as number
      expect(Date.now() - at).toBeGreaterThanOrEqual(900)
      expect(Date.now() - at).toBeLessThan(10_000)
      expect(link.held('vps')?.presence).toBeNull()
    })

    it('gives up on a stream gone quiet past its deadline, and dials again', async () => {
      await setUp()
      const one = await far()
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      time.move(QUIET_MS + 1_000)
      link.beat(time.now())
      const quiet = link.held('vps') as Held
      expect(quiet.link.kind).toBe('down')
      if (quiet.link.kind === 'down') expect(quiet.link.problem).toBe('timed out')
      expect(quiet.projection).not.toBeNull()
      await until('the link to come back', live('vps'))
    })

    it('lets go on a wake and links again at once, holding what it had meanwhile', async () => {
      await setUp()
      const one = await far(['alpha'])
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      const was = link.held('vps')?.link
      const since = was?.kind === 'live' ? was.since : 0
      time.move(5_000)
      link.wake(time.now())
      expect(link.held('vps')?.projection?.projects.map((p) => p.name)).toEqual(['alpha'])
      await until('a new stream', () => {
        const held = link.held('vps')
        return held?.link.kind === 'live' && held.link.since > since
      })
    })

    it('closes one, holding nothing for it and leaving no stream there', async () => {
      await setUp()
      const one = await far()
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      await link.close('vps')
      await link.close('vps')
      expect(link.held('vps')).toBeNull()
      expect(link.names()).toEqual([])
      await until('nothing streaming there', () => one.streams === 0)
    })

    it('tells a watcher when what it holds changed, and stops when asked', async () => {
      await setUp()
      const one = await far()
      const told: string[] = []
      const stop = link.watch((name) => told.push(name))
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      expect(told).toContain('vps')
      stop()
      const count = told.length
      await link.close('vps')
      expect(told.length).toBe(count)
    })

    it('signs this machine out there when it unpairs', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      if (!link.capabilities.pairs) return
      await link.unpair(remote)
      const { readDevices } = await import('@tade/web')
      const there = (await readDevices(one.home)).devices.find(
        (d) => d.id === remote.session.device,
      )
      expect(there?.revoked).not.toBeNull()
    })
  })
}

/** What a held value is, in a line a failure can print: never the projection. */
function brief(held: Held | null): unknown {
  if (held === null) return null
  return {
    remote: held.remote,
    link: held.link,
    cursor: held.cursor,
    projected: held.projection !== null,
  }
}
