import { describe, expect, it } from 'vitest'
import { machinesTold, TOLD_PER_MACHINE, TOLD_PER_PROJECT, TOLD_PROJECTS } from '../../src/inbox.ts'
import {
  type Machine,
  type Machines,
  NO_DETAIL,
  type RemoteAgent,
  type RemoteProject,
} from '../../src/machines.ts'
import { initialState } from '../../src/model.ts'
import { clockOf, type Wiring } from '../../src/wire/context.ts'
import { Orchestrator, type OrchestratorDeps } from '../../src/wire/orchestrator.ts'

// What the orchestrator is told of the other machines with every message:
// a shape rather than a budget — capped per project, per machine and in
// projects, with what each cap left out counted — and a block it was already
// given is not handed to it again until something in it moved.

const NOW = Date.UTC(2026, 10, 22, 9, 0)
const clock = (at: number) => `t${at}`

function agent(name: string, reason = ''): RemoteAgent {
  return {
    id: name,
    name,
    title: null,
    mark: 'working',
    counts: 'working',
    queued: false,
    reason,
    movedAt: null,
    rev: 'r1',
    approval: null,
    parked: false,
    lane: 'running',
    can: [],
  }
}

function project(name: string, agents: readonly RemoteAgent[], more = 0): RemoteProject {
  return { name, title: null, agents, more, watching: null }
}

/** `n` agents named `<prefix>1` … `<prefix>n`. */
function agents(prefix: string, n: number): RemoteAgent[] {
  return Array.from({ length: n }, (_, at) => agent(`${prefix}${at + 1}`))
}

function machine(name: string, projects: readonly RemoteProject[]): Machine {
  return {
    name,
    link: 'live',
    rev: 1,
    said: null,
    asOf: NOW,
    heard: true,
    closed: false,
    seen: [],
    projects,
    spend: null,
    talk: null,
    detail: NO_DETAIL,
  }
}

const of = (...remotes: Machine[]): Machines => ({ here: 'this Mac', remotes })

/** The block's lines about one machine: from its heading to the next machine's. */
function linesOf(told: string | null, name: string): string[] {
  const lines = (told ?? '').split('\n')
  const from = lines.indexOf(`- ${name} (linked):`)
  if (from < 0) return []
  const to = lines.findIndex((line, at) => at > from && line.startsWith('- '))
  return lines.slice(from + 1, to < 0 ? undefined : to)
}

describe('the other machines, as the orchestrator is told them', () => {
  it('names no more than a project’s cap of its agents, and counts the rest with the ones it held back', () => {
    const many = agents('a', TOLD_PER_PROJECT + 2)
    const told = machinesTold(of(machine('vps', [project('app', many, 3)])), [], clock)
    const [line] = linesOf(told, 'vps')
    for (const one of many.slice(0, TOLD_PER_PROJECT)) expect(line).toContain(`${one.name} (`)
    for (const one of many.slice(TOLD_PER_PROJECT)) expect(line).not.toContain(`${one.name} (`)
    // Two past the cap, and three the remote itself held back: counted together, never dropped.
    expect(line).toMatch(/; 5 more$/)
  })

  it('names no more than a machine’s cap across its projects, and says how many it did not name', () => {
    const full = Math.ceil(TOLD_PER_MACHINE / TOLD_PER_PROJECT)
    const projects = [
      ...Array.from({ length: full }, (_, at) =>
        project(`p${at + 1}`, agents(`p${at + 1}-`, TOLD_PER_PROJECT)),
      ),
      project('late', agents('late-', 2)),
    ]
    const told = machinesTold(of(machine('vps', projects)), [], clock)
    const lines = linesOf(told, 'vps')
    const named = projects
      .flatMap((one) => one.agents)
      .filter((one) => lines.some((line) => line.includes(`${one.name} (`)))
    expect(named).toHaveLength(TOLD_PER_MACHINE)
    // The project past the machine's cap is still said, as a count rather than as nothing.
    expect(lines).toContain('  late: 2 more')
    expect(lines.at(-1)).toBe('  (2 agents there not named above)')
  })

  it('says the projects past the cap as a count of them and of every agent left out', () => {
    const projects = [
      ...Array.from({ length: TOLD_PROJECTS }, (_, at) =>
        project(`p${at + 1}`, [agent(`p${at + 1}-1`)]),
      ),
      project('ninth', [agent('n1')]),
      project('tenth', [agent('t1')]),
      // Nothing sent, two held back there: still work, still counted.
      project('eleventh', [], 2),
    ]
    const told = machinesTold(of(machine('vps', projects)), [], clock)
    const lines = linesOf(told, 'vps')
    expect(lines.filter((line) => /^ {2}p\d+: /.test(line))).toHaveLength(TOLD_PROJECTS)
    expect(told).not.toContain('ninth')
    expect(lines.at(-1)).toBe(
      '  and 3 more projects there, 4 agents in them and past the caps above',
    )
  })

  it('says every machine, however much the one before it has', () => {
    const crowded = Array.from({ length: TOLD_PROJECTS * 2 }, (_, at) =>
      project(`p${at + 1}`, agents(`p${at + 1}-`, TOLD_PER_PROJECT * 2)),
    )
    const told = machinesTold(
      of(
        machine('vps', crowded),
        machine('lab', []),
        machine('mini', [project('site', [agent('deploy', 'pushing the site')])]),
      ),
      [],
      clock,
    )
    expect(linesOf(told, 'mini')).toEqual(['  site: deploy (working — pushing the site)'])
    expect(told).toContain('- lab (linked):')
  })
})

/** An orchestrator that hands back what it was asked, over the machines `machines` returns. */
function orchestratorOver(machines: () => Machines) {
  const asked: string[] = []
  let state = initialState()
  const wire = {
    opts: {
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
      config: { surfaces: { voice: { speak: false, muted: true } }, orchestrator: {} },
      client: { recallAll: () => [] },
    },
    get state() {
      return state
    },
    put: (next: typeof state) => {
      state = next
    },
    now: () => NOW,
    draw: () => {},
  } as unknown as Wiring
  const deps = {
    machines,
    seen: () => [],
    voice: { flushSpeech: () => {} },
  } as unknown as OrchestratorDeps
  return { orchestrator: new Orchestrator(wire, deps), asked }
}

describe('the other machines, told once', () => {
  it('is not handed the same block twice running, and is handed it again once it moved', async () => {
    let machines = of(machine('vps', [project('app', [agent('refunds', 'running the tests')])]))
    const { orchestrator, asked } = orchestratorOver(() => machines)
    const block = '- vps (linked):\n  app: refunds (working — running the tests)'

    await orchestrator.ask('what is the vps doing')
    expect(asked[0]).toContain(block)

    await orchestrator.ask('and now')
    expect(asked[1]).not.toContain('- vps (linked):')
    expect(asked[1]).toContain(
      `Other machines, as each last said: vps: 1 working. The rest of what each machine said is as you were told at ${clockOf(NOW)}.`,
    )

    machines = of(machine('vps', [project('app', [agent('refunds', 'pushing the fix')])]))
    await orchestrator.ask('and now')
    expect(asked[2]).toContain('- vps (linked):\n  app: refunds (working — pushing the fix)')
  })
})
