import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { lockPath } from '../src/lock.ts'
import { slotsDir } from '../src/machine.ts'
import { runningPath } from '../src/running.ts'

// What a process held is given back when it ends, released or not: a reload
// keeps the pid, so a pid still alive is no longer proof of a holder. Seen from
// outside, in a process of its own, because it is about that process ending.

const SRC = join(import.meta.dirname, '..', 'src')

/** Run this in a Node of its own, which ends without letting go of anything. */
function endsHolding(script: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' })
}

describe('held until the process ends', () => {
  it('gives back the run lock, its slot and the run in flight when it ends without releasing them', () => {
    const records = tmp('tade-held-')
    const home = tmp('tade-held-home-')
    endsHolding(`
      import { takeRunLock } from ${JSON.stringify(join(SRC, 'lock.ts'))}
      import { takeMachineSlot } from ${JSON.stringify(join(SRC, 'machine.ts'))}
      import { writeRunning } from ${JSON.stringify(join(SRC, 'running.ts'))}
      await takeRunLock(${JSON.stringify(records)}, 'tests')
      await takeMachineSlot(${JSON.stringify(home)}, 1, { what: 'tests', where: 'here' })
      await writeRunning(${JSON.stringify(records)}, { pid: process.pid, commit: 'abc', by: 'you', at: 'now', checks: [] })
      process.exit(0)
    `)
    expect(existsSync(lockPath(records))).toBe(false)
    expect(existsSync(join(slotsDir(home), 'slot-0.lock'))).toBe(false)
    expect(existsSync(runningPath(records))).toBe(false)
  })

  it('leaves one that somebody else has taken since', () => {
    const records = tmp('tade-held-')
    endsHolding(`
      import { writeFileSync } from 'node:fs'
      import { takeRunLock, lockPath } from ${JSON.stringify(join(SRC, 'lock.ts'))}
      await takeRunLock(${JSON.stringify(records)}, 'tests')
      writeFileSync(lockPath(${JSON.stringify(records)}), JSON.stringify({ pid: 1, what: 'theirs', at: 'now' }))
    `)
    expect(JSON.parse(readFileSync(lockPath(records), 'utf8')).what).toBe('theirs')
  })
})
