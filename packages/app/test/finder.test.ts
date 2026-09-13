import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { filesFrom, grep, listFiles, matchesFrom } from '../src/finder.ts'

// Finding files and lines, against a real repository: git decides what is
// ignored, so a fixture that did not use git would be kinder than reality.

describe('listing files', () => {
  it('lists tracked and new files, and leaves out what is ignored', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'src/app.ts': 'x\n', '.gitignore': 'dist/\n' })
    writeFileSync(join(repo.root, 'notes.md'), 'new\n')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(repo.root, 'dist'))
    writeFileSync(join(repo.root, 'dist', 'app.js'), 'built\n')
    const files = await listFiles(repo.root)
    expect(files).toContain('src/app.ts')
    expect(files).toContain('notes.md')
    expect(files).not.toContain('dist/app.js')
  })

  it('reads git output separated by NULs, and stops at a limit', () => {
    expect(filesFrom('a.ts\0b c.ts\0\0')).toEqual(['a.ts', 'b c.ts'])
    expect(filesFrom('a\0b\0c\0', 2)).toEqual(['a', 'b'])
  })
})

describe('looking inside files', () => {
  it('finds lines, any case, in tracked and new files, with their numbers', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'src/ledger.ts': 'const a = 1\nexport function RefundTwice() {}\n' })
    writeFileSync(join(repo.root, 'draft.ts'), '// refundtwice again\n')
    const root = { path: repo.root, label: 'app', task: null }
    const found = await grep(root, 'refundtwice')
    expect(found.map((match) => [match.path, match.line])).toEqual(
      expect.arrayContaining([
        ['src/ledger.ts', 2],
        ['draft.ts', 1],
      ]),
    )
    expect(found.find((match) => match.path === 'src/ledger.ts')?.text).toBe(
      'export function RefundTwice() {}',
    )
  })

  it('treats nothing found as an answer', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'a.ts': 'x\n' })
    expect(await grep({ path: repo.root, label: 'app', task: null }, 'nowhere-at-all')).toEqual([])
  })

  it('reads a line that has colons and NULs in the right places', () => {
    const root = { path: '/r', label: 'r', task: null }
    expect(matchesFrom('a.ts\x0012\x00x: y\nbroken\n', root, 10)).toEqual([
      { root, path: 'a.ts', line: 12, text: 'x: y' },
    ])
  })
})
