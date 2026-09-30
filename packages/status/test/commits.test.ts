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

  it('reads a trailer in the last paragraph, and nobody from one stranded above it', async () => {
    // The shape of the message decides whether the work has an owner, because
    // git parses only the *last paragraph* as trailers. `trailerTell`
    // (`packages/core/src/compose.ts`) used to say only "on a line of its own,
    // after a blank line": an agent that obeyed that and then let its harness
    // append `Co-Authored-By:` after another blank line left `Tade-Task:`
    // alone in a paragraph above, where git drops it. The commit succeeds, the
    // hook passes, and the window draws plainly-owned work as nobody's — which
    // is how 38 of this repository's own last 200 commits were lost.
    const repo = mkrepo()
    repo.commit(
      'together\n\nCo-Authored-By: A N Other <other@example.com>\nTade-Task: shop/together',
      {
        'together.ts': 'one\n',
      },
    )
    repo.commit(
      'stranded\n\nTade-Task: shop/stranded\n\nCo-Authored-By: A N Other <other@example.com>',
      {
        'stranded.ts': 'one\ntwo\n',
      },
    )

    const seen = await readCommits(repo.root, { limit: 10 })
    expect(seen.find((one) => one.task === 'shop/together')).toBeDefined()
    expect(seen.find((one) => one.task === 'shop/stranded')).toBeUndefined()
    // It is not missing — it is there, and it belongs to nobody. Two lines is
    // the only thing that tells it apart once its trailer is gone.
    expect(seen.some((one) => one.task === null && one.added === 2)).toBe(true)
  })

  it('answers empty for somewhere that is not a repository, rather than throwing', async () => {
    // Counting things may never be the reason a window fails to open.
    await expect(readCommits('/definitely/not/here', { limit: 10 })).resolves.toEqual([])
  })
})
