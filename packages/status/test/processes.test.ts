import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { listAgentProcesses, matchProvider, problemWith, type Ran } from '../src/processes.ts'

// The process scan, with the programs it shells out to answered by a table.
//
// What is under test is the half that only shows up on a machine under load:
// that a probe which ran out of time is told apart from one that is not
// installed, and that neither of them is reported as "no agent is running".

const answered = (stdout: string): Ran => ({ stdout, stderr: '', exitCode: 0, timedOut: false })

const timedOut: Ran = { stdout: '', stderr: '', exitCode: undefined, timedOut: true }

const notInstalled: Ran = {
  stdout: '',
  stderr: '',
  exitCode: undefined,
  timedOut: false,
  code: 'ENOENT',
}

/** A `ps` with one agent in it, and an `lsof` that places it. */
function scripted(pid: number) {
  return async (command: string): Promise<Ran> =>
    command === 'ps'
      ? answered(`  ${pid} /usr/local/bin/claude --resume\n  1 /sbin/launchd\n`)
      : answered(`p${pid}\nn/Users/me/shop\n`)
}

describe('why a probe came back with nothing', () => {
  it('tells not installed, failed and timed out apart, and says which', () => {
    expect(problemWith('ps', notInstalled)).toBe('there is no ps on this machine')
    expect(problemWith('ps', { ...answered(''), exitCode: 1, stderr: 'ps: illegal option' })).toBe(
      'ps exited 1: ps: illegal option',
    )
    expect(problemWith('ps', timedOut)).toMatch(/took longer than 10s.*busy machine/)
    expect(problemWith('ps', answered('1 claude'))).toBeNull()
  })

  it('never calls a program unavailable when it is installed and working', () => {
    // The sentence this replaces said `ps unavailable` about the one case
    // where ps is sitting in /bin answering everybody else.
    expect(problemWith('ps', timedOut)).not.toMatch(/unavailable|no ps/)
  })
})

describe('scanning for agents', () => {
  it('finds a provider and where it is running', async () => {
    const found = await listAgentProcesses({ run: scripted(process.pid) })
    expect(found.warnings).toEqual([])
    expect(found.processes.map((one) => ({ pid: one.pid, provider: one.provider }))).toEqual([
      { pid: process.pid, provider: 'claude-code' },
    ])
    // Where it is comes from `/proc` or from lsof depending on the machine, so
    // what is asserted is that it was placed at all: a process nobody could
    // place is dropped, and a dropped process is an agent that looks stopped.
    expect(found.processes[0]?.cwd).toBeTruthy()
  })

  it('a scan that ran out of time is a busy machine, not an absence of agents', async () => {
    const before = await listAgentProcesses({ run: scripted(process.pid) })
    expect(before.processes.length).toBe(1)

    const late = await listAgentProcesses({ run: async () => timedOut })
    // The whole point. Answering `[]` here is what made the window say nothing
    // was running on the one kind of machine where everything was.
    expect(late.processes).toEqual(before.processes)
    expect(late.warnings).toEqual([
      expect.stringMatching(/ps took longer than 10s.*what the last scan found/),
    ])
  })

  it('keeps nothing from the last scan that has since gone', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    await once(child, 'spawn')
    const seen = await listAgentProcesses({ run: scripted(child.pid ?? 0) })
    expect(seen.processes.map((one) => one.pid)).toEqual([child.pid])

    child.kill('SIGKILL')
    await once(child, 'exit')
    const late = await listAgentProcesses({ run: async () => timedOut })
    // A process that has gone is not evidence that anything is alive, however
    // recently it was seen — so the stale answer is empty, and says the
    // shorter sentence rather than claiming it has something.
    expect(late.processes).toEqual([])
    expect(late.warnings).toEqual([expect.stringMatching(/ps took longer than 10s/)])
    expect(late.warnings[0]).not.toMatch(/last scan found/)
  })

  it('says a machine with no ps in its own words', async () => {
    const missing = await listAgentProcesses({ run: async () => notInstalled })
    expect(missing.processes).toEqual([])
    expect(missing.warnings).toEqual([
      'process scan could not look: there is no ps on this machine',
    ])
  })

  it('reads a provider out of a command line, and nothing else as one', () => {
    expect(matchProvider('/usr/local/bin/claude --resume')).toBe('claude-code')
    expect(matchProvider('node /x/codex')).toBe('codex')
    expect(matchProvider('vim claudette.ts')).toBeNull()
  })
})
