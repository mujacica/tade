import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink } from '@tade/remotes-scripted'
import { Workbench } from '@tade/workbench'
import { readTaskFile } from '@tade/workbench/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Machines } from '../../src/machines.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { HAND_MS, Moves } from '../../src/wire/moves.ts'

// A running task handed to another machine (REMOTE-TADE.md §9.2): asked there
// first, its agent told to commit and push, looked at on the beat until its
// work is on origin and it has finished a turn, then made there on that branch
// and stopped here. Real git with a real origin, a real far end over the
// scripted link, a real workbench — and the agent itself stood in for: told
// what it is told, and committing and pushing as one would.

const opened: { client: Workbench; link: RemoteLink; far: FarEnd }[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.link.shutdown().catch(() => {})
    await one.far.close().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

/** This machine's project `app`, a worktree task in it, and `vps` holding the same repository as `tade`. */
async function handing(over: { workspace?: 'checkout' | 'worktree' } = {}) {
  const repo = mkrepo({ remote: true })
  const home = tmp('tade-hand-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  const client = await Workbench.open({ home })
  const far = await startFarEnd({ projects: ['tade'] })
  const link = makeScriptedLink({ home, remotes: new Map([['vps', far]]) })
  opened.push({ client, link, far })
  const session = await far.pair('mac')
  const remote: Remote = { name: 'vps', address: 'vps', tade: 'tade', session }
  link.open(remote)
  link.beat(Date.now())
  for (let i = 0; i < 200 && link.held('vps')?.link.kind !== 'live'; i++) {
    await new Promise((done) => setTimeout(done, 25))
    link.beat(Date.now())
  }
  expect(link.held('vps')?.link.kind).toBe('live')
  const made = await client.createTask({
    project: 'app',
    slug: 'refunds',
    intent: 'refunds double-charge on retries',
    context: 'It happens only when the card network times out.',
    workspace: over.workspace ?? 'worktree',
  })
  // The agent, as far as this needs one: running, between turns, and told things.
  const told: string[] = []
  const stopped: string[] = []
  let turn: 'running' | 'idle' = 'idle'
  let running = true
  const said: string[] = []
  let now = Date.now()
  const agent = {
    runs: () => (running ? [{ run: 'run-1', task: 'app/refunds', harness: 'pi' }] : []),
    turnOf: () => turn,
    steerAgent: async (_task: string, message: string) => {
      told.push(message)
    },
    stopAgent: async (task: string) => {
      stopped.push(task)
      running = false
    },
  }
  const wrapped = new Proxy(client, {
    get: (target, key, receiver) =>
      key in agent ? agent[key as keyof typeof agent] : Reflect.get(target, key, receiver),
  })
  const wire = {
    now: () => now,
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
    sameAs: (project) => (project === 'app' ? [{ machine: 'vps', project: 'tade' }] : []),
    say: (one) => said.push(one),
  })
  /**
   * The window's beat, waited on until its look has finished: still there and
   * not looking, or let go of — which every way out says something on.
   */
  const beat = async () => {
    const before = said.length
    now += 6_000
    moves.beat()
    const held = (moves as unknown as { handing: Map<string, { looking: boolean }> }).handing
    for (let i = 0; i < 1_000; i++) {
      const one = held.get('app/refunds')
      if (one ? !one.looking : said.length > before) break
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  const finishTurn = async () => {
    await client.log.append({ type: 'turn_done', task: 'app/refunds', detail: {} })
  }
  return {
    repo,
    home,
    client,
    far,
    moves,
    made,
    told,
    stopped,
    said,
    beat,
    finishTurn,
    setTurn: (to: 'running' | 'idle') => {
      turn = to
    },
    later: (ms: number) => {
      now += ms
    },
  }
}

function commitIn(dir: string, name: string): string {
  writeFileSync(join(dir, name), `${name}\n`)
  runGit(dir, 'add', name)
  runGit(
    dir,
    '-c',
    'user.name=Agent',
    '-c',
    'user.email=a@example.invalid',
    'commit',
    '-q',
    '-m',
    `${name}\n\nTade-Task: app/refunds`,
  )
  return runGit(dir, 'rev-parse', 'HEAD').trim()
}

describe('a running task, handed to another machine', () => {
  it('tells its agent to commit and push, and hands it over once its work is on origin', async () => {
    const one = await handing()
    // Offered on vps's menu along the top, as an agent running here.
    expect(one.moves.menuItems('vps')).toEqual([
      { id: 'hand:app/refunds', label: 'Hand app/refunds to vps', divider: true },
    ])
    expect(one.moves.menuItems('other')).toEqual([])
    const said = await one.moves.handOver('app/refunds', 'vps', 'you')
    expect(said).toContain('its conversation does not move')
    expect(one.moves.menuItems('vps')[0]?.off).toBe('being handed over')
    // Asked there first, making nothing.
    expect(one.far.taken.map((take) => take.take.check)).toEqual([true])
    expect(one.told).toHaveLength(1)
    expect(one.told[0]).toContain('git push origin HEAD:refs/heads/tade/refunds')
    expect(one.told[0]).toContain('Your conversation does not move with it.')

    // Still in its turn: nothing happens.
    one.setTurn('running')
    await one.beat()
    expect(one.far.taken).toHaveLength(1)

    // Its turn over, nothing pushed yet: it waits.
    one.setTurn('idle')
    await one.finishTurn()
    await one.beat()
    expect(one.far.taken).toHaveLength(1)

    // It commits and pushes, as it was told.
    const head = commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.beat()

    expect(one.far.taken).toHaveLength(2)
    const take = one.far.taken[1]?.take
    expect(take).toMatchObject({
      project: 'tade',
      name: 'refunds',
      was: 'app/refunds',
      intent: 'refunds double-charge on retries',
      begins: { branch: 'tade/refunds', head },
      check: false,
    })
    expect(take?.context).toContain('It happens only when the card network times out.')
    expect(take?.context).toContain('## Handed over')
    expect(take?.prompt).toContain('Its conversation did not come with it')
    // The last of it is written after the look let go of it: waited on, not slept on.
    for (let i = 0; i < 400; i++) {
      if (one.said.length > 0) break
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(one.stopped).toEqual(['app/refunds'])
    expect((await readTaskFile(one.home, 'app/refunds'))?.parked).toBe(true)
    const [moved] = await one.client.log.read({ types: ['task_moved'] })
    expect(moved?.detail).toEqual({
      to: 'vps',
      as: 'tade/refunds',
      how: 'running',
      branch: 'tade/refunds',
      head,
      by: 'you',
    })
    expect(one.said.at(-1)).toContain('its conversation stays here')
  }, 60_000)

  it('waits while its worktree has work it has not committed, though origin has the branch', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    commitIn(one.made.worktree, 'half.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    writeFileSync(join(one.made.worktree, 'more.txt'), 'not committed\n')
    await one.finishTurn()
    await one.beat()
    expect(one.far.taken).toHaveLength(1)
    expect(one.stopped).toEqual([])
  }, 60_000)

  it('in a shared checkout, waits until every commit of its own is on the branch', async () => {
    const one = await handing({ workspace: 'checkout' })
    await one.moves.handOver('app/refunds', 'vps', 'you')
    commitIn(one.repo.root, 'first.txt')
    runGit(one.repo.root, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    // Another of its commits after the push: not all of its work is there yet.
    commitIn(one.repo.root, 'second.txt')
    await one.finishTurn()
    await one.beat()
    expect(one.far.taken).toHaveLength(1)
    const head = runGit(one.repo.root, 'rev-parse', 'HEAD').trim()
    runGit(one.repo.root, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.beat()
    expect(one.far.taken[1]?.take.begins).toEqual({ branch: 'tade/refunds', head })
    for (let i = 0; i < 400 && one.said.length === 0; i++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(one.stopped).toEqual(['app/refunds'])
  }, 60_000)

  it('gives up after its time with what was missing said, and changes nothing', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    one.later(HAND_MS)
    await one.beat()
    expect(one.said.at(-1)).toContain('nothing was started on vps, and it goes on here')
    expect(one.far.taken).toHaveLength(1)
    expect(one.stopped).toEqual([])
    expect((await readTaskFile(one.home, 'app/refunds'))?.parked).toBe(false)
  }, 60_000)

  it('tells the agent nothing where the machine there would not take it', async () => {
    const one = await handing()
    one.far.taking = () => ({ took: false, said: 'tade/refunds was used before here' })
    await expect(one.moves.handOver('app/refunds', 'vps', 'you')).rejects.toThrow(
      'vps would not take app/refunds: tade/refunds was used before here',
    )
    expect(one.told).toEqual([])
  }, 60_000)
})
