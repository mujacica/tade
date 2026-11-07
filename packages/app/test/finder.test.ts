import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { filesFrom, grep, listDocuments, listFiles, matchesFrom } from '../src/finder.ts'

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

describe('listing the documents tasks produced', () => {
  it('lists every file below the folder, in order, and leaves out hidden ones', async () => {
    const { mkdirSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'tade-documents-'))
    mkdirSync(join(dir, 'research', 'notes'), { recursive: true })
    mkdirSync(join(dir, 'plan', '.cache'), { recursive: true })
    writeFileSync(join(dir, 'research', 'ROLEPLAY-SYSTEMS.md'), '# Roleplay\n')
    writeFileSync(join(dir, 'research', 'notes', 'sources.md'), 'links\n')
    writeFileSync(join(dir, 'plan', 'PLAN.md'), '# Plan\n')
    writeFileSync(join(dir, 'plan', '.DS_Store'), '')
    writeFileSync(join(dir, 'plan', '.cache', 'x'), '')
    expect(await listDocuments(dir)).toEqual([
      'plan/PLAN.md',
      'research/ROLEPLAY-SYSTEMS.md',
      'research/notes/sources.md',
    ])
  })

  it('caps each task on its own, so one folder of frames takes nothing from the next', async () => {
    const { mkdirSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'tade-documents-'))
    mkdirSync(join(dir, 'a-frames', 'run'), { recursive: true })
    mkdirSync(join(dir, 'z-research'))
    writeFileSync(join(dir, 'a-frames', 'README.md'), '')
    for (const n of [1, 2, 3]) writeFileSync(join(dir, 'a-frames', 'run', `${n}.jpg`), '')
    writeFileSync(join(dir, 'z-research', 'MARKET.md'), '')
    // Nearest the top first, so what a cap cuts is what is buried deepest.
    expect(await listDocuments(dir, 2)).toEqual([
      'a-frames/README.md',
      'a-frames/run/1.jpg',
      'z-research/MARKET.md',
    ])
  })

  it('finds nothing in a folder that is not there', async () => {
    expect(await listDocuments('/no/such/documents/folder')).toEqual([])
  })
})
