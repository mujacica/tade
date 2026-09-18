import { git } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { parseDiff } from '../src/diff.ts'

// A diff, read from real git output rather than a string somebody typed.

describe('parseDiff', () => {
  it('reads what git says about a changed file, line numbers and all', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'app.ts': 'one\ntwo\nthree\nfour\nfive\n' })
    const base = repo.head()
    repo.write({ 'app.ts': 'one\nTWO\nthree\nfour\nfive\nsix\n' })

    const out = await git(repo.root, ['diff', '--no-color', '-U3', base, '--', 'app.ts'])
    const diff = parseDiff(out.stdout)

    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(1)
    expect(diff.lines[0]?.kind).toBe('hunk')
    expect(diff.lines.find((line) => line.kind === 'remove')).toEqual({
      kind: 'remove',
      old: 2,
      new: null,
      text: 'two',
    })
    expect(diff.lines.find((line) => line.text === 'six')).toEqual({
      kind: 'add',
      old: null,
      new: 6,
      text: 'six',
    })
    expect(diff.lines.find((line) => line.text === 'three')).toMatchObject({ old: 3, new: 3 })
  })

  it('knows a binary file has nothing to show', () => {
    expect(parseDiff('Binary files a/logo.png and b/logo.png differ\n').binary).toBe(true)
  })
})
