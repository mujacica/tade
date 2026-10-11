import { describe, expect, it } from 'vitest'
import { pooled } from '../src/pool.ts'

describe('pooled', () => {
  it('never runs more than the limit at once, however many there are', async () => {
    let running = 0
    let peak = 0
    // A barrier rather than a sleep: nothing counts what the machine managed
    // in a stretch of wall clock, so the pool is held full until it is
    // provably full and then let go all at once.
    let open = () => {}
    const full = new Promise<void>((resolve) => {
      open = resolve
    })
    const out = await pooled(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (i) => {
        running++
        if (running > peak) peak = running
        if (running === 4) open()
        await full
        running--
        return i * 2
      },
    )
    expect(peak).toBe(4)
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2))
  })

  it('answers in the order it was asked, not the order it finished', async () => {
    const out = await pooled(['slow', 'quick', 'slower'], 3, async (name) => {
      if (name !== 'quick') await new Promise((resolve) => setTimeout(resolve, 5))
      return name.length
    })
    expect(out).toEqual([4, 5, 6])
  })

  it('does no work and asks for no lanes when there is nothing to do', async () => {
    let called = 0
    expect(
      await pooled([], 4, async () => {
        called++
        return 1
      }),
    ).toEqual([])
    expect(called).toBe(0)
  })

  it('opens no more lanes than there are items, and at least one whatever it is told', async () => {
    expect(await pooled([1, 2], 9, async (n) => n)).toEqual([1, 2])
    expect(await pooled([1, 2], 0, async (n) => n)).toEqual([1, 2])
    expect(await pooled([1, 2], -4, async (n) => n)).toEqual([1, 2])
  })

  it('hands a throw back rather than swallowing it', async () => {
    // Which is why `probeOf` catches: one worktree must never be able to end
    // a whole scan, and the pool is not the place that decides so.
    await expect(
      pooled([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('that worktree')
        return n
      }),
    ).rejects.toThrow('that worktree')
  })
})
