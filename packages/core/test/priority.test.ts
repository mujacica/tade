import { describe, expect, it } from 'vitest'
import {
  GIVE_WAY_MAX,
  givesWay,
  NICE,
  NO_NICE_HERE,
  niced,
  nicedLine,
  type Started,
} from '../src/priority.ts'

// Who gives way to the window, and who never does.
//
// The rule is here and pure on purpose: what may be lowered is a property of
// the *work*, so it is answered in one place rather than at each of the two
// spawn sites — a decision taken twice is a decision that comes to differ.

/** A machine with `nice`, and one without, without asking the real PATH. */
const HAS_NICE = { PATH: '/usr/bin' }
const NO_NICE = { PATH: '/nowhere-at-all' }

describe('what gives way', () => {
  it('lowers an agent and a check suite, by what was asked for', () => {
    for (const what of ['agent', 'checks', 'tests'] as Started[]) {
      expect(givesWay(what, 5, HAS_NICE)).toEqual({ by: 5, problem: null })
    }
  })

  it('never lowers the orchestrator, however high anybody sets it', () => {
    // The one entry that is a rule rather than a preference: it is the thing
    // you are talking to, and every word of its answer is latency somebody
    // sits through. A setting is not allowed to reach it.
    expect(givesWay('orchestrator', GIVE_WAY_MAX, HAS_NICE).by).toBe(0)
    expect(givesWay('orchestrator', 1, HAS_NICE)).toEqual({ by: 0, problem: null })
  })

  it('never lowers what a person is typing into, or a server they are refreshing', () => {
    for (const what of ['shell', 'terminal', 'server'] as Started[]) {
      expect(givesWay(what, 9, HAS_NICE).by).toBe(0)
    }
  })

  it('is off when nobody asked, which is the default and not a problem', () => {
    expect(givesWay('agent', 0, HAS_NICE)).toEqual({ by: 0, problem: null })
    expect(givesWay('agent', Number.NaN, HAS_NICE)).toEqual({ by: 0, problem: null })
    expect(givesWay('agent', -3, HAS_NICE)).toEqual({ by: 0, problem: null })
  })

  it('says so where the machine has no nice, rather than failing a launch', () => {
    // The whole of what a missing `nice` may cost is a line somebody can read:
    // wrapping it anyway would be an agent that will not start at all.
    expect(givesWay('agent', 5, NO_NICE)).toEqual({ by: 0, problem: NO_NICE_HERE })
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

  it('wraps the command rather than replacing it, so the same program runs', () => {
    expect(niced(launch, 5)).toEqual({
      command: NICE,
      args: ['-n', '5', '/usr/bin/node', 'agent.ts', '--one'],
    })
  })

  it('hands back exactly what it was given when nothing is giving way', () => {
    expect(niced(launch, 0)).toEqual(launch)
    expect(niced(launch, -1)).toEqual(launch)
  })

  it('copies the arguments, so a caller cannot find its own array rewritten', () => {
    const args = ['agent.ts']
    expect(niced({ command: 'node', args }, 0).args).not.toBe(args)
    expect(args).toEqual(['agent.ts'])
  })

  it('keeps everything else about the launch', () => {
    expect(niced({ ...launch, env: { A: '1' } }, 5).env).toEqual({ A: '1' })
  })
})

describe('a command line, lowered', () => {
  it('lowers the shell, so everything the line starts gives way with it', () => {
    // `pnpm check` is three programs behind one `&&`, and nicing the first
    // word of that line would lower one of them.
    expect(nicedLine('biome ci . && tsc', 5)).toBe(
      `exec 'nice' '-n' '5' '/bin/sh' '-c' 'biome ci . && tsc'`,
    )
  })

  it('is the line the project wrote when nothing is giving way', () => {
    expect(nicedLine('pnpm check', 0)).toBe('pnpm check')
  })

  it('survives a line with quotes in it', () => {
    // The line is somebody's own, so it may hold anything a shell can hold.
    const line = `node -e "console.log('hi')"`
    const wrapped = nicedLine(line, 5)
    expect(wrapped).toContain(`'node -e "console.log('\\''hi'\\'')"'`)
  })
})
