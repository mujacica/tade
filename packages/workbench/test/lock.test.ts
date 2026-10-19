import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { HomeBusyError, lockHome } from '../src/lock.ts'

describe('one window per home', () => {
  it('refuses a second window in the same process', async () => {
    const home = tmp('tade-home-lock-')
    const lock = await lockHome(home)
    await expect(lockHome(home)).rejects.toBeInstanceOf(HomeBusyError)
    await lock.release()
    await (await lockHome(home)).release()
  })

  // A reload keeps the pid, so the window that comes back would find its home
  // held by itself if a workbench that did not close in time kept the lock.
  it('gives the home back when the process ends without releasing it', () => {
    const home = tmp('tade-home-lock-')
    const script = `
      import { lockHome } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'lock.ts'))}
      await lockHome(${JSON.stringify(home)})
      process.exit(0)
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' })
    expect(existsSync(join(home, 'tade.lock'))).toBe(false)
  })
})
