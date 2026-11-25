import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { helperAt, helperProblem } from '../src/helper.ts'

// `posix_spawnp failed.` is what node-pty says when its helper cannot be
// executed, and it is the whole of what it says. These hold the sentence that
// replaces it.

const where = mkdtempSync(join(tmpdir(), 'tade-helper-'))
afterAll(() => rmSync(where, { recursive: true, force: true }))

function helper(name: string, mode: number): string {
  const path = join(where, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, mode)
  return path
}

describe('node-pty’s spawn-helper', () => {
  it('is nothing to say about when it can be run', () => {
    expect(helperProblem(helper('runnable', 0o755))).toBeNull()
  })

  it('is nothing to say about where there is none', () => {
    expect(helperProblem(null)).toBeNull()
  })

  it('names the file and the commands that install it again when the bit is gone', () => {
    const path = helper('inert', 0o644)
    const said = helperProblem(path)
    expect(said).toContain('posix_spawnp failed.')
    expect(said).toContain(`chmod +x ${path}`)
    expect(said).toContain('npm install -g tade-sh')
    expect(said).toContain('pnpm add -g tade-sh')
    // bun builds better-sqlite3 over its prebuilds unless told to run nothing.
    expect(said).toContain('bun add -g --ignore-scripts tade-sh')
    // Nothing holds an install script any more, so nothing approves one.
    expect(said).not.toContain('approve-builds')
    expect(said).not.toContain('--allow-scripts')
    expect(said).not.toContain('npx')
  })

  // Run with npx, the cache entry is the install: the same version is answered
  // from it, so it has to be forgotten first, and a global install would be a
  // second copy nothing runs.
  it('names the npx cache entry to forget where that is where it is', () => {
    const cache = join(where, '_npx', '5c1d2e3f4a5b6c7d', 'node_modules')
    mkdirSync(cache, { recursive: true })
    const path = join(cache, 'spawn-helper')
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o644)
    const said = helperProblem(path)
    expect(said).toContain(`chmod +x ${path}`)
    expect(said).toContain('npm cache npx rm 5c1d2e3f4a5b6c7d && npx tade-sh')
    expect(said).not.toContain('npm install -g')
  })
})

describe('finding it', () => {
  it('looks where node-pty looks, and finds a file or nothing at all', () => {
    const found = helperAt()
    if (found !== null) expect(existsSync(found)).toBe(true)
  })

  // macOS execs through the helper, and it is in the platform's own package,
  // packed executable: the install that put it there ran no script.
  it.runIf(process.platform === 'darwin')('finds it in this platform’s package, runnable', () => {
    const found = helperAt()
    expect(found).toContain(`@lydell/node-pty-darwin-${process.arch}/prebuilds/`)
    expect(helperProblem(found)).toBeNull()
  })

  // A node-pty that Debian's node-gyp compiled links the system Node's
  // `libnode.so`: under an official Node it loads, does the work and aborts on
  // exit, with nothing to catch. Tade has no door for that because nothing
  // compiles node-pty any more — this is what holds it, on the real binary.
  it('loads a binary that links nothing of a system Node’s', () => {
    const wrapper = createRequire(import.meta.url).resolve('@lydell/node-pty')
    const lib = createRequire(wrapper).resolve(
      `@lydell/node-pty-${process.platform}-${process.arch}`,
    )
    const binary = join(dirname(dirname(lib)), 'prebuilds', `${process.platform}-${process.arch}`)
    const bytes = readFileSync(join(binary, 'pty.node'))
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(bytes.includes('libnode.so')).toBe(false)
  })

  it('finds nothing for a platform nobody packed one for', () => {
    expect(helperAt('freebsd', 'x64')).toBeNull()
  })

  it('knows Windows spawns through ConPTY and has no helper', () => {
    expect(helperAt('win32', 'x64')).toBeNull()
  })
})
