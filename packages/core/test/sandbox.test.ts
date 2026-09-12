import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  bwrapArgs,
  type Launch,
  SandboxUnavailableError,
  sandboxed,
  seatbeltProfile,
  writablePaths,
} from '../src/sandbox.ts'

const run = promisify(execFile)
const launch: Launch = { command: '/bin/echo', args: ['hello'] }
const spec = (over = {}) => ({
  kind: 'seatbelt' as const,
  worktree: '/wt/refunds',
  platform: 'darwin' as NodeJS.Platform,
  home: '/Users/someone',
  tmp: '/var/folders/xx',
  ...over,
})

describe('sandboxed', () => {
  it('leaves a launch alone when nothing was asked for', () => {
    expect(sandboxed(launch, spec({ kind: 'none' }))).toEqual(launch)
  })

  it('wraps the command rather than replacing it', () => {
    const wrapped = sandboxed(launch, spec())
    expect(wrapped.command).toBe('sandbox-exec')
    expect(wrapped.args.slice(-2)).toEqual(['/bin/echo', 'hello'])
  })

  it('refuses rather than running unconfined when it cannot be applied', () => {
    // The dangerous failure is the silent one: a config that says `seatbelt`
    // and a worker that runs with the whole disk writable.
    expect(() => sandboxed(launch, spec({ platform: 'linux' }))).toThrow(SandboxUnavailableError)
    expect(() => sandboxed(launch, spec({ kind: 'bwrap', platform: 'darwin' }))).toThrow(
      /Linux only/,
    )
  })

  it('builds Linux arguments that keep home read-only and the worktree not', () => {
    const args = bwrapArgs(spec({ kind: 'bwrap', platform: 'linux' }))
    expect(args).toContain('--die-with-parent')
    // Home read-only first, then the worktree bound back over it.
    expect(args.join(' ')).toContain('--ro-bind /Users/someone /Users/someone')
    expect(args.join(' ')).toContain('--bind-try /wt/refunds /wt/refunds')
  })
})

describe('what a worker may write', () => {
  it('is the worktree, the temp directory and build caches', () => {
    const paths = writablePaths(spec())
    expect(paths).toContain('/wt/refunds')
    expect(paths).toContain('/var/folders/xx')
    // A sandbox that breaks `npm install` is one everybody turns off.
    expect(paths).toContain('/Users/someone/.npm')
    expect(paths).toContain('/Users/someone/Library/Caches')
  })

  it("is never the home directory itself, nor Wilco's own state", () => {
    const paths = writablePaths(spec())
    expect(paths).not.toContain('/Users/someone')
    expect(paths).not.toContain('/Users/someone/.wilco')
    expect(paths).not.toContain('/Users/someone/.ssh')
  })

  it('takes extra paths for a toolchain with a cache somewhere unusual', () => {
    expect(writablePaths(spec({ writable: ['/opt/weird'] }))).toContain('/opt/weird')
  })
})

describe('the macOS profile', () => {
  it('narrows writes without touching reads or network', () => {
    const profile = seatbeltProfile(spec())
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath "/wt/refunds")')
  })

  it('names both forms of a path that macOS symlinks', () => {
    // `/tmp` is a symlink to `/private/tmp`, and a rule naming one does not
    // match the other — which fails open, not closed.
    const profile = seatbeltProfile(spec())
    expect(profile).toContain('(subpath "/tmp")')
    expect(profile).toContain('(subpath "/private/tmp")')
    expect(profile).toContain('(subpath "/private/var/folders/xx")')
  })

  it('lets programs write to the device nodes they assume exist', () => {
    expect(seatbeltProfile(spec())).toContain('(literal "/dev/null")')
  })

  it('escapes a path that would otherwise break out of the profile', () => {
    const profile = seatbeltProfile(spec({ worktree: '/wt/od"d' }))
    expect(profile).toContain('(subpath "/wt/od\\"d")')
  })
})

// The only test that proves anything. Everything above asserts what we
// generate; this asserts what the operating system then does with it.
describe.runIf(process.platform === 'darwin')('actually contains a process', () => {
  it('allows the worktree and refuses everything else', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wilco-sbx-wt-'))
    const outside = mkdtempSync(join(tmpdir(), 'wilco-sbx-out-'))
    // Not under /tmp, which is deliberately writable: this stands in for your
    // other repositories and your dotfiles.
    const forbidden = join(outside, '..', `wilco-forbidden-${process.pid}`)
    try {
      const sh = (script: string) =>
        sandboxed({ command: '/bin/sh', args: ['-c', script] }, { kind: 'seatbelt', worktree })

      const inside = sh(`echo ok > ${worktree}/written`)
      await run(inside.command, inside.args)
      expect(existsSync(join(worktree, 'written'))).toBe(true)

      const out = sh(`echo bad > ${join(process.env.HOME ?? '/Users', 'wilco-sbx-probe')}`)
      await expect(run(out.command, out.args)).rejects.toThrow()
      expect(existsSync(join(process.env.HOME ?? '/Users', 'wilco-sbx-probe'))).toBe(false)
      expect(existsSync(forbidden)).toBe(false)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still lets a normal program run', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wilco-sbx-wt-'))
    try {
      // Reads, /dev/null and exec all have to keep working or nothing does.
      const wrapped = sandboxed(
        { command: '/bin/sh', args: ['-c', 'cat /etc/hosts > /dev/null && echo fine'] },
        { kind: 'seatbelt', worktree },
      )
      const { stdout } = await run(wrapped.command, wrapped.args)
      expect(stdout.trim()).toBe('fine')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})
