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

/**
 * This machine's project `app`, a worktree task in it, and `vps` holding the
 * same repository as `tade` — `older`, a Tade there from before a hand-over
 * had an id, whose strict reading refuses one as a request that made no sense.
 */
async function handing(over: { workspace?: 'checkout' | 'worktree'; older?: boolean } = {}) {
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
  /** Tade closing while the agent is being stopped: the stop never comes back. */
  let stopHangs = false
  /** Stops asked while they hang: the window that closed has got as far as stopping. */
  const hung: string[] = []
  const said: string[] = []
  let now = Date.now()
  const agent = {
    runs: () => (running ? [{ run: 'run-1', task: 'app/refunds', harness: 'pi' }] : []),
    turnOf: () => turn,
    steerAgent: async (_task: string, message: string) => {
      told.push(message)
    },
    stopAgent: async (task: string) => {
      if (stopHangs) {
        hung.push(task)
        return new Promise<void>(() => {})
      }
      stopped.push(task)
      running = false
    },
  }
  const reaching: RemoteLink = over.older
    ? new Proxy(link, {
        get: (target, key, receiver) =>
          key === 'call'
            ? async (to: Remote, path: string, body: unknown) =>
                typeof body === 'object' && body !== null && 'handOver' in body
                  ? {
                      status: 400,
                      body: { error: 'malformed', said: 'that request did not make sense' },
                    }
                  : target.call(to, path, body)
            : Reflect.get(target, key, receiver),
      })
    : link
  let live = true
  /** A window's moves over a workbench: the first, or one opened again on the same home. */
  const windowOver = (over: Workbench): Moves => {
    const wrapped = new Proxy(over, {
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
    return new Moves(wire, {
      reach: (name) => (name === 'vps' ? { link: reaching, remote, live } : null),
      machines: () => ({ remotes: [{ name: 'vps' }] }) as unknown as Machines,
      sameAs: (project) => (project === 'app' ? [{ machine: 'vps', project: 'tade' }] : []),
      say: (one) => said.push(one),
      told: (saved, error) => said.push(error ?? saved ?? ''),
    })
  }
  const one = {
    repo,
    home,
    client,
    far,
    moves: windowOver(client),
    made,
    told,
    stopped,
    hung,
    said,
    /**
     * The window's beat, waited on until its look has finished: still there
     * and not looking, or let go of — which every way out says something on.
     * `slept` is the machine having been away that long before it.
     */
    beat: async (slept: number | null = null) => {
      const before = said.length
      const moves = one.moves as unknown as {
        handing: Map<string, { looking: boolean }>
        resume(): Promise<void>
      }
      const had = moves.handing.has('app/refunds')
      now += 6_000 + (slept ?? 0)
      one.moves.beat(slept)
      // What an earlier window left open is picked up first, on this beat.
      await moves.resume()
      for (let i = 0; i < 1_000; i++) {
        const handing = moves.handing.get('app/refunds')
        if (handing ? !handing.looking : !had || said.length > before) break
        await new Promise((done) => setTimeout(done, 10))
      }
    },
    finishTurn: async () => {
      await one.client.log.append({ type: 'turn_done', task: 'app/refunds', detail: {} })
    },
    setTurn: (to: 'running' | 'idle') => {
      turn = to
    },
    later: (ms: number) => {
      now += ms
    },
    setLive: (to: boolean) => {
      live = to
    },
    holdStop: (to: boolean) => {
      stopHangs = to
    },
    /** What the window opening a lane writes, as `lane_opened` or `lane_adopted` (`registry.ts`). */
    laneLine: async (type: 'lane_opened' | 'lane_adopted') => {
      await one.client.log.append({
        type,
        lane: 'app/refunds/agent',
        task: 'app/refunds',
        detail: {},
      })
    },
    /**
     * Tade closed and opened again on the same home: the journal is all that
     * is kept, and the agent goes on as it was.
     */
    reopen: async () => {
      await one.client.close()
      const again = await Workbench.open({ home })
      const kept = opened.find((held) => held.client === one.client)
      if (kept) kept.client = again
      one.client = again
      one.moves = windowOver(again)
    },
  }
  return one
}

/**
 * vps answering as its window does (`web-take.ts`): a name made once, and the
 * same hand-over asked again known by its id — where it was given one.
 */
function remembers(far: FarEnd): void {
  const made = new Map<string, string | undefined>()
  far.taking = (take) => {
    const task = `${take.project}/${take.name}`
    if (made.has(task)) {
      return take.handOver !== undefined && made.get(task) === take.handOver
        ? { took: true, task, said: `${task} was taken here already.`, pushes: null, already: true }
        : { took: false, said: `${task} was used before here, and a name is never used twice` }
    }
    if (!take.check) made.set(task, take.handOver)
    return { took: true, task, said: `${task} is queued`, pushes: null }
  }
}

/** Waited on, not slept on: until it holds, or four seconds. */
async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !holds(); i++) await new Promise((done) => setTimeout(done, 10))
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
    // And on its own menu, where a person looks before closing the lid.
    expect(one.moves.handItems('app/refunds')).toEqual([{ id: 'hand:vps', label: 'Hand to vps' }])
    const said = await one.moves.handOver('app/refunds', 'vps', 'you')
    expect(said).toContain('its conversation does not move')
    expect(said).toContain('Closing the lid or Tade before then is fine')
    expect(one.moves.menuItems('vps')[0]?.off).toBe('being handed over')
    expect(one.moves.handItems('app/refunds')[0]?.off).toBe('being handed over')
    // Written down, so a window opened after this one closes can finish it.
    const [asked] = await one.client.log.read({ types: ['task_handing'] })
    expect(asked).toMatchObject({
      task: 'app/refunds',
      detail: { to: 'vps', there: 'tade', branch: 'tade/refunds', by: 'you' },
    })
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
    expect(one.moves.handItems('app/refunds')[0]?.off).toBe('not running')
  }, 60_000)

  it('is finished by the next window when Tade closed before the push landed', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    await one.reopen()
    // While nothing looked, the agent did as it was told.
    const head = commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.finishTurn()
    // The first beat picks it up from the journal and says so.
    await one.beat()
    expect(one.said.at(-1)).toContain(
      'app/refunds was being handed to vps when Tade last closed, so I am looking again',
    )
    expect(one.moves.menuItems('vps')[0]?.off).toBe('being handed over')
    await one.beat()
    for (let i = 0; i < 400 && one.stopped.length === 0; i++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(one.far.taken.map((take) => take.take.check)).toEqual([true, false])
    expect(one.far.taken[1]?.take.begins).toEqual({ branch: 'tade/refunds', head })
    expect(one.stopped).toEqual(['app/refunds'])
    const [moved] = await one.client.log.read({ types: ['task_moved'] })
    expect(moved?.detail).toMatchObject({ to: 'vps', how: 'running', head, by: 'you' })
    // Finished, it is not picked up again by the window after.
    await one.reopen()
    await one.beat()
    expect(one.said.at(-1)).toContain('its conversation stays here')
    expect(one.moves.handItems('app/refunds')[0]?.off).toBe('not running')
  }, 60_000)

  it('does not count a sleep with the window open against its time', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    // The lid closed for longer than it has, and opened again.
    await one.beat(HAND_MS * 4)
    expect(one.said).toEqual([])
    expect(one.moves.menuItems('vps')[0]?.off).toBe('being handed over')
    commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.finishTurn()
    await one.beat()
    for (let i = 0; i < 400 && one.said.length === 0; i++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(one.stopped).toEqual(['app/refunds'])
    expect(one.said.at(-1)).toContain('went to vps as tade/refunds')
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
    // Let go of is written down, so the next window does not take it up again.
    const lines = await one.client.log.read({ types: ['task_handing'] })
    expect(lines.at(-1)?.detail).toEqual({ to: 'vps', ended: one.said.at(-1) })
    const before = one.said.length
    await one.reopen()
    await one.beat()
    expect(one.said).toHaveLength(before)
    expect(one.moves.handItems('app/refunds')[0]?.off).toBeUndefined()
  }, 60_000)

  it('is counted from when a window opened again picked it up, and let go of there with why', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    // Closed for longer than it has: the window that opens has its own time.
    one.later(HAND_MS * 3)
    await one.reopen()
    await one.beat()
    expect(one.said.at(-1)).toContain('when Tade last closed, so I am looking again')
    one.later(HAND_MS)
    await one.beat()
    expect(one.said.at(-1)).toContain('nothing was started on vps, and it goes on here')
    expect(one.far.taken).toHaveLength(1)
    expect(one.stopped).toEqual([])
  }, 60_000)

  it('tells an agent opened again part way through it, once, to finish what it was asked', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    // In its turn when Tade closed: its lane died with the window, as a pty's
    // does, and the next window opened it again where it left off, saying
    // nothing — so no turn of it ends, and nothing it was asked is done.
    one.setTurn('running')
    await one.reopen()
    await one.laneLine('lane_opened')
    one.setTurn('idle')
    await one.beat()
    expect(one.said.at(-1)).toContain('when Tade last closed, so I am looking again')
    await one.beat()
    expect(one.told).toHaveLength(2)
    expect(one.told[1]).toContain('Tade closed before you had finished what you were asked here')
    expect(one.told[1]).toContain('git push origin HEAD:refs/heads/tade/refunds')
    expect(one.said.at(-1)).toContain('so I told it again to commit and push')
    // Once: idle on the next look too, it is not told a third time.
    await one.beat()
    expect(one.told).toHaveLength(2)
    // It finishes its push, and is handed over.
    const head = commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.finishTurn()
    await one.beat()
    await until(() => one.stopped.length > 0)
    expect(one.far.taken[1]?.take.begins).toEqual({ branch: 'tade/refunds', head })
    expect(one.stopped).toEqual(['app/refunds'])
    expect(one.said.at(-1)).toContain('went to vps as tade/refunds')
  }, 60_000)

  it('tells an agent that went on running while Tade was closed nothing more', async () => {
    const one = await handing()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    await one.reopen()
    // Taken up again rather than opened, as tmux's are: it was never cut off.
    await one.laneLine('lane_adopted')
    await one.beat()
    await one.beat()
    await one.beat()
    expect(one.told).toHaveLength(1)
    expect(one.said.join('\n')).not.toContain('told it again')
  }, 60_000)

  it('is finished on the next look by a push made while Tade was closed, though no turn of it was heard to end', async () => {
    const one = await handing()
    const told = runGit(one.made.worktree, 'rev-parse', 'HEAD').trim()
    await one.moves.handOver('app/refunds', 'vps', 'you')
    const [asked] = await one.client.log.read({ types: ['task_handing'] })
    expect(asked?.detail.head).toBe(told)
    one.setTurn('running')
    await one.reopen()
    // Under tmux it went on while nothing listened: it committed and pushed,
    // and the turn that did it ended with nobody there to hear it.
    const head = commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.laneLine('lane_adopted')
    one.setTurn('idle')
    await one.beat()
    expect(one.said.at(-1)).toContain('when Tade last closed, so I am looking again')
    await one.beat()
    await until(() => one.stopped.length > 0)
    expect(await one.client.log.read({ types: ['turn_done'] })).toEqual([])
    expect(one.far.taken[1]?.take.begins).toEqual({ branch: 'tade/refunds', head })
    expect(one.stopped).toEqual(['app/refunds'])
    expect(one.told).toHaveLength(1)
    expect(one.said.at(-1)).toContain('went to vps as tade/refunds')
  }, 60_000)

  it('takes origin already at the commit it was told at as no answer, until a turn of it ends', async () => {
    const one = await handing()
    // Pushed before it was told, which says nothing about whether it has heard.
    const head = commitIn(one.made.worktree, 'early.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.moves.handOver('app/refunds', 'vps', 'you')
    await one.beat()
    await one.beat()
    expect(one.far.taken).toHaveLength(1)
    expect(one.stopped).toEqual([])
    // Nothing new to push, and its turn ending says it has done as it was told.
    await one.finishTurn()
    await one.beat()
    await until(() => one.stopped.length > 0)
    expect(one.far.taken[1]?.take.begins).toEqual({ branch: 'tade/refunds', head })
    expect(one.stopped).toEqual(['app/refunds'])
  }, 60_000)

  it('is finished as handed where the machine there took it before Tade closed, asked again by its id', async () => {
    const one = await handing()
    remembers(one.far)
    await one.moves.handOver('app/refunds', 'vps', 'you')
    const head = commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.finishTurn()
    // vps makes it, and Tade closes before the agent here is stopped.
    one.holdStop(true)
    one.later(6_000)
    one.moves.beat()
    // Taken there is not yet stopped here: its answer has still to come back.
    await until(() => one.hung.length > 0)
    expect(one.far.taken).toHaveLength(2)
    const [asked] = await one.client.log.read({ types: ['task_handing'] })
    const id = asked?.detail.id
    expect(id).toEqual(expect.any(String))
    expect(await one.client.log.read({ types: ['task_moved'] })).toEqual([])
    one.holdStop(false)
    await one.reopen()
    await one.beat()
    await one.beat()
    await until(() => one.said.some((said) => said.includes('already')))
    // Checked without one, made with it, and asked again with the same.
    expect(one.far.taken.map((entry) => entry.take.handOver)).toEqual([undefined, id, id])
    expect(one.stopped).toEqual(['app/refunds'])
    expect((await readTaskFile(one.home, 'app/refunds'))?.parked).toBe(true)
    const [moved] = await one.client.log.read({ types: ['task_moved'] })
    expect(moved?.detail).toMatchObject({ to: 'vps', as: 'tade/refunds', how: 'running', head })
    expect(one.said.at(-1)).toContain('app/refunds had gone to vps already as tade/refunds')
  }, 60_000)

  it('asks a machine too old to read its id without it, and says a no to a window asking again is not known', async () => {
    const one = await handing({ older: true })
    remembers(one.far)
    await one.moves.handOver('app/refunds', 'vps', 'you')
    commitIn(one.made.worktree, 'fix.txt')
    runGit(one.made.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/tade/refunds')
    await one.finishTurn()
    one.holdStop(true)
    one.later(6_000)
    one.moves.beat()
    await until(() => one.hung.length > 0)
    expect(one.far.taken).toHaveLength(2)
    // Refused with the id, and taken without it.
    expect(one.far.taken[1]?.take).toMatchObject({ check: false, name: 'refunds' })
    expect(one.far.taken[1]?.take.handOver).toBeUndefined()
    one.holdStop(false)
    await one.reopen()
    await one.beat()
    await one.beat()
    // The name it refuses may be the one it was given: not known, never handed.
    expect(one.said.at(-1)).toContain('Whether vps has app/refunds cannot be told')
    expect(one.said.at(-1)).toContain('its agent goes on here')
    expect(one.stopped).toEqual([])
    expect(await one.client.log.read({ types: ['task_moved'] })).toEqual([])
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
