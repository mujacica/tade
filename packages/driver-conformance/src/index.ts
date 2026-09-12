import { fileURLToPath } from 'node:url'
import {
  LaneClosedError,
  type LaneId,
  LaneNotFoundError,
  type LaneSpec,
  type WorkspaceDriver,
} from '@wilco/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The shared suite every WorkspaceDriver must pass. It exists before the
// second driver does: writing a new driver means importing this, running it,
// and fixing what is red.

export const ECHO_CHILD = fileURLToPath(new URL('./echo-child.js', import.meta.url))

export interface ConformanceOptions {
  /** Lanes the driver reports may include ones other tests created. */
  laneIdPrefix?: string
}

const utf8 = new TextEncoder()
const line = (s: string) => utf8.encode(`${s}\n`)

/** Wait until `check` passes, polling. Beats fixed sleeps in PTY tests. */
export async function until<T>(
  check: () => T | Promise<T>,
  { timeout = 5_000, interval = 20 } = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await check()
      if (v) return v
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting${last ? `: ${String(last)}` : ''}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

export function testWorkspaceDriver(
  name: string,
  make: () => WorkspaceDriver | Promise<WorkspaceDriver>,
  opts: ConformanceOptions = {},
): void {
  describe(`WorkspaceDriver: ${name}`, () => {
    let driver: WorkspaceDriver
    let n = 0
    const prefix = opts.laneIdPrefix ?? 'conf/t'

    const spec = (over: Partial<LaneSpec> = {}): LaneSpec => ({
      id: `${prefix}/l${++n}` as LaneId,
      cwd: process.cwd(),
      command: process.execPath,
      args: [ECHO_CHILD],
      cols: 80,
      rows: 24,
      ...over,
    })

    const capture = (id: LaneId, lines = 50) => driver.capture(id, { lines })
    const waitFor = (id: LaneId, text: string) =>
      until(async () => (await capture(id)).includes(text))

    beforeEach(async () => {
      driver = await make()
    })
    afterEach(async () => {
      await driver.shutdown()
    })

    it('declares an id and a full capability set', () => {
      expect(driver.id).toBeTruthy()
      for (const key of ['detach', 'remoteAttach', 'nativeTabs', 'focus', 'setTitle', 'adopt']) {
        expect(typeof driver.capabilities[key as 'focus']).toBe('boolean')
      }
    })

    it('open → write → capture round-trip', async () => {
      const s = spec()
      const handle = await driver.open(s)
      expect(handle.id).toBe(s.id)
      expect(handle.alive).toBe(true)
      await waitFor(s.id, 'ready')
      await driver.write(s.id, line('hello'))
      await waitFor(s.id, 'got:hello')
    })

    it('capture returns rendered screen state, not escape sequences', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      // Clear screen + reposition: a raw byte log would still contain 'first'.
      await driver.write(s.id, line('first'))
      await waitFor(s.id, 'got:first')
      const text = await capture(s.id)
      expect(text).not.toMatch(/\[/)
    })

    it('preserves output ordering under rapid writes', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const words = Array.from({ length: 30 }, (_, i) => `w${i}`)
      await Promise.all(words.map((w) => driver.write(s.id, line(w))))
      await waitFor(s.id, 'got:w29')
      const text = await capture(s.id, 100)
      const seen = text
        .split('\n')
        .flatMap((l) => /got:(w\d+)/.exec(l) ?? [])
        .filter((_, i) => i % 2 === 1)
      expect(seen).toEqual(words)
    })

    it('interleaves concurrent writes at line granularity, never mid-line', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const a = Array.from({ length: 15 }, (_, i) => `a${i}`)
      const b = Array.from({ length: 15 }, (_, i) => `b${i}`)
      await Promise.all([
        (async () => {
          for (const w of a) await driver.write(s.id, line(w))
        })(),
        (async () => {
          for (const w of b) await driver.write(s.id, line(w))
        })(),
      ])
      await until(async () => {
        const t = await capture(s.id, 200)
        return t.includes('got:a14') && t.includes('got:b14')
      })
      const text = await capture(s.id, 200)
      for (const l of text.split('\n')) {
        if (l.includes('got:')) expect(l.trim()).toMatch(/^got:[ab]\d+$/)
      }
      // Each stream keeps its own order.
      const order = (xs: string[]) => xs.map((w) => text.indexOf(`got:${w}\n`))
      for (const xs of [a, b]) {
        const idx = order(xs).filter((i) => i >= 0)
        expect(idx).toEqual([...idx].sort((x, y) => x - y))
      }
    })

    it('resize does not corrupt the buffer', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      await driver.write(s.id, line('keepme'))
      await waitFor(s.id, 'got:keepme')
      await driver.resize(s.id, 120, 40)
      const handle = await driver.get(s.id)
      expect(handle).toMatchObject({ cols: 120, rows: 40 })
      expect(await capture(s.id)).toContain('got:keepme')
      await driver.write(s.id, line('after'))
      await waitFor(s.id, 'got:after')
    })

    it('setTitle is reflected by list and get', async () => {
      const s = spec()
      await driver.open(s)
      await driver.setTitle(s.id, 'checkout · stripe-v15 · agent')
      expect((await driver.get(s.id))?.title).toBe('checkout · stripe-v15 · agent')
      const listed = (await driver.list()).find((l) => l.id === s.id)
      expect(listed?.title).toBe('checkout · stripe-v15 · agent')
    })

    it('list reports every open lane with relaunch details', async () => {
      const a = spec()
      const b = spec()
      await driver.open(a)
      await driver.open(b)
      const lanes = await driver.list()
      const mine = lanes.filter((l) => l.id === a.id || l.id === b.id)
      expect(mine).toHaveLength(2)
      for (const l of mine) {
        expect(l.spec.cwd).toBe(process.cwd())
        expect(l.spec.command).toBe(process.execPath)
        expect(l.startedAt).toBeGreaterThan(0)
      }
    })

    it('onOutput streams live output and unsubscribes cleanly', async () => {
      const s = spec()
      await driver.open(s)
      const chunks: string[] = []
      const stop = driver.onOutput(s.id, (c) => chunks.push(Buffer.from(c).toString()))
      await driver.write(s.id, line('streamed'))
      await until(() => chunks.join('').includes('got:streamed'))
      stop()
      const before = chunks.length
      await driver.write(s.id, line('afterstop'))
      await waitFor(s.id, 'got:afterstop')
      expect(chunks.length).toBe(before)
    })

    it('onOutput with replay delivers the buffered scrollback first', async () => {
      const s = spec()
      await driver.open(s)
      await driver.write(s.id, line('earlier'))
      await waitFor(s.id, 'got:earlier')
      const seen: string[] = []
      driver.onOutput(s.id, (c) => seen.push(Buffer.from(c).toString()), { replay: true })
      await until(() => seen.join('').includes('got:earlier'))
    })

    it('onExit fires with the exit code', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const exits: Array<{ code: number | null }> = []
      driver.onExit(s.id, (e) => exits.push(e))
      await driver.write(s.id, line('exit'))
      await until(() => exits.length > 0)
      expect(exits[0]?.code).toBe(0)
      const handle = await driver.get(s.id)
      expect(handle).toMatchObject({ alive: false, exitCode: 0 })
    })

    it('attachCommand names the lane and is non-empty', async () => {
      const s = spec()
      await driver.open(s)
      const cmd = driver.attachCommand(s.id)
      expect(cmd.length).toBeGreaterThan(0)
      expect(cmd).toContain(s.id.split('/').at(-1)!)
    })

    it('close is idempotent', async () => {
      const s = spec()
      await driver.open(s)
      await driver.close(s.id)
      await expect(driver.close(s.id)).resolves.not.toThrow()
    })

    it('capture after close throws LaneClosedError', async () => {
      const s = spec()
      await driver.open(s)
      await driver.close(s.id)
      await expect(capture(s.id)).rejects.toBeInstanceOf(LaneClosedError)
    })

    it('write after close throws LaneClosedError', async () => {
      const s = spec()
      await driver.open(s)
      await driver.close(s.id)
      await expect(driver.write(s.id, line('x'))).rejects.toBeInstanceOf(LaneClosedError)
    })

    it('unknown lanes throw LaneNotFoundError, not undefined behaviour', async () => {
      const ghost = `${prefix}/ghost` as LaneId
      await expect(driver.write(ghost, line('x'))).rejects.toBeInstanceOf(LaneNotFoundError)
      await expect(capture(ghost)).rejects.toBeInstanceOf(LaneNotFoundError)
      await expect(driver.resize(ghost, 80, 24)).rejects.toBeInstanceOf(LaneNotFoundError)
      expect(await driver.get(ghost)).toBeNull()
    })

    it('rejects a duplicate lane id', async () => {
      const s = spec()
      await driver.open(s)
      await expect(driver.open(s)).rejects.toThrow()
    })

    it('reports a failed launch instead of a phantom lane', async () => {
      const s = spec({ command: '/nonexistent/binary-xyz' })
      await expect(driver.open(s)).rejects.toThrow()
      expect(await driver.get(s.id)).toBeNull()
    })

    it('a lane runs in its own working directory', async () => {
      const s = spec({ cwd: '/tmp', args: [ECHO_CHILD] })
      const handle = await driver.open(s)
      expect(handle.spec.cwd).toBe('/tmp')
      await waitFor(s.id, 'ready')
    })

    it('capture honours the requested number of lines', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      for (let i = 0; i < 12; i++) await driver.write(s.id, line(`n${i}`))
      await waitFor(s.id, 'got:n11')
      const few = await capture(s.id, 3)
      expect(few.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(3)
      expect(few).toContain('got:n11')
    })

    it('unsupported capabilities fail loudly rather than silently', async () => {
      const s = spec()
      await driver.open(s)
      if (!driver.capabilities.focus) {
        await expect(driver.focus(s.id)).rejects.toThrow()
      } else {
        await expect(driver.focus(s.id)).resolves.not.toThrow()
      }
    })
  })
}
