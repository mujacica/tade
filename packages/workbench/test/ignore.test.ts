import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../test/fixtures/mkrepo.ts'
import { ignoreRemoval, removeOwnIgnore } from '../src/ignore.ts'

// Against real repositories, because the question is what somebody's file
// looks like afterwards, and half of these are files Tade wrote into one.

/** The block Tade used to append, exactly as the repositories that have it have it. */
const WRITTEN = [
  '# Tade writes its own bookkeeping under .tade/ -- task files, pasted',
  '# attachments, check runs, locks -- and none of it is the project’s: it is',
  '# one machine’s and one person’s.',
  '# Added by Tade the first time it worked here; delete it and it stays deleted.',
  '/.tade/*',
  '',
].join('\n')

describe('taking Tade’s own rule back out', () => {
  it('removes the block it wrote, and leaves everything else where it was', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    writeFileSync(path, `node_modules/\ndist/\n\n${WRITTEN}`)

    const done = await removeOwnIgnore(repo.root)
    expect(done.removed).toEqual(['/.tade/*'])
    expect(readFileSync(path, 'utf8')).toBe('node_modules/\ndist/\n')
  })

  it('removes the two-line version, exception and all', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    writeFileSync(
      path,
      [
        '# Added by Tade the first time it worked here.',
        '/.tade/*',
        '!/.tade/checks.yaml',
        '',
      ].join('\n'),
    )
    const done = await removeOwnIgnore(repo.root)
    expect(done.removed).toEqual(['/.tade/*', '!/.tade/checks.yaml'])
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('leaves a rule somebody wrote themselves, because it is theirs', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    // No comment above it saying who put it there: this is somebody's own
    // line, and Tade taking it out would be Tade deleting their work.
    writeFileSync(path, 'node_modules/\n/.tade/*\n')
    const done = await removeOwnIgnore(repo.root)
    expect(done.removed).toEqual([])
    expect(done.because).toBe('none of its rules are in there')
    expect(readFileSync(path, 'utf8')).toBe('node_modules/\n/.tade/*\n')
  })

  it('is idempotent: once the lines are gone it writes nothing', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    writeFileSync(path, `dist/\n\n${WRITTEN}`)
    await removeOwnIgnore(repo.root)
    const after = readFileSync(path, 'utf8')
    const again = await removeOwnIgnore(repo.root)
    expect(again.removed).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(after)
  })

  it('says so rather than throwing where there is no ignore file at all', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'tade-norepo-'))
    const done = await removeOwnIgnore(plain)
    expect(done.removed).toEqual([])
    expect(done.because).toMatch(/no \.gitignore/)
    expect(existsSync(join(plain, '.gitignore'))).toBe(false)
  })

  it('never writes a .gitignore into a project that has none', async () => {
    const repo = mkrepo()
    await removeOwnIgnore(repo.root)
    expect(existsSync(join(repo.root, '.gitignore'))).toBe(false)
    // Which is the point of the whole move: a project Tade has worked in is
    // indistinguishable from one it has never seen.
    expect(runGit(repo.root, 'status', '--porcelain').trim()).toBe('')
  })
})

describe('ignoreRemoval', () => {
  it('is null for a file with nothing of Tade’s in it', () => {
    expect(ignoreRemoval('node_modules/\ndist/\n')).toBeNull()
    expect(ignoreRemoval('')).toBeNull()
  })

  it('reads a line somebody indented as the line it is', () => {
    const made = ignoreRemoval('# Tade put this here\n   /.tade/*   \n')
    expect(made?.removed).toEqual(['/.tade/*'])
    expect(made?.text).toBe('')
  })

  it('takes only the comment block directly above, never the one before it', () => {
    const made = ignoreRemoval(
      ['# my own note about builds', 'dist/', '', '# Added by Tade', '/.tade/*', ''].join('\n'),
    )
    expect(made?.text).toBe('# my own note about builds\ndist/\n')
  })

  it('keeps the rest of the file byte for byte, and closes the hole', () => {
    const made = ignoreRemoval(['a/', '', '# Tade', '/.tade/*', '', 'b/', ''].join('\n'))
    expect(made?.text).toBe('a/\n\nb/\n')
  })
})
