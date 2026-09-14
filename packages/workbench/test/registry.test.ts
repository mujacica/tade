import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId } from '@wilco/core'
import { ECHO_CHILD, until } from '@wilco/drivers-core/conformance'
import { PtyDriver } from '@wilco/drivers-pty'
import { TmuxDriver } from '@wilco/drivers-tmux'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { LaneRegistry } from '../src/registry.ts'

// Closing Wilco and opening it again, which is the ordinary thing that happens
// to it. Whether the agents are still there afterwards is the difference
// between a control room and a terminal multiplexer with opinions.

describe('the lane registry, across a restart', () => {
  let home: string
  let path: string
  let log: EventLog
  const open: LaneRegistry[] = []

  /** A Wilco session: the registry a window would hold while it is open. */
  async function session(driver: PtyDriver | TmuxDriver): Promise<LaneRegistry> {
    const registry = await LaneRegistry.open({ driver, log, path })
    open.push(registry)
    return registry
  }

  const lane = (registry: LaneRegistry, id: string) =>
    registry.spawn({
      id: id as LaneId,
      task: id.split('/').slice(0, 2).join('/'),
      kind: 'agent',
      cwd: home,
      command: process.execPath,
      args: [ECHO_CHILD],
      cols: 80,
      rows: 24,
    })

  beforeEach(async () => {
    home = tmp('wilco-registry-')
    path = join(home, 'lanes.json')
    log = await EventLog.open({ path: join(home, 'events.jsonl') })
  })

  afterEach(async () => {
    // Whatever a test left behind, stop it: these are real processes.
    for (const registry of open.splice(0)) await registry.shutdown().catch(() => {})
    await log.close().catch(() => {})
  })

  describe('with a driver whose lanes outlive it', () => {
    // Its own tmux server and session, so a run never touches yours.
    const socket = `wilco-test-${process.pid}`
    let space: string
    const tmux = () => new TmuxDriver({ socket, session: space })

    beforeEach(() => {
      space = `reg-${Math.random().toString(36).slice(2, 10)}`
    })

    it('walks back into a lane that kept running, and can drive it', async () => {
      const first = await session(tmux())
      const before = await lane(first, 'app/refunds/agent')
      await until(async () => (await first.capture('app/refunds/agent' as LaneId, 50)).length > 0)
      // The window closes. Nothing is stopped.
      await first.detach()

      const second = await session(tmux())
      const after = second.get('app/refunds/agent' as LaneId)
      expect(after).toMatchObject({ id: 'app/refunds/agent', alive: true })
      expect(after?.pid).toBe(before.pid)

      // The bug this exists to catch: the registry used to call a lane alive
      // on the strength of its pid while the fresh driver had never heard of
      // it, so the first thing you did with it threw.
      await second.write('app/refunds/agent' as LaneId, new TextEncoder().encode('hello\n'))
      await until(async () =>
        (await second.capture('app/refunds/agent' as LaneId, 50)).includes('got:hello'),
      )
    })

    it('adopts a lane it has no record of, and knows whose it is', async () => {
      const first = await session(tmux())
      await lane(first, 'app/search/agent')
      await first.detach()

      // The registry file is gone; the lane is not. This is a lost file, or a
      // lane another window opened.
      const second = await LaneRegistry.open({
        driver: tmux(),
        log,
        path: join(home, 'other-lanes.json'),
      })
      open.push(second)
      const found = second.get('app/search/agent' as LaneId)
      // The id carries the task, so nothing has to be guessed.
      expect(found).toMatchObject({ id: 'app/search/agent', task: 'app/search', alive: true })
      expect(found?.kind).toBe('agent')
      expect(second.list('app/search')).toHaveLength(1)
    })

    it('records the adoption, so the journal says where the lane came from', async () => {
      const first = await session(tmux())
      await lane(first, 'app/notes/agent')
      await first.detach()
      await session(tmux())

      const events = await log.read({ limit: 100 })
      const adopted = events.filter((e) => e.type === 'lane_adopted')
      expect(adopted.map((e) => e.lane)).toContain('app/notes/agent')
      expect(adopted.map((e) => e.task)).toContain('app/notes')
    })
  })

  describe('with a driver whose lanes do not', () => {
    it('reports the lane as gone rather than pretending, and keeps its spec', async () => {
      const first = await session(new PtyDriver({ scrollback: 200 }))
      await lane(first, 'app/refunds/agent')
      await first.detach()

      const second = await session(new PtyDriver({ scrollback: 200 }))
      const after = second.get('app/refunds/agent' as LaneId)
      expect(after).toMatchObject({ id: 'app/refunds/agent', alive: false })
      // Kept so the work can be put back.
      expect(after?.spec.command).toBe(process.execPath)

      const relaunched = await second.relaunch('app/refunds/agent' as LaneId)
      expect(relaunched.alive).toBe(true)
    })

    it('marks what the window closed on as lost, and never what was stopped or ended by itself', async () => {
      const first = await session(new PtyDriver({ scrollback: 200 }))
      await lane(first, 'app/refunds/agent')
      await lane(first, 'app/search/agent')
      await lane(first, 'app/stopped/agent')
      await first.close('app/stopped/agent' as LaneId)
      await first.detach()

      const second = await session(new PtyDriver({ scrollback: 200 }))
      expect(second.get('app/refunds/agent' as LaneId)).toMatchObject({ alive: false, lost: true })
      expect(second.get('app/stopped/agent' as LaneId)?.lost).toBeUndefined()
      // Still lost to a window after that one, until something is done about it.
      await second.detach()
      const third = await session(new PtyDriver({ scrollback: 200 }))
      expect(third.get('app/search/agent' as LaneId)?.lost).toBe(true)
      // Started again, it is just running.
      const back = await third.relaunch('app/refunds/agent' as LaneId)
      expect(back.lost).toBeUndefined()
    })

    it('says why it is gone, in terms of what the driver can do', async () => {
      const first = await session(new PtyDriver({ scrollback: 200 }))
      await lane(first, 'app/refunds/agent')
      await first.detach()
      await session(new PtyDriver({ scrollback: 200 }))

      const exits = (await log.read({ limit: 100 })).filter((e) => e.type === 'lane_exited')
      expect(String(exits.at(-1)?.detail?.reason)).toContain('do not outlive Wilco')
    })

    it('leaves the registry file readable by anything of yours that wants to look', async () => {
      const registry = await session(new PtyDriver({ scrollback: 200 }))
      await lane(registry, 'app/refunds/agent')
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      expect(saved.driver).toBe('pty')
      expect(saved.lanes.map((l: { id: string }) => l.id)).toEqual(['app/refunds/agent'])
    })
  })

  describe('what it writes down', () => {
    it('keeps the environment Wilco set, never what the lane inherited, and only for you to read', async () => {
      process.env.WILCO_TEST_SECRET = 'sk-not-for-disk'
      try {
        const registry = await session(new PtyDriver({ scrollback: 200 }))
        await registry.spawn({
          id: 'app/refunds/agent' as LaneId,
          task: 'app/refunds',
          kind: 'agent',
          cwd: home,
          command: process.execPath,
          args: [ECHO_CHILD],
          env: { ...process.env, WILCO_TASK_ID: 'app/refunds' } as Record<string, string>,
        })
        const text = readFileSync(path, 'utf8')
        expect(text).not.toContain('sk-not-for-disk')
        expect(JSON.parse(text).lanes[0].spec.env).toEqual({ WILCO_TASK_ID: 'app/refunds' })
        expect(statSync(path).mode & 0o777).toBe(0o600)
      } finally {
        delete process.env.WILCO_TEST_SECRET
      }
    })
  })

  describe('when the ground moves under a lane', () => {
    it('survives its working directory being deleted', async () => {
      const registry = await session(new PtyDriver({ scrollback: 200 }))
      const worktree = tmp('wilco-vanishing-')
      await registry.spawn({
        id: 'app/vanishes/agent' as LaneId,
        task: 'app/vanishes',
        kind: 'agent',
        cwd: worktree,
        command: process.execPath,
        args: [ECHO_CHILD],
      })
      await until(
        async () => (await registry.capture('app/vanishes/agent' as LaneId, 20)).length > 0,
      )

      // Somebody ran `git worktree remove` while an agent was working in it.
      rmSync(worktree, { recursive: true, force: true })

      // Wilco is not what breaks: the lane is the driver's, the process has
      // its own idea of where it is, and status is derived from git, which
      // will simply stop finding the task.
      expect(registry.get('app/vanishes/agent' as LaneId)?.alive).toBe(true)
      await expect(registry.capture('app/vanishes/agent' as LaneId, 20)).resolves.toBeTypeOf(
        'string',
      )
      await expect(
        registry.write('app/vanishes/agent' as LaneId, new TextEncoder().encode('hello\n')),
      ).resolves.toBeUndefined()
    })

    it('reports a lane whose command does not exist instead of inventing one', async () => {
      const registry = await session(new PtyDriver({ scrollback: 200 }))
      await expect(
        registry.spawn({
          id: 'app/ghost/agent' as LaneId,
          task: 'app/ghost',
          kind: 'agent',
          cwd: home,
          command: 'definitely-not-a-real-command',
        }),
      ).rejects.toThrow()
      // A phantom lane is worse than a failed spawn: it would be reported as
      // an agent working on something forever.
      expect(registry.get('app/ghost/agent' as LaneId)).toBeNull()
    })
  })
})
