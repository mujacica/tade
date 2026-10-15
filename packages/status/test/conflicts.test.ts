import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentSignal,
  type Config,
  ConfigSchema,
  type LivenessTable,
  livenessOf,
  type Task,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { forecastConflicts, newConflictsHeld } from '../src/conflicts.ts'
import { gitLoad } from '../src/git.ts'
import { collectStatus, type StatusOptions } from '../src/status.ts'

const NOW = Date.parse('2026-09-11T12:00:00Z')

function config(root: string): Config {
  return ConfigSchema.parse({ workspace: { adopt: false }, projects: { app: { root } } })
}

function opts(over: Partial<StatusOptions> & { config: Config }): StatusOptions {
  return {
    now: NOW,
    home: tmp('tade-home-'),
    tadeHome: tmp('tade-own-'),
    pr: false,
    processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    ...over,
  }
}

/** An agent at work, as the window's lanes would say it. */
const working = (task: string): AgentSignal => ({
  source: 'lane',
  provider: 'pi',
  sessionId: `${task}/agent`,
  alive: true,
  lastActivityAt: NOW,
  turn: 'running',
  pendingPermissions: [],
  consecutiveFailures: 0,
  exitCode: null,
})

/** A task in the shared checkout, with its file in the fixture's home. */
function inCheckout(home: string, slug: string): void {
  mkdirSync(join(home, 'projects', 'app', 'tasks', slug), { recursive: true })
  writeFileSync(
    join(home, 'projects', 'app', 'tasks', slug, 'task.yaml'),
    `id: app/${slug}\nproject: app\nintent_spoken: "${slug}"\ncreated: 2026-09-11T11:00:00Z\nworkspace: checkout\n`,
  )
}

const merges = () => gitLoad().commands['merge-tree'] ?? 0

describe('the conflict forecast', () => {
  describe('with a worktree each', () => {
    it('says which two live branches would conflict, and over which files', async () => {
      const r = mkrepo()
      r.commit('shared', { 'x.ts': 'one\ntwo\nthree\n', 'y.ts': 'y\n' })
      const a = r.addTask('alpha', { project: 'app' })
      const b = r.addTask('beta', { project: 'app' })
      const c = r.addTask('gamma', { project: 'app' })
      r.commit('alpha', { 'x.ts': 'ONE\ntwo\nthree\n' }, a)
      r.commit('beta', { 'x.ts': 'uno\ntwo\nthree\n', 'y.ts': 'why\n' }, b)
      r.commit('gamma', { 'z.ts': 'z\n' }, c)

      const ws = await collectStatus(opts({ config: config(r.root), tadeHome: r.home }))
      expect(ws.warnings).toEqual([])
      expect(ws.projects[0]?.conflicts).toEqual([
        { kind: 'branches', tasks: ['app/alpha', 'app/beta'], files: ['x.ts'] },
      ])
    })

    it('says a branch its base has moved under would no longer merge into it', async () => {
      const r = mkrepo()
      r.commit('shared', { 'x.ts': 'one\n' })
      const a = r.addTask('alpha', { project: 'app' })
      r.commit('alpha', { 'x.ts': 'ONE\n' }, a)
      r.commit('landed elsewhere', { 'x.ts': 'uno\n' })

      const ws = await collectStatus(opts({ config: config(r.root), tadeHome: r.home }))
      expect(ws.projects[0]?.conflicts).toEqual([
        { kind: 'base', tasks: ['app/alpha'], base: 'main', files: ['x.ts'] },
      ])
    })

    it('asks git again only about the pairs a moved branch is in', async () => {
      const r = mkrepo()
      r.commit('shared', { 'x.ts': 'one\n' })
      const a = r.addTask('alpha', { project: 'app' })
      const b = r.addTask('beta', { project: 'app' })
      const c = r.addTask('gamma', { project: 'app' })
      r.commit('alpha', { 'a.ts': 'a\n' }, a)
      r.commit('beta', { 'b.ts': 'b\n' }, b)
      r.commit('gamma', { 'c.ts': 'c\n' }, c)
      const held = newConflictsHeld()
      const look = () =>
        collectStatus(opts({ config: config(r.root), tadeHome: r.home, conflicts: held }))

      const first = merges()
      expect((await look()).projects[0]?.conflicts).toEqual([])
      // Three pairs, and each branch against its base: with no upstream, git
      // status cannot say the base has not moved.
      expect(merges() - first).toBe(6)
      const second = merges()
      await look()
      expect(merges() - second).toBe(0)
      r.commit('gamma again', { 'c.ts': 'cc\n' }, c)
      const third = merges()
      await look()
      // gamma against alpha, beta and its base: alpha and beta did not move.
      expect(merges() - third).toBe(3)
    })

    it('leaves out work that is merged or has nothing of its own', async () => {
      const r = mkrepo()
      r.commit('shared', { 'x.ts': 'one\n' })
      r.addTask('fresh', { project: 'app' })
      const a = r.addTask('alpha', { project: 'app' })
      r.commit('alpha', { 'x.ts': 'ONE\n' }, a)
      const first = merges()
      const ws = await collectStatus(opts({ config: config(r.root), tadeHome: r.home }))
      expect(ws.projects[0]?.conflicts).toEqual([])
      // alpha against its base, and nothing about fresh.
      expect(merges() - first).toBe(1)
    })
  })

  describe('in a shared checkout', () => {
    it('says which two agents have uncommitted hunks in the same file', async () => {
      const r = mkrepo()
      r.commit('shared', { 'shared.ts': 'one\n', 'mine.ts': 'm\n' })
      inCheckout(r.home, 'refunds')
      inCheckout(r.home, 'search')
      r.write({ 'shared.ts': 'ONE\nTWO\n', 'mine.ts': 'M\n' })
      // Clear of the second the fixture committed in: a write in the same
      // second as a commit of its file is taken to be in it.
      const later = Date.now() + 2_000
      const table: LivenessTable = {
        'app/refunds': {
          lanes: [working('app/refunds')],
          records: [],
          wrote: [
            { path: join(r.root, 'shared.ts'), at: later },
            { path: join(r.root, 'mine.ts'), at: later },
          ],
        },
        'app/search': {
          lanes: [working('app/search')],
          records: [],
          wrote: [{ path: 'shared.ts', at: later }],
        },
      }
      const ws = await collectStatus(
        opts({ config: config(r.root), tadeHome: r.home, liveness: livenessOf(table) }),
      )
      expect(ws.warnings).toEqual([])
      expect(ws.projects[0]?.conflicts).toEqual([
        { kind: 'hunks', tasks: ['app/refunds', 'app/search'], files: ['shared.ts'] },
      ])
    })

    it('stops saying so once the file is committed, whoever wrote it after', async () => {
      const r = mkrepo()
      r.commit('shared', { 'shared.ts': 'one\n' })
      inCheckout(r.home, 'refunds')
      inCheckout(r.home, 'search')
      const before = Date.now() - 5_000
      r.commit('refunds took it', { 'shared.ts': 'ONE\n' })
      // Changed again since: only one write is newer than that commit.
      r.write({ 'shared.ts': 'uno\n' })
      const table: LivenessTable = {
        'app/refunds': {
          lanes: [working('app/refunds')],
          records: [],
          wrote: [{ path: 'shared.ts', at: before }],
        },
        'app/search': {
          lanes: [working('app/search')],
          records: [],
          wrote: [{ path: 'shared.ts', at: Date.now() + 2_000 }],
        },
      }
      const ws = await collectStatus(
        opts({ config: config(r.root), tadeHome: r.home, liveness: livenessOf(table) }),
      )
      expect(ws.projects[0]?.conflicts).toEqual([])
    })

    it('asks git nothing where no file is claimed twice', async () => {
      const r = mkrepo()
      inCheckout(r.home, 'refunds')
      inCheckout(r.home, 'search')
      r.write({ 'a.ts': 'a\n', 'b.ts': 'b\n' })
      const table: LivenessTable = {
        'app/refunds': {
          lanes: [working('app/refunds')],
          records: [],
          wrote: [{ path: 'a.ts', at: NOW }],
        },
        'app/search': {
          lanes: [working('app/search')],
          records: [],
          wrote: [
            { path: 'b.ts', at: NOW },
            { path: '/elsewhere/b.ts', at: NOW },
          ],
        },
      }
      const logs = () => gitLoad().commands.log ?? 0
      const look = (liveness: LivenessTable) =>
        collectStatus(
          opts({ config: config(r.root), tadeHome: r.home, liveness: livenessOf(liveness) }),
        )
      const unclaimed = Object.fromEntries(
        Object.entries(table).map(([task, entry]) => [task, { ...entry, wrote: [] }]),
      )
      const before = logs()
      await look(unclaimed)
      const without = logs() - before
      const ws = await look(table)
      expect(ws.projects[0]?.conflicts).toEqual([])
      expect(logs() - before - without).toBe(without)
    })
  })

  describe('never throws', () => {
    it('names a pair git could not answer about, and does not call it clean', async () => {
      const r = mkrepo()
      const live = (id: string, head: string): Task =>
        ({
          id,
          project: 'app',
          state: 'working',
          workspace: 'worktree',
          git: { head, ahead: 1, behind: 0, mergedIntoBase: false, dirty: [], baseRef: 'main' },
        }) as unknown as Task
      const out = await forecastConflicts({
        root: r.root,
        tasks: [live('app/a', 'f'.repeat(40)), live('app/b', r.head())],
        base: null,
        wrote: async () => [],
        pool: 2,
      })
      expect(out.conflicts).toEqual([])
      expect(out.warnings).toEqual([
        expect.stringMatching(/^app\/a and app\/b: could not ask git whether they would merge: /),
      ])
    })

    it('a project that is not a repository', async () => {
      const out = await forecastConflicts({
        root: '/nonexistent/tade',
        tasks: [],
        base: null,
        wrote: async () => [],
        pool: 2,
      })
      expect(out).toEqual({ conflicts: [], warnings: [] })
    })
  })
})
