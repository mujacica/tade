import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { commitStatsFrom, readCommits } from '../src/commits.ts'

// Real git, never a mock: the whole point of this parser is that it survives
// what git actually prints, which is where `--numstat`'s tabs, its `-` for a
// binary file and its blank line between records all come from.

describe('commitStatsFrom', () => {
  it('reads nothing out of nothing', () => {
    expect(commitStatsFrom('')).toEqual([])
  })

  it('counts a binary file as changed and as no lines', () => {
    const seen = commitStatsFrom(
      '\u0001abc123\u00021700000000\u0002shop/logo\u0002\n-\t-\tlogo.png\n12\t3\tsrc/app.ts\n',
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sha: 'abc123', task: 'shop/logo', added: 12, removed: 3 })
    // Two files, and only the text one contributed lines: inventing a line
    // count for a PNG would put noise into every total it appears in.
    expect(seen[0]?.files).toBe(2)
  })

  it('leaves a commit with no trailer belonging to nobody', () => {
    const seen = commitStatsFrom('\u0001def456\u00021700000000\u0002\u0002\n1\t1\tREADME.md\n')
    expect(seen[0]?.task).toBeNull()
  })

  it('takes the first of several trailers, as the window does', () => {
    const seen = commitStatsFrom(
      '\u0001aaa\u00021700000000\u0002shop/one\u0003shop/two\u0002\n1\t0\ta.ts\n',
    )
    expect(seen[0]?.task).toBe('shop/one')
  })
})

describe('readCommits', () => {
  it('reads what a real commit changed, and whose it is', async () => {
    const repo = mkrepo()
    repo.commit('add a thing\n\nTade-Task: shop/thing', {
      'counted.ts': 'one\ntwo\nthree\n',
    })

    const seen = await readCommits(repo.root, { limit: 10 })
    const mine = seen.find((one) => one.task === 'shop/thing')
    expect(mine).toBeDefined()
    expect(mine?.added).toBe(3)
    expect(mine?.removed).toBe(0)
    expect(mine?.files).toBe(1)
    expect(mine?.at).toBeGreaterThan(0)
  })

  it('answers empty for somewhere that is not a repository, rather than throwing', async () => {
    // Counting things may never be the reason a window fails to open.
    await expect(readCommits('/definitely/not/here', { limit: 10 })).resolves.toEqual([])
  })
})
