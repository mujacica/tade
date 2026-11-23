import { describe, expect, it, vi } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { diffIn } from '../../src/checkout-look.ts'
import type { Change } from '../../src/frame.ts'
import { AT_ONCE, type ChangesLook, changesFrom, FILE_MS } from '../../src/wire/web-changes.ts'

// The window's half of an agent's changes from away: the CHANGES section's
// own list, and each file's diff by the same git question Show changes asks —
// over a real repository, because a diff is git's answer and nothing else.

function lookAt(
  root: string | null,
  listed: readonly Change[] | null,
  diffAt: ChangesLook['diffAt'] = diffIn,
): ChangesLook {
  return {
    worktreeOf: () => root,
    baseOf: () => 'main',
    changesAt: () => listed,
    diffAt,
  }
}

const change = (path: string, mark = 'M'): Change => ({ path, mark, added: 1, removed: 0 })

describe('an agent’s changes, as the window reads them for a device', () => {
  it('is every file it lists, each with git’s own diff of it measured from its base', async () => {
    const repo = mkrepo()
    repo.commit('two files', { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    repo.write({ 'a.txt': 'one\nmore\n', 'c.txt': 'new\n' })
    const notes: Error[] = []
    const half = changesFrom({
      live: () => lookAt(repo.root, [change('a.txt'), change('c.txt', '?')]),
      known: () => [],
      note: (err) => notes.push(err),
    })
    const read = await half.read('fixture/task')
    if (read === null || typeof read === 'string') throw new Error(`no files: ${read}`)
    expect(read.base).toBe('main')
    expect(read.files.map((one) => [one.path, one.mark])).toEqual([
      ['a.txt', 'M'],
      ['c.txt', '?'],
    ])
    expect(read.files[0]?.text).toContain('+more')
    // An untracked file is all new, as the window's own diff shows it.
    expect(read.files[1]?.text).toContain('+new')
    expect(notes).toEqual([])
  })

  it('says a task it has no tree for, one nobody looked at, and one that changed nothing', async () => {
    const at = (look: ChangesLook | null) =>
      changesFrom({ live: () => look, known: () => [], note: () => {} }).read('x/y')
    expect(await at(null)).toBeNull()
    expect(await at(lookAt(null, []))).toBeNull()
    expect(await at(lookAt('/nowhere', null))).toBe('not looked')
    expect(await at(lookAt('/nowhere', []))).toBe('none')
  })

  it('asks git a few files at a time, and a file past its deadline is unread on its own, said at the machine', async () => {
    const repo = mkrepo()
    const names = Array.from({ length: 10 }, (_, n) => `f${n}.txt`)
    repo.commit('ten files', Object.fromEntries(names.map((name) => [name, 'was\n'])))
    repo.write(Object.fromEntries(names.map((name) => [name, 'is\n'])))
    let now = 0
    let most = 0
    let answered = 0
    let allAnswered = () => {}
    const othersAnswered = new Promise<void>((done) => {
      allAnswered = done
    })
    const notes: Error[] = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const half = changesFrom({
        live: () =>
          // Every file is git's own answer; f3's is one that never comes, which
          // is what the deadline is for, so it waits on nothing.
          lookAt(
            repo.root,
            names.map((name) => change(name)),
            async (root, base, path) => {
              if (path === 'f3.txt') return new Promise<string | null>(() => {})
              now += 1
              most = Math.max(most, now)
              const text = await diffIn(root, base, path)
              now -= 1
              answered += 1
              if (answered === names.length - 1) allAnswered()
              return text
            },
          ),
        known: () => [],
        note: (err) => notes.push(err),
      })
      const reading = half.read('x/y')
      await othersAnswered
      await vi.advanceTimersByTimeAsync(FILE_MS)
      const read = await reading
      if (read === null || typeof read === 'string') throw new Error(`no files: ${read}`)
      expect(most).toBeLessThanOrEqual(AT_ONCE)
      expect(read.files).toHaveLength(10)
      expect(read.files[3]?.text).toBe('unread')
      expect(read.files.filter((one) => one.text === 'unread')).toHaveLength(1)
      expect(read.files[0]?.text).toContain('+is')
      expect(notes.map((one) => one.message)).toEqual([
        "the away view could not read x/y's f3.txt: git took more than 10s",
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
