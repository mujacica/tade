import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('names the file and the two commands when the bit is gone', () => {
    const path = helper('inert', 0o644)
    const said = helperProblem(path)
    expect(said).toContain('posix_spawnp failed.')
    expect(said).toContain(`chmod +x ${path}`)
    expect(said).toContain('pnpm approve-builds -g')
    expect(said).toContain('--allow-scripts=tade-sh,node-pty')
  })
})

describe('finding it', () => {
  it('looks where node-pty looks, and finds a file or nothing at all', () => {
    const found = helperAt()
    if (found !== null) expect(existsSync(found)).toBe(true)
  })

  it('knows Windows spawns through ConPTY and has no helper', () => {
    expect(helperAt('win32', 'x64')).toBeNull()
  })
})
