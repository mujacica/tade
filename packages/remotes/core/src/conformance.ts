import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CONNECT_TITLES, runProgram } from '@tade/core'
import type { WebConnecting } from '@tade/web'
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

    it('carries a setup there as an owner, with no link held, through its one write path', async () => {
      await setUp()
      const one = await far()
      one.signIns = [
        { harness: 'claude-code', account: null, signedIn: true, until: null, problem: null },
      ]
      const remote = await paired(one)
      const answer = await link.call(remote, '/api/carry', {
        from: 'conformance',
        complete: false,
        settings: [{ path: 'agents.commit', value: 'as-you-go' }],
      })
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({
        machine: 'far',
        settings: [{ path: 'agents.commit', outcome: 'written' }],
        signIns: one.signIns,
      })
      expect(link.names()).toEqual([])
      const { loadConfig } = await import('@tade/core')
      const there = await loadConfig(`${one.home}/config.yaml`)
      expect(there.ok && there.config.agents.commit).toBe('as-you-go')
      expect(one.lines.at(-1)?.detail).toMatchObject({
        path: 'agents.commit',
        carried: 'conformance',
      })
    })

    it('calls as the session it was given, so one the far end signed out is refused there', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      await one.revoke(remote.session.device)
      const answer = await link.call(remote, '/api/carry', {
        from: 'conformance',
        complete: false,
        settings: [],
      })
      expect(answer.status).toBe(401)
    })

    it('says a far end that is not answering is not, rather than answering for it', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      await one.close()
      await expect(link.call(remote, '/api/carry', {})).rejects.toMatchObject({
        name: 'LinkError',
      })
    })

    it('serves the far end’s own connect pages here, and nothing else of it, until they are closed', async () => {
      await setUp()
      const one = await far()
      const kept: unknown[] = []
      one.connecting = slackToKeep(kept)
      const remote = await paired(one)
      const pages = await link.pages(remote)
      const here = new URL(pages.url).origin
      try {
        expect(pages.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect$/)
        // The far end's own page, as a browser here gets it, with no link held.
        const page = await fetch(pages.url)
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('Signing Secret')
        expect(link.names()).toEqual([])
        // What Slack's own page showed the person, pasted there and kept there.
        const secret = 'a1B2c3D4e5F6g7H8i9J0k1L2'
        const keep = await fetch(`${here}/connect/slack/keep`, {
          method: 'POST',
          headers: { origin: here, 'content-type': 'application/json' },
          body: JSON.stringify({ signing_secret: secret }),
        })
        expect(keep.status).toBe(200)
        expect(kept).toEqual([{ signing_secret: secret }])
        // Nothing of its away view but those pages.
        expect((await fetch(`${here}/api/snapshot`)).status).toBe(404)
      } finally {
        await pages.close()
      }
      await expect(fetch(pages.url)).rejects.toThrow()
      await pages.close()
    })

    it('asks over the link it holds while it is live, and asks nothing while it is not', async () => {
      await setUp()
      const one = await far(['alpha'])
      link.open(await paired(one))
      await until('the link to come up', live('vps'))
      // A read is a read: no token, and the far end's own answer.
      const read = await link.request('vps', '/api/agent/alpha/fix-it')
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ task: 'alpha/fix-it', here: false })
      one.attachable.set('alpha/fix-it', 'echo attached')
      expect(await link.request('vps', '/api/attach', { task: 'alpha/fix-it' })).toEqual({
        status: 200,
        body: { command: 'echo attached' },
      })
      await one.close()
      await until('the link to go down', () => link.held('vps')?.link.kind === 'down')
      // Down is asked nothing: it is said, as the link already says it.
      await expect(
        link.request('vps', '/api/attach', { task: 'alpha/fix-it' }),
      ).rejects.toMatchObject({ name: 'LinkError' })
      await expect(link.request('nowhere', '/api/snapshot')).rejects.toMatchObject({
        name: 'LinkError',
      })
    })

    it('opens a terminal there running the far end’s own line, only where it says it can', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      const opened = await link.attach(remote, "echo 'attached here'")
      if (!link.capabilities.terminals) {
        expect(opened).toBeNull()
        return
      }
      expect(opened?.by).not.toBe('')
      // Run, not read: a line that looks right and does not run is found out
      // the moment somebody presses enter on an agent.
      const ran = await runProgram(opened?.command ?? '', opened?.args ?? [], { timeoutMs: 20_000 })
      expect(ran.stdout, ran.stderr).toContain('attached here')
      // A line is one line a shell reads as written, or it is not handed over.
      await expect(link.attach(remote, 'echo one\necho two')).rejects.toMatchObject({
        name: 'LinkError',
      })
    })

    it('is told what came of a terminal, and answers another way where one did not get through', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      const opened = await link.attach(remote, "echo 'attached here'")
      if (opened === null) return
      const by = opened.by ?? ''
      // Through is nothing to remember, and saying so never throws.
      await link.attached(remote, by, true)
      expect((await link.attach(remote, "echo 'attached here'"))?.by).toBe(opened.by)
      // A way that has to prove itself and did not is not the way answered
      // next, until a try of it works: otherwise the window waits on it again.
      if (opened.proving === undefined) return
      await link.attached(remote, by, false)
      expect((await link.attach(remote, "echo 'attached here'"))?.by).not.toBe(opened.by)
      await link.attached(remote, by, true)
      expect((await link.attach(remote, "echo 'attached here'"))?.by).toBe(opened.by)
    })

    it('hands git a way to a repository there only where it says it can, and refuses a root it would not fetch', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      const made = await repositoryIn(one.home)
      const there = link.repository(remote, made.root)
      if (!link.capabilities.fetches) {
        expect(there).toBeNull()
        return
      }
      // Run, not read: git here, as the mirror runs it, listing the branch there.
      const listed = await runProgram('git', ['ls-remote', there?.url ?? '', 'refs/heads/main'], {
        timeoutMs: 20_000,
        env: { ...process.env, ...there?.env },
      })
      expect(listed.stdout, listed.stderr).toContain(`${made.head}\trefs/heads/main`)
      // A root is an absolute path git and a shell there read as one path, or it is refused.
      for (const root of ['relative/path', "/tmp/it's here", '/tmp/a b', '/tmp/../etc']) {
        expect(() => link.repository(remote, root), root).toThrow(/not a path this machine fetches/)
      }
    })

    it('offers a terminal there only where it says it can', async () => {
      await setUp()
      const one = await far()
      const remote = await paired(one)
      const opened = link.terminal(remote, ['accounts', 'sign-in', 'claude-code'])
      if (!link.capabilities.terminals) {
        expect(opened).toBeNull()
        return
      }
      expect(opened?.command).not.toBe('')
      expect(opened?.args.join(' ')).toContain('accounts sign-in claude-code')
    })
  })
}

/** A repository with one commit on `main`, in the far end's home: what a project there is. */
async function repositoryIn(home: string): Promise<{ root: string; head: string }> {
  const root = join(home, 'checkout')
  const git = (args: readonly string[]) =>
    runProgram('git', ['-C', root, ...args], { timeoutMs: 20_000 })
  await mkdir(root, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await git([
    '-c',
    'user.name=far',
    '-c',
    'user.email=far@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one',
  ])
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  return { root, head }
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

/**
 * What a far end's window knows of connecting a source: Slack with its signing
 * secret to keep, written into `kept` as it is kept, and nothing else made.
 */
function slackToKeep(kept: unknown[]): WebConnecting {
  return {
    page: async (source) => ({
      page: {
        source,
        title: CONNECT_TITLES[source],
        steps:
          source === 'slack'
            ? [
                {
                  id: 'keep',
                  title: 'Give this machine its signing secret',
                  done: false,
                  said: 'from the app’s Basic Information',
                  press: {
                    act: 'keep',
                    label: 'Keep it',
                    fields: [{ name: 'signing_secret', label: 'Signing Secret', secret: true }],
                  },
                },
              ]
            : [],
        writes: 'It writes nothing.',
      },
      asks: [],
      events: [],
    }),
    form: () => ({ url: 'https://example.com/nothing-is-made' }),
    installUrl: () => null,
    made: async () => ({ problem: 'nothing is made here' }),
    installed: async () => ({ problem: 'nothing is installed here' }),
    keep: async (_source, fields) => {
      kept.push(fields)
      return { kept: ['the signing secret'] }
    },
  }
}
