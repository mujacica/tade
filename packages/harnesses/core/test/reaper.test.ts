import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { REAPER_PATH, reaped } from '../src/port.ts'

// The one Tade draws itself must not outlive it.
//
// Its own exit path stops it, but an exit path only runs when there is one: a
// window killed outright leaves nothing behind to do it. So this kills a
// stand-in for Tade the hardest way there is and looks for what it started.

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** Processes whose command line carries this mark, as pid and parent pid. */
function listed(mark: string): { pid: number; ppid: number }[] {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .filter((line) => line.includes(mark) && !line.includes(' ps -ax'))
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      return { pid: pid ?? Number.NaN, ppid: ppid ?? Number.NaN }
    })
    .filter(({ pid }) => Number.isInteger(pid))
}

/** Processes whose command line carries this mark, by pid. */
function running(mark: string): number[] {
  return listed(mark).map(({ pid }) => pid)
}

/**
 * Whether the watcher has started what it runs. The mark is on the watcher's
 * own command line too, so "the mark is running" is true from the moment node
 * starts, before it has started anything — and a test that stops it then is
 * asking about nothing. What it started is the marked process it is parent of.
 */
const startedBy = (watcher: number, mark: string) =>
  listed(mark).some(({ ppid }) => ppid === watcher)

async function until(check: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('what Tade starts for itself', () => {
  const started: number[] = []

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone, which is what most of these tests are about.
      }
    }
  })

  it('wraps a launch in the watcher, leaving what it runs alone', () => {
    const launch = reaped({ command: '/bin/echo', args: ['hello'] }, 4_242)
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([REAPER_PATH, '4242', '/bin/echo', 'hello'])
  })

  it('ends what it started when the one it watches is killed outright', async () => {
    const mark = `tade-reaped-${process.pid}-${Date.now()}`
    const script = join(tmp('tade-reaper-'), 'parent.ts')
    // A stand-in for Tade: it starts something long-lived through the watcher
    // and then does nothing, exactly as a window sitting open does.
    writeFileSync(
      script,
      [
        `import { spawn } from 'node:child_process'`,
        `import { reaped } from '${fileURLToPath(new URL('../src/port.ts', import.meta.url))}'`,
        `const launch = reaped({ command: '/bin/sh', args: ['-c', 'echo ${mark}; sleep 600'] })`,
        `spawn(launch.command, launch.args, { stdio: 'ignore', detached: true })`,
        `setInterval(() => {}, 1000)`,
      ].join('\n'),
    )
    const parent = spawn(process.execPath, [script], { stdio: 'ignore' })
    started.push(parent.pid ?? 0)
    await until(() => running(mark).length > 0)

    // The hardest way a window can end: nothing of its own runs after this.
    process.kill(parent.pid ?? 0, 'SIGKILL')
    await until(() => running(mark).length === 0)
    expect(running(mark)).toEqual([])
  }, 30_000)

  it('ends what it started when it is asked to stop', async () => {
    const mark = `tade-reaped-asked-${process.pid}-${Date.now()}`
    const launch = reaped({ command: '/bin/sh', args: ['-c', `echo ${mark}; sleep 600`] })
    const child = spawn(launch.command, launch.args, { stdio: 'ignore' })
    started.push(child.pid ?? 0)
    await until(() => startedBy(child.pid ?? 0, mark))
    child.kill('SIGTERM')
    await until(() => running(mark).length === 0)
    expect(running(mark)).toEqual([])
  }, 30_000)
})
