import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { spaceLeft, watchDisk } from '../src/disk.ts'

// Whether a failing check's disk was full: the share free, from the
// filesystem itself, and a watch that waits on its look only so long.

const NO_ROOM = 'fatal: No space left on device\n'

describe('the share of a disk free', () => {
  it('is a share between nought and one, read from the filesystem a folder is on', async () => {
    const share = await spaceLeft(tmpdir())
    expect(share).not.toBeNull()
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThanOrEqual(1)
  })

  it('throws where there is no filesystem to ask', async () => {
    await expect(spaceLeft('/tade-no-such-folder/at-all')).rejects.toThrow(/ENOENT/)
  })
})

describe('a look at the disk still in flight', () => {
  it('is waited for, and its answer is the answer', async () => {
    let answer: (share: number) => void = () => {}
    const watch = watchDisk(() => new Promise((done) => (answer = done)), ['/x'])
    watch.heard(NO_ROOM)
    const asked = watch.full(60_000)
    answer(0.001)
    expect(await asked).toEqual({ full: true, trouble: null })
  })

  it('is given up on after the time it is given, and is not full', async () => {
    const watch = watchDisk(() => new Promise(() => {}), ['/x'])
    watch.heard(NO_ROOM)
    expect(await watch.full(20)).toEqual({ full: false, trouble: null })
  })
})
