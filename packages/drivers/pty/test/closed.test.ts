import type { LaneId } from '@tade/core'
import { ECHO_CHILD, until } from '@tade/drivers-core/conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// A lane closed is a lane that ends, and whoever was waiting for it to end is
// told so. The listeners were let go of with the screen, before node-pty said
// the program had gone, so `tade run stop` left the agent's run listed for
// ever: nothing said it had exited.

describe('a lane that is closed', () => {
  let driver: PtyDriver
  beforeEach(() => {
    driver = new PtyDriver()
  })
  afterEach(async () => {
    await driver.shutdown()
  })

  const opened = async (id: LaneId) => {
    await driver.open({ id, cwd: process.cwd(), command: process.execPath, args: [ECHO_CHILD] })
    await until(async () => (await driver.capture(id, { lines: 10 })).includes('ready'))
  }

  it('tells whoever waits on its exit that it ended, once', async () => {
    const id = 'closed/one' as LaneId
    await opened(id)
    const exits: Array<{ code: number | null; signal: number | null }> = []
    driver.onExit(id, (exit) => exits.push(exit))
    await driver.close(id)
    await until(() => exits.length > 0)
    // Its end, not the one after it: opened again, the old listener hears nothing more.
    await opened(id)
    const again: unknown[] = []
    driver.onExit(id, (exit) => again.push(exit))
    await driver.close(id)
    await until(() => again.length > 0)
    expect(exits).toHaveLength(1)
  })
})
