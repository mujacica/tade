import type { LaneId } from '@tade/core'
import { ECHO_CHILD, until } from '@tade/drivers-core/conformance'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// The emulators run on a thread of their own, and a thread can die. What it
// may never do is take the lanes with it, or leave a pane that says its lane
// is empty: a screen nobody can read any more is the last one somebody could,
// and the person is told what happened, because a pane redrawn or frozen
// looks like nothing went wrong at all.

const DYING = new URL('./fixtures/dying-emulators.ts', import.meta.url)
const line = (s: string) => new TextEncoder().encode(`${s}\n`)

describe('when the emulators die', () => {
  let driver: PtyDriver
  afterEach(async () => {
    await driver.shutdown()
  })

  function opened(troubles: Error[]) {
    driver = new PtyDriver({ emulators: DYING, trouble: (problem) => troubles.push(problem) })
    const id = 'death/lane' as LaneId
    return driver
      .open({
        id,
        cwd: process.cwd(),
        command: process.execPath,
        args: [ECHO_CHILD],
        cols: 80,
        rows: 24,
      })
      .then(() => id)
  }
  const shows = (id: LaneId, text: string) =>
    until(async () => (await driver.capture(id, { lines: 50 })).includes(text))

  it('starts them again, and every screen is drawn afresh from what its lane printed', async () => {
    const troubles: Error[] = []
    const id = await opened(troubles)
    await shows(id, 'ready')
    await driver.write(id, line('before'))
    await shows(id, 'got:before')

    await driver.write(id, line('emulators, die'))
    await until(() => troubles.length === 1)
    expect(troubles[0]?.message).toContain('the emulator choked on what it was shown')
    expect(troubles[0]?.message).toContain('and were started again')

    // Everything the lane printed is back — including the line the old thread
    // died before it could show — and it carries on from there.
    await shows(id, 'got:emulators, die')
    expect(await driver.capture(id, { lines: 50 })).toContain('got:before')
    await driver.write(id, line('after'))
    await shows(id, 'got:after')
    // The program never noticed: it is this thread's, not theirs.
    expect((await driver.get(id))?.alive).toBe(true)
    expect((await driver.screen(id)).lines).toBeGreaterThan(3)
  }, 30_000)

  it('stops starting them once they keep dying, and every pane keeps what it last showed', async () => {
    const troubles: Error[] = []
    const id = await opened(troubles)
    await shows(id, 'ready')
    await driver.write(id, line('before'))
    await shows(id, 'got:before')

    // Three lives, and each death is one more line it printed.
    for (let death = 1; death <= 4; death++) {
      await driver.write(id, line(`emulators, die ${death}`))
      await until(() => troubles.length === death)
      if (death < 4) await shows(id, `got:emulators, die ${death}`)
    }
    expect(troubles.slice(0, 3).every((t) => t.message.includes('and were started again'))).toBe(
      true,
    )
    expect(troubles[3]?.message).toContain('were not started again')

    // Cannot tell, which is not the same as nothing: the last screen there was,
    // and the numbers beside it — at once, not after a wait for a thread that
    // is never coming back.
    const started = performance.now()
    const shown = await driver.capture(id, { lines: 50 })
    expect(shown).toContain('got:before')
    expect(shown).toContain('got:emulators, die 3')
    expect((await driver.screen(id)).lines).toBeGreaterThan(3)
    expect(performance.now() - started).toBeLessThan(100)
    // A question it was never asked before is answered from the same screen,
    // cut to what was asked, rather than not at all.
    expect((await driver.capture(id, { lines: 2 })).split('\n')).toHaveLength(2)

    // And the lane itself is untouched: it still hears what is typed.
    const heard: string[] = []
    driver.onOutput(id, (chunk) => heard.push(Buffer.from(chunk).toString()))
    await driver.write(id, line('still here'))
    await until(() => heard.join('').includes('got:still here'))
  }, 30_000)

  // A thread that cannot be started at all: a file that is not there — a
  // tarball staged without it — or a place no worker can be started from. The
  // lane opens and runs all the same, and nothing about its screen is made up.
  for (const [what, where] of [
    ['a file that is not there', new URL('./fixtures/nowhere.ts', import.meta.url)],
    ['a place no thread starts from', new URL('https://example.com/emulators.js')],
  ] as const) {
    it(`opens the lane anyway when the thread is ${what}, and says so`, async () => {
      const troubles: Error[] = []
      driver = new PtyDriver({ emulators: where, trouble: (problem) => troubles.push(problem) })
      const id = 'death/never' as LaneId
      const handle = await driver.open({
        id,
        cwd: process.cwd(),
        command: process.execPath,
        args: [ECHO_CHILD],
        cols: 80,
        rows: 24,
      })
      expect(handle.alive).toBe(true)
      await until(() => troubles.at(-1)?.message.includes('were not started again') ?? false)
      // Nothing was ever known about this screen, and that is what is said —
      // not an empty one, and not after a wait for a thread that is not coming.
      await expect(driver.capture(id, { lines: 5 })).rejects.toThrow(/cannot tell/)
      await expect(driver.screen(id)).rejects.toThrow(/cannot tell/)
      const heard: string[] = []
      driver.onOutput(id, (chunk) => heard.push(Buffer.from(chunk).toString()))
      await driver.write(id, line('typed'))
      await until(() => heard.join('').includes('got:typed'))
    }, 30_000)
  }
})
