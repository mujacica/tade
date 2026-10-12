import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { located, runProgram } from '../src/run.ts'

// The one way Tade runs a program it waits for.
//
// What matters about it cannot be read off the options it passes: `execFile`
// was handed `detached: true` for years and never detached anything. So these
// ask the machine — which group the child is in, whether its own child is gone
// — and never the object that asked for it.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Until the process is gone, or a deadline that only a broken kill reaches. */
async function gone(pid: number): Promise<boolean> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((wake) => setTimeout(wake, 20))
  }
  return false
}

describe('running a program', () => {
  it('runs it in a process group of its own, so the terminal never names its window after it', async () => {
    const ran = await runProgram('sh', ['-c', 'echo $$ $(ps -o pgid= -p $$)'])
    const [pid, group] = ran.stdout.trim().split(/\s+/)
    // A machine with no `ps` cannot be asked, and a test that cannot ask is
    // not a test that fails.
    if (!group) return
    expect(group).toBe(pid)
    const mine = await runProgram('ps', ['-o', 'pgid=', '-p', String(process.pid)])
    expect(group).not.toBe(mine.stdout.trim())
  })

  it('starts a bare name from where it is, and takes a path as written', () => {
    expect(located('sh')).toMatch(/^\/.*\/sh$/)
    expect(located('/bin/sh')).toBe('/bin/sh')
    expect(located('./sh')).toBe('./sh')
    expect(located('sh', { PATH: '' })).toBe('sh')
    expect(located('tade-no-such-program')).toBe('tade-no-such-program')
  })

  it('hands back its code and both of its outputs', async () => {
    const ran = await runProgram('sh', ['-c', 'echo out; echo err >&2; exit 3'])
    expect(ran).toEqual({
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
      timedOut: false,
      missing: false,
    })
  })

  it('runs where it is told, with the environment it is given', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tade-run-')))
    made.push(dir)
    const ran = await runProgram('sh', ['-c', 'pwd; echo "$TADE_RUN_SAID"'], {
      cwd: dir,
      env: { PATH: process.env.PATH, TADE_RUN_SAID: 'told' },
    })
    expect(ran.stdout).toBe(`${dir}\ntold\n`)
  })

  it('kills what it started, and what that started, at its deadline', async () => {
    // The grandchild holds the output open, so without the whole group going
    // this would wait the full thirty seconds rather than one.
    const ran = await runProgram('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 1_000 })
    expect(ran.timedOut).toBe(true)
    expect(ran.code).toBe(137)
    expect(ran.stderr).toContain('took longer than 1s')
    const grandchild = Number(ran.stdout.trim())
    expect(grandchild).toBeGreaterThan(0)
    expect(await gone(grandchild)).toBe(true)
  })

  it('stops when asked to, before or after it started', async () => {
    const before = new AbortController()
    before.abort()
    expect((await runProgram('sleep', ['30'], { signal: before.signal })).code).toBe(137)
    const during = new AbortController()
    const running = runProgram('sleep', ['30'], { signal: during.signal })
    setImmediate(() => during.abort())
    expect((await running).code).toBe(137)
  })

  it('says a program that is not there, and never throws', async () => {
    const bare = await runProgram('tade-no-such-program', ['x'])
    expect(bare).toMatchObject({ code: 127, stdout: '', missing: true, timedOut: false })
    expect(bare.stderr).toBe('there is no tade-no-such-program on this machine')
    expect(await runProgram('/nonexistent/tade', [])).toMatchObject({ code: 127, missing: true })
    // A folder that is not there is not a program that is not there.
    const nowhere = await runProgram('sh', ['-c', 'true'], { cwd: '/nonexistent/tade-folder' })
    expect(nowhere).toMatchObject({ code: 126, missing: false })
    expect(nowhere.stderr).toBe('/nonexistent/tade-folder is not there to run sh in')
    const given = await runProgram('/bin/sh', ['-c', 'true'], { cwd: '/nonexistent/tade-folder' })
    expect(given).toMatchObject({ code: 126, missing: false })
  })

  it('keeps what it said up to its cap, and stops it there rather than reading forever', async () => {
    const ran = await runProgram('sh', ['-c', 'while :; do echo yyyyyyy; done'], {
      maxBuffer: 1_000,
    })
    expect(ran.stdout.length).toBe(1_000)
    expect(ran.code).toBe(137)
    expect(ran.stderr).toBe('sh said more than 1000 bytes on stdout and was stopped')
    // Exactly the cap, then more: the byte past it is the one that stops it.
    const exact = await runProgram(
      'sh',
      ['-c', 'printf %01000d 0; sleep 0.2; while :; do echo y; done'],
      { maxBuffer: 1_000, timeoutMs: 20_000 },
    )
    expect(exact).toMatchObject({ code: 137, timedOut: false })
    expect(exact.stdout).toBe('0'.repeat(1_000))
  })
})
