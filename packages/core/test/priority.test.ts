import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  GIVE_WAY_MAX,
  givesWay,
  IONICE,
  KEEPS_PACE,
  lowered,
  loweredLine,
  NICE,
  NO_NICE_HERE,
  QOS,
  type Started,
} from '../src/priority.ts'

// Who gives way to the window, and who never does.
//
// The rule is here and pure on purpose: what may be lowered is a property of
// the *work*, so it is answered in one place rather than at each of the two
// spawn sites — a decision taken twice is a decision that comes to differ.

/**
 * Machines made of empty executables, so which programs are "here" is the
 * test's to say and not the real PATH's: a Mac (nice and taskpolicy), a Linux
 * box (nice and ionice), the bare POSIX floor, and nothing at all.
 */
function machine(...programs: string[]): { PATH: string } {
  const dir = tmp('tade-priority-')
  for (const program of programs) {
    writeFileSync(join(dir, program), '#!/bin/sh\n')
    chmodSync(join(dir, program), 0o755)
  }
  return { PATH: dir }
}
const MAC = machine(NICE, QOS)
const LINUX = machine(NICE, IONICE)
const HAS_NICE = machine(NICE)
const NO_NICE = machine()

describe('what gives way', () => {
  it('lowers an agent and a check suite, by what was asked for', () => {
    for (const what of ['agent', 'checks', 'tests'] as Started[]) {
      expect(givesWay(what, 5, HAS_NICE)).toEqual({
        by: 5,
        wrap: [NICE, '-n', '5'],
        problem: null,
      })
    }
  })

  it('clamps QoS where the machine has taskpolicy, which is what a Mac weighs', () => {
    // Utility, not background: background is efficiency cores and throttled
    // disk, an agent you are waiting on crawling.
    expect(givesWay('agent', 10, MAC).wrap).toEqual([NICE, '-n', '10', QOS, '-c', 'utility'])
  })

  it('lowers I/O to best-effort where the machine has ionice', () => {
    // Best-effort at its lowest and never idle, which other agents can starve.
    expect(givesWay('agent', 10, LINUX).wrap).toEqual([
      NICE,
      '-n',
      '10',
      IONICE,
      '-c',
      '2',
      '-n',
      '7',
    ])
  })

  it('never lowers the orchestrator, however high anybody sets it', () => {
    // The one entry that is a rule rather than a preference: it is the thing
    // you are talking to, and every word of its answer is latency somebody
    // sits through. A setting is not allowed to reach it.
    expect(givesWay('orchestrator', GIVE_WAY_MAX, HAS_NICE).by).toBe(0)
    expect(givesWay('orchestrator', 1, MAC)).toEqual(KEEPS_PACE)
  })

  it('never lowers what a person is typing into, or a server they are refreshing', () => {
    for (const what of ['shell', 'terminal', 'server'] as Started[]) {
      expect(givesWay(what, 9, MAC)).toEqual(KEEPS_PACE)
    }
  })

  it('is off when nobody asked, which is the default and not a problem', () => {
    expect(givesWay('agent', 0, MAC)).toEqual(KEEPS_PACE)
    expect(givesWay('agent', Number.NaN, MAC)).toEqual(KEEPS_PACE)
    expect(givesWay('agent', -3, MAC)).toEqual(KEEPS_PACE)
    // A fraction that rounds to nought is off, not `nice -n 0`.
    expect(givesWay('agent', 0.4, MAC)).toEqual(KEEPS_PACE)
  })

  it('says so where the machine has no nice, rather than failing a launch', () => {
    // The whole of what a missing `nice` may cost is a line somebody can read:
    // wrapping it anyway would be an agent that will not start at all.
    expect(givesWay('agent', 5, NO_NICE)).toEqual({ by: 0, wrap: [], problem: NO_NICE_HERE })
    // And a QoS clamp on its own is not reached for: nice is the floor, so a
    // machine with taskpolicy and no nice is said rather than half-lowered.
    expect(givesWay('agent', 5, machine(QOS)).wrap).toEqual([])
    // And nothing is said where nothing was asked for: a machine without
    // `nice` and a setting that is off have no news between them.
    expect(givesWay('agent', 0, NO_NICE).problem).toBeNull()
  })

  it('clamps rather than refusing a value that reached past the schema', () => {
    expect(givesWay('checks', 100, HAS_NICE).by).toBe(GIVE_WAY_MAX)
    expect(givesWay('checks', 5.4, HAS_NICE).by).toBe(5)
  })
})

describe('a launch, lowered', () => {
  const launch = { command: '/usr/bin/node', args: ['agent.ts', '--one'] }
  const mac = givesWay('agent', 5, MAC)

  it('wraps the command rather than replacing it, so the same program runs', () => {
    expect(lowered(launch, mac)).toEqual({
      command: NICE,
      args: ['-n', '5', QOS, '-c', 'utility', '/usr/bin/node', 'agent.ts', '--one'],
    })
  })

  it('hands back exactly what it was given when nothing is giving way', () => {
    expect(lowered(launch, KEEPS_PACE)).toEqual(launch)
  })

  it('copies the arguments, so a caller cannot find its own array rewritten', () => {
    const args = ['agent.ts']
    expect(lowered({ command: 'node', args }, KEEPS_PACE).args).not.toBe(args)
    expect(args).toEqual(['agent.ts'])
  })

  it('keeps everything else about the launch', () => {
    expect(lowered({ ...launch, env: { A: '1' } }, mac).env).toEqual({ A: '1' })
  })
})

describe('a command line, lowered', () => {
  it('lowers the shell, so everything the line starts gives way with it', () => {
    // `pnpm check` is three programs behind one `&&`, and nicing the first
    // word of that line would lower one of them.
    expect(loweredLine('biome ci . && tsc', givesWay('checks', 5, MAC))).toBe(
      `exec 'nice' '-n' '5' 'taskpolicy' '-c' 'utility' '/bin/sh' '-c' 'biome ci . && tsc'`,
    )
  })

  it('is the line the project wrote when nothing is giving way', () => {
    expect(loweredLine('pnpm check', KEEPS_PACE)).toBe('pnpm check')
  })

  it('survives a line with quotes in it', () => {
    // The line is somebody's own, so it may hold anything a shell can hold.
    const line = `node -e "console.log('hi')"`
    const wrapped = loweredLine(line, givesWay('checks', 5, HAS_NICE))
    expect(wrapped).toContain(`'node -e "console.log('\\''hi'\\'')"'`)
  })
})
