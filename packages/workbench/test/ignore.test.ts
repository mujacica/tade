import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_PATH } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../test/fixtures/mkrepo.ts'
import { ensureIgnored, IGNORE_RULES, ignoreAddition } from '../src/ignore.ts'

// Against real repositories, because the whole question is what git does with
// a pattern — and the one that matters, re-including a file under a folder
// whose contents are excluded, is exactly what a hand-rolled matcher would
// get wrong.

// `check-ignore` exits 1 for a path it does not ignore, which `runGit` throws
// over: not an answer of "no" until it is turned into one.
const ignored = (root: string, path: string): boolean => {
  try {
    return runGit(root, 'check-ignore', '--no-index', '--', path).trim() === path
  } catch {
    return false
  }
}

describe('ignoring what Tade writes under a project', () => {
  it('denies everything under .tade and keeps the checks manifest', async () => {
    const repo = mkrepo()
    const done = await ensureIgnored(repo.root)
    expect(done.added).toEqual(IGNORE_RULES)
    for (const path of [
      '.tade/tasks/a-task/task.yaml',
      '.tade/tasks/a-task/design.md',
      '.tade/task.yaml',
      '.tade/context.md',
      '.tade/checks.jsonl',
      '.tade/checks.running.json',
      '.tade/checks.lock',
      '.tade/tests.json',
      '.tade/attachments/pasted.png',
    ]) {
      expect(ignored(repo.root, path), path).toBe(true)
    }
    // The one file a person writes and CI is generated from.
    expect(ignored(repo.root, MANIFEST_PATH)).toBe(false)
    // And nothing outside Tade's own folder.
    expect(ignored(repo.root, 'src/index.ts')).toBe(false)
  })

  it('leaves nothing of Tade’s for `git add -A` to sweep up', async () => {
    const repo = mkrepo()
    await ensureIgnored(repo.root)
    repo.write({
      '.tade/tasks/a-task/task.yaml': 'id: p/a-task\n',
      '.tade/tasks/a-task/design.md': '# a plan\n',
      '.tade/attachments/pasted.png': 'not really a png',
      '.tade/checks.jsonl': '{}\n',
      [MANIFEST_PATH]: 'checks: []\n',
    })
    runGit(repo.root, 'add', '-A')
    const staged = runGit(repo.root, 'diff', '--cached', '--name-only').trim().split('\n')
    expect(staged.sort()).toEqual(['.gitignore', MANIFEST_PATH])
  })

  it('appends to what somebody wrote, and never twice', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    writeFileSync(path, 'node_modules/\ndist/\n')
    const first = await ensureIgnored(repo.root)
    expect(first.added).toEqual(IGNORE_RULES)
    const after = readFileSync(path, 'utf8')
    expect(after.startsWith('node_modules/\ndist/\n')).toBe(true)

    const again = await ensureIgnored(repo.root)
    expect(again.added).toEqual([])
    expect(again.because).toBe('the rules were already there')
    expect(readFileSync(path, 'utf8')).toBe(after)
  })

  it('starts a new line in a file that ended without one', async () => {
    const repo = mkrepo()
    const path = join(repo.root, '.gitignore')
    writeFileSync(path, 'dist/')
    await ensureIgnored(repo.root)
    const lines = readFileSync(path, 'utf8').split('\n')
    expect(lines[0]).toBe('dist/')
    expect(lines).toContain(IGNORE_RULES[0])
  })

  it('says nothing when the project already ignores them its own way', async () => {
    const repo = mkrepo()
    writeFileSync(join(repo.root, '.gitignore'), '.tade/*\n!.tade/checks.yaml\n')
    const done = await ensureIgnored(repo.root)
    expect(done.added).toEqual([])
    expect(done.because).toBe('this project already ignores them its own way')
  })

  it('leaves a project that ignores all of .tade alone, and says what that costs', async () => {
    const repo = mkrepo()
    writeFileSync(join(repo.root, '.gitignore'), '.tade/\n')
    const done = await ensureIgnored(repo.root)
    // The exception cannot be added under somebody else's rule -- git never
    // descends into an ignored folder -- and the line is theirs to change.
    expect(done.added).toEqual([])
    expect(done.because).toContain('/.tade/*')
    expect(readFileSync(join(repo.root, '.gitignore'), 'utf8')).toBe('.tade/\n')
    expect(ignored(repo.root, MANIFEST_PATH)).toBe(true)
  })

  it('writes the rules where git cannot be asked, rather than taking silence for yes', async () => {
    // A directory that is no repository: `check-ignore` fails instead of
    // answering, and a failure to answer must never read as "already
    // arranged" — the rules are written, and they are right when it becomes
    // one.
    const plain = mkdtempSync(join(tmpdir(), 'tade-norepo-'))
    const done = await ensureIgnored(plain)
    expect(done.added).toEqual(IGNORE_RULES)
  })

  it('comes back with a reason rather than throwing when it cannot write', async () => {
    const done = await ensureIgnored(join(mkdtempSync(join(tmpdir(), 'tade-gone-')), 'nowhere'))
    expect(done.added).toEqual([])
    expect(done.because).toMatch(/could not be written/)
  })
})

describe('ignoreAddition', () => {
  it('is null once every rule is a line in the file', () => {
    expect(ignoreAddition(IGNORE_RULES.join('\n'))).toBeNull()
  })

  it('reads a line somebody indented as the line it is', () => {
    expect(ignoreAddition(IGNORE_RULES.map((rule) => `  ${rule}  `).join('\n'))).toBeNull()
  })

  it('adds only what is missing', () => {
    const half = ignoreAddition(`${IGNORE_RULES[0]}\n`)
    expect(half?.added).toEqual([IGNORE_RULES[1]])
  })

  it('writes the file whole when there was none', () => {
    const made = ignoreAddition('')
    expect(made?.text.startsWith('#')).toBe(true)
    expect(made?.text.endsWith('\n')).toBe(true)
  })
})
