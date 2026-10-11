import { type Config, ConfigSchema, type LivenessTable } from '@tade/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { CLOSED, type StatusAsk, type StatusCollector } from '../src/collector.ts'
import { COLLECTORS } from '../src/collectors.ts'
import { collectStatus } from '../src/status.ts'

// The shared suite every StatusCollector must pass. Where the look happens is
// the collector's business; what it answers is not, and this holds the two
// there are — here and in a child — to the same answers about the same things.
//
// Held in spawns and never in wall clock, like the scan probe beside it.

const NOW = Date.parse('2026-10-11T12:00:00Z')

/** Enough worktrees for a gate to have something to save. */
const WORKTREES = 4

/** What a project costs however much it holds: its worktree list and its base. */
const PER_PROJECT = 4

interface Fixture {
  config: Config
  ask(over?: Partial<StatusAsk>): StatusAsk
  tasks: string[]
}

function fixture(): Fixture {
  const r = mkrepo()
  const tasks: string[] = []
  for (let i = 0; i < WORKTREES; i++) {
    const wt = r.addTask(`t${i}`, { project: 'app' })
    if (i % 2 === 0) r.commit(`work ${i}`, { [`f${i}.ts`]: 'x\n' }, wt)
    tasks.push(`app/t${i}`)
  }
  const config = ConfigSchema.parse({
    workspace: { adopt: false },
    projects: { app: { root: r.root } },
  })
  const home = tmp('tade-collector-home-')
  return {
    config,
    tasks,
    ask: (over = {}) => ({
      config,
      now: NOW,
      home,
      tadeHome: r.home,
      pr: false,
      lanes: {},
      ...over,
    }),
  }
}

export function testCollector(name: string, make: () => StatusCollector): void {
  describe(`StatusCollector: ${name}`, () => {
    // One repository for the suite: nothing here changes it, and a fresh
    // collector per test is what each one is about.
    let f: Fixture
    beforeAll(() => {
      f = fixture()
    })
    const opened: StatusCollector[] = []
    const open = () => {
      const collector = make()
      opened.push(collector)
      return collector
    }
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((collector) => collector.close()))
    })

    it('is the one the registry makes under its name', () => {
      const collector = open()
      expect(COLLECTORS[collector.id]).toBeDefined()
    })

    it('answers with every task there is to see', async () => {
      const answer = await open().collect(f.ask())
      if (!answer.known) throw new Error(answer.why)
      const tasks = answer.workspace.projects.flatMap((project) => project.tasks)
      expect(tasks.map((task) => task.id)).toEqual(f.tasks)
      expect(answer.workspace.warnings).toEqual([])
    })

    it('answers what a look in this process answers about the same things', async () => {
      // Not the tool servers: they are a look at the whole machine, and the
      // machine moves between two looks. Everything else is this fixture's.
      const answer = await open().collect(f.ask())
      if (!answer.known) throw new Error(answer.why)
      const here = await collectStatus({ ...f.ask(), liveness: { lanes: async () => [] } })
      expect(answer.workspace.projects).toEqual(here.projects)
      expect(answer.workspace.elsewhere).toEqual(here.elsewhere)
      expect(answer.workspace.generatedAt).toBe(here.generatedAt)
    })

    it("puts the window's own lanes on the task they belong to", async () => {
      const task = f.tasks[0] ?? ''
      const lanes: LivenessTable = {
        [task]: {
          lanes: [
            {
              source: 'lane',
              provider: 'pi',
              sessionId: `${task}/agent`,
              alive: true,
              lastActivityAt: NOW - 1_000,
              turn: 'running',
              pendingPermissions: [],
              consecutiveFailures: 0,
              exitCode: null,
            },
          ],
          records: [
            {
              id: `${task}/agent`,
              kind: 'agent',
              alive: true,
              pid: 4242,
              lastOutputAt: NOW - 1_000,
              attach: `tade attach ${task}/agent`,
            },
          ],
        },
      }
      const answer = await open().collect(f.ask({ lanes }))
      if (!answer.known) throw new Error(answer.why)
      const tasks = answer.workspace.projects.flatMap((project) => project.tasks)
      const mine = tasks.find((one) => one.id === task)
      expect(mine?.lanes.map((lane) => lane.id)).toEqual([`${task}/agent`])
      expect(mine?.agents.map((agent) => agent.sessionId)).toEqual([`${task}/agent`])
      expect(mine?.state).toBe('working')
      // And only there: a table is about the tasks it names.
      const others = tasks.filter((one) => one.id !== task)
      expect(others.flatMap((one) => one.lanes)).toEqual([])
    })

    it('holds one gate for as long as it is held, so a quiet second look forks almost nothing', async () => {
      const collector = open()
      const cold = await collector.collect(f.ask())
      const warm = await collector.collect(f.ask())
      if (!cold.known) throw new Error(cold.why)
      if (!warm.known) throw new Error(warm.why)
      // The floor as well as the ceiling, so the saving is not one made by
      // finding nothing.
      expect(cold.spent.spawns).toBeGreaterThanOrEqual(WORKTREES * 3)
      expect(warm.spent.spawns).toBeLessThanOrEqual(PER_PROJECT)
      expect(warm.workspace.projects).toEqual(cold.workspace.projects)
      expect(warm.spent.rss).toBeGreaterThan(0)
    })

    it('answers a project it cannot read with a warning, not with unknown', async () => {
      const config = ConfigSchema.parse({
        workspace: { adopt: false },
        projects: { gone: { root: tmp('tade-collector-gone-') } },
      })
      const answer = await open().collect(f.ask({ config }))
      if (!answer.known) throw new Error(answer.why)
      expect(answer.workspace.projects.map((project) => project.name)).toEqual(['gone'])
      expect(answer.workspace.warnings.join('\n')).toMatch(/^gone: /m)
    })

    it('answers a look that went wrong unknown, and never with an empty workspace', async () => {
      // A config that is not one: the look throws part-way, which a one-shot
      // `tade status` would answer with no projects at all.
      const answer = await open().collect(f.ask({ config: {} as Config }))
      expect(answer).toMatchObject({ known: false, why: expect.stringMatching(/^status: /) })
    })

    it('is unknown once closed, and closing twice is fine', async () => {
      const collector = open()
      await collector.close()
      await collector.close()
      expect(await collector.collect(f.ask())).toEqual({ known: false, why: CLOSED })
    })
  })
}
