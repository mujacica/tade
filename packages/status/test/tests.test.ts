import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { readRecord, readTests, testsPath, writeTests } from '../src/tests.ts'

// A test result is about one commit. Everything here is about refusing to let
// an old green run vouch for code it never saw.

const record = (over: Partial<Parameters<typeof writeTests>[1]> = {}) => ({
  status: 'pass' as const,
  commit: 'abc123',
  command: 'pnpm test',
  at: '2026-09-13T09:00:00.000Z',
  output: '',
  ...over,
})

describe('readTests', () => {
  it('knows nothing when nothing has been run', async () => {
    expect(await readTests(tmp('tade-tests-'), 'abc123')).toBe('unknown')
  })

  it('reports the result for the commit it ran against', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record())
    expect(await readTests(worktree, 'abc123')).toBe('pass')

    await writeTests(worktree, record({ status: 'fail' }))
    expect(await readTests(worktree, 'abc123')).toBe('fail')
  })

  it('refuses to vouch for a commit it never saw', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record({ commit: 'old' }))
    // Green three commits ago says nothing about this one, and a stale pass is
    // worse than no result at all: it would let `review` mean verified.
    expect(await readTests(worktree, 'abc123')).toBe('unknown')
  })

  it('knows nothing when there is no commit to be about', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record())
    expect(await readTests(worktree, null)).toBe('unknown')
  })
})

describe('readRecord', () => {
  it('round-trips what was written', async () => {
    const worktree = tmp('tade-tests-')
    await writeTests(worktree, record({ output: 'boom' }))
    expect(await readRecord(worktree)).toMatchObject({ status: 'pass', output: 'boom' })
  })

  it('returns null on a shape it does not know, rather than throwing', async () => {
    const worktree = tmp('tade-tests-')
    mkdirSync(join(worktree, '.tade'), { recursive: true })
    for (const bad of ['not json', '{}', '{"status":"maybe","commit":"x"}', '[]', 'null']) {
      writeFileSync(testsPath(worktree), bad)
      expect(await readRecord(worktree)).toBeNull()
      expect(await readTests(worktree, 'abc123')).toBe('unknown')
    }
  })

  it('fills in the parts it can live without', async () => {
    const worktree = tmp('tade-tests-')
    mkdirSync(join(worktree, '.tade'), { recursive: true })
    writeFileSync(testsPath(worktree), '{"status":"pass","commit":"abc123"}')
    expect(await readRecord(worktree)).toEqual({
      status: 'pass',
      commit: 'abc123',
      command: '',
      at: '',
      output: '',
    })
  })
})
