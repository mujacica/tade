import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink } from '@tade/remotes-scripted'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Machines } from '../../src/machines.ts'
import { remoteActions } from '../../src/panels/settings/remotes.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { withoutCredential } from '../../src/wire/hand-over.ts'
import { Moves } from '../../src/wire/moves.ts'

// A whole project moved to another machine (REMOTE-TADE.md §9.2: closing it
// on one machine and opening it on the other) as one guided flow on Settings ›
// Remotes: each project with the one press that is next — open it there, hand
// its work over, close it here — each refused with a sentence out of order.
// Real git, a real far end over the scripted link, a real workbench; the
// agents and the window's close door are stood in for.

const opened: { client: Workbench; link: RemoteLink; far: FarEnd }[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.link.shutdown().catch(() => {})
    await one.far.close().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

async function moving() {
  const repo = mkrepo({ remote: true })
  const home = tmp('tade-move-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  const client = await Workbench.open({ home })
  const far = await startFarEnd({ projects: ['tade'] })
  const link = makeScriptedLink({ home, remotes: new Map([['vps', far]]) })
  opened.push({ client, link, far })
  const session = await far.pair('mac')
  const remote: Remote = { name: 'vps', address: 'vps', tade: 'tade', session }
  link.open(remote)
  for (let i = 0; i < 200 && link.held('vps')?.link.kind !== 'live'; i++) {
    link.beat(Date.now())
    await new Promise((done) => setTimeout(done, 25))
  }
  const running = new Set<string>()
  const steered: string[] = []
  const agent = {
    runs: () => [...running].map((task) => ({ run: `${task}-run`, task, harness: 'pi' })),
    turnOf: () => 'idle' as const,
    steerAgent: async (task: string) => {
      steered.push(task)
    },
  }
  const wrapped = new Proxy(client, {
    get: (target, key, receiver) =>
      key in agent ? agent[key as keyof typeof agent] : Reflect.get(target, key, receiver),
  })
  const told: { saved: string | null; error: string | null }[] = []
  const there: { machine: string; project: string }[] = []
  const wire = {
    now: () => Date.now(),
    live: { queued: [], refresh: async () => {} },
    opts: {
      home,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      client: wrapped,
    },
    put: () => {},
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  const moves = new Moves(wire, {
    reach: (name) => (name === 'vps' ? { link, remote, live: true } : null),
    machines: () => ({ remotes: [{ name: 'vps' }] }) as unknown as Machines,
    sameAs: (project) => (project === 'app' ? there : []),
    say: () => {},
    told: (saved, error) => told.push({ saved, error }),
  })
  const closed: string[] = []
  const door = {
    closeProject: async (name: string, by: string) => {
      closed.push(`${name} by ${by}`)
      return `Closed ${name}.`
    },
  }
  return { repo, client, far, moves, running, steered, told, there, closed, door }
}

describe('moving a whole project to another machine', () => {
  it('opens it there first, handing over the URL with no credential in it', async () => {
    const one = await moving()
    expect(one.moves.projects.projectMoves('vps')).toEqual([
      { project: 'app', said: 'not on vps yet', next: 'open' },
    ])
    // Its origin is a path on this machine, which no other machine clones from.
    await one.moves.projects.step('remote:move-open:vps:app', one.door)
    expect(one.told.at(-1)?.error).toContain('has no origin another machine could clone it from')
    expect(one.far.opened).toEqual([])

    one.repo.git('remote', 'set-url', 'origin', 'https://me:ghp_secret@github.com/acme/app.git')
    await one.moves.projects.step('remote:move-open:vps:app', one.door)
    expect(one.told.at(-1)?.error).toBeNull()
    expect(one.told.at(-1)?.saved).toContain('app is open on vps as app')
    expect(one.far.opened.map((open) => open.open)).toEqual([
      {
        from: expect.any(String),
        name: 'app',
        repository: 'github.com/acme/app',
        clone: 'https://github.com/acme/app.git',
      },
    ])
  }, 60_000)

  it('hands its work over once it is there, and only then offers to close it here', async () => {
    const one = await moving()
    one.there.push({ machine: 'vps', project: 'tade' })
    await one.client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: 'refunds',
      workspace: 'worktree',
    })
    one.running.add('app/refunds')
    expect(one.moves.projects.projectMoves('vps')).toEqual([
      { project: 'app', said: 'on vps as tade · 1 running here', next: 'hand' },
    ])
    // Closing is refused out of order, whatever was pressed.
    await one.moves.projects.step('remote:move-close:vps:app', one.door)
    expect(one.told.at(-1)?.error).toContain('app/refunds still runs here: hand it over first')
    expect(one.closed).toEqual([])

    await one.moves.projects.step('remote:move-hand:vps:app', one.door)
    expect(one.told.at(-1)?.saved).toContain('app/refunds told to push')
    expect(one.steered).toEqual(['app/refunds'])
    expect(one.moves.projects.projectMoves('vps')[0]).toMatchObject({ next: null })

    // Its agent gone from here: the last press closes it, asked twice on the page.
    one.running.clear()
    const page = remoteActions([
      {
        name: 'vps',
        address: 'vps',
        link: '● linked',
        live: true,
        list: null,
        at: null,
        busy: false,
        machine: null,
        moves: [{ project: 'app', said: 'on vps as tade', next: 'close' }],
      },
    ])
    expect(page.find((action) => action.id === 'remote:move-close:vps:app')).toMatchObject({
      label: 'Close it here…',
      again: 'Press again to close it here',
    })
    await one.moves.projects.step('remote:move-close:vps:app', one.door)
    expect(one.closed).toEqual(['app by window'])
    expect(one.told.at(-1)?.saved).toBe('Closed app.')
  }, 60_000)

  it('never closes here what is not open there', async () => {
    const one = await moving()
    await one.moves.projects.step('remote:move-close:vps:app', one.door)
    expect(one.told.at(-1)?.error).toContain('is not open on vps yet')
    expect(one.closed).toEqual([])
  }, 60_000)

  it('takes a token out of an https origin and leaves an ssh user', () => {
    expect(withoutCredential('https://me:tok@github.com/acme/app.git')).toBe(
      'https://github.com/acme/app.git',
    )
    expect(withoutCredential('ssh://git:pw@github.com/acme/app.git')).toBe(
      'ssh://git@github.com/acme/app.git',
    )
    expect(withoutCredential('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git')
  })
})
