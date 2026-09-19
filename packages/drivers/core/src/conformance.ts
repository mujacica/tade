import { fileURLToPath } from 'node:url'
import type { LaneId } from '@tade/core'
import { spawn as openPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LaneClosedError, LaneNotFoundError, type LaneSpec, type WorkspaceDriver } from './port.ts'

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

/** Is this process still there? EPERM means yes, and not ours to signal. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

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

/**
 * Make a driver attached to a named workspace.
 *
 * The name is the whole point: two calls with the same name must produce two
 * instances looking at the same lanes, because that is what closing Tade and
 * opening it again is. A factory that invents a fresh workspace every call
 * makes adoption untestable, and adoption is how anything survives a restart.
 */
export type DriverFactory = (workspace: string) => WorkspaceDriver | Promise<WorkspaceDriver>

export function testWorkspaceDriver(
  name: string,
  make: DriverFactory,
  opts: ConformanceOptions = {},
): void {
  describe(`WorkspaceDriver: ${name}`, () => {
    let driver: WorkspaceDriver
    let workspace: string
    let n = 0
    const prefix = opts.laneIdPrefix ?? 'conf/t'
    /** A second window onto the same lanes: Tade started again. */
    const reopen = () => make(workspace)

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
      // Fresh per test, so one test's lanes are never another's.
      workspace = `conf-${Math.random().toString(36).slice(2, 10)}`
      driver = await make(workspace)
    })
    afterEach(async () => {
      await driver.shutdown()
    })

    it('says whether this machine can provide it', async () => {
      // The suite is running, so it can: what matters is that the answer is
      // shaped like one you could show somebody, not that it is true here.
      const availability = await driver.available()
      expect(availability.ok).toBe(true)
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
      expect(text).not.toContain('\u001b[')
    })

    it('keeps colour when asked for a styled capture, and only then', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      await driver.write(s.id, line('paint'))
      await waitFor(s.id, 'bold')
      // Built from a character code: an escape in a regex literal is usually a mistake.
      const ESC = String.fromCharCode(27)
      const plain = await driver.capture(s.id, { lines: 50 })
      const styled = await driver.capture(s.id, { lines: 50, styled: true })
      expect(plain).not.toContain('\u001b[')
      // The window draws a lane the way it looks; a capture that drops the
      // colour draws every agent grey.
      expect(styled).toMatch(new RegExp(`${ESC}\\[[0-9;]*38;5;196[0-9;]*m`))
      expect(styled).toContain('red')
      // Nothing but paint: a cursor move in here would scramble the window.
      expect(styled.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).not.toContain(ESC)
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

    // The escape hatch that makes the rest of this safe to rely on: whatever
    // else is broken, a human can still see the lane. A string that looks
    // plausible and does not run is worse than no escape hatch at all, because
    // you find out at the moment you needed it — so it gets run.
    //
    // Gated on `remoteAttach`, which is exactly the claim that the command
    // works from another terminal with no Tade in the picture. A driver
    // without it hands back something like `tade attach <lane>`, which needs
    // the window that owns the lane and cannot be tested from out here.
    it('attachCommand actually attaches, not just reads like it would', async () => {
      if (!driver.capabilities.remoteAttach) return
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      await driver.write(s.id, line('marker'))
      await waitFor(s.id, 'got:marker')

      const seen: string[] = []
      const viewer = openPty('/bin/sh', ['-c', driver.attachCommand(s.id)], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      })
      viewer.onData((chunk) => seen.push(chunk))
      try {
        // What the lane already said has to show up in somebody else's
        // terminal, which is the whole claim.
        await until(() => seen.join('').includes('got:marker'))
      } finally {
        viewer.kill()
      }
    })

    it('two terminals attached to one lane see the same thing', async () => {
      if (!driver.capabilities.remoteAttach) return
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')

      const watch = () => {
        const seen: string[] = []
        const term = openPty('/bin/sh', ['-c', driver.attachCommand(s.id)], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
        })
        term.onData((chunk) => seen.push(chunk))
        return { seen, term }
      }
      const a = watch()
      const b = watch()
      try {
        await driver.write(s.id, line('shared'))
        // Neither is privileged: one attacher is a view, not an owner.
        await until(() => a.seen.join('').includes('got:shared'))
        await until(() => b.seen.join('').includes('got:shared'))
      } finally {
        a.term.kill()
        b.term.kill()
      }
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

    // An agent stopped and started again, or one that crashed and is opened
    // where it left off, is the same lane under the same name. Refusing that
    // id for the life of the window made the second start fail.
    it('opens a lane again under the id of one that was closed', async () => {
      const s = spec()
      await driver.open(s)
      await driver.close(s.id)
      const again = await driver.open(s)
      expect(again.alive).toBe(true)
      await waitFor(s.id, 'ready')
      await driver.write(s.id, line('again'))
      await waitFor(s.id, 'got:again')
    })

    it('opens a lane again under the id of one whose process exited', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const exits: Array<{ code: number | null }> = []
      driver.onExit(s.id, (e) => exits.push(e))
      await driver.write(s.id, line('exit'))
      await until(() => exits.length > 0)
      const again = await driver.open(s)
      expect(again.alive).toBe(true)
      await driver.write(s.id, line('back'))
      await waitFor(s.id, 'got:back')
      // What listened to the old process does not hear the new one end.
      await driver.write(s.id, line('exit'))
      await until(async () => (await driver.get(s.id))?.alive === false)
      expect(exits).toHaveLength(1)
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

    // A window draws a scrollbar and a cursor from these two numbers, and
    // nothing in the captured text can tell it either: how far back the lane
    // goes, and where what you type lands in what it just drew.
    it('says how far back it can be read, and where typing appears', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const first = await driver.screen(s.id)
      expect(first.lines).toBeGreaterThan(0)
      for (let i = 0; i < 40; i++) await driver.write(s.id, line(`n${i}`))
      await waitFor(s.id, 'got:n39')
      const after = await driver.screen(s.id)
      // Forty lines printed is forty lines further back to read, whatever the
      // screen is tall: a depth that stops at the screen is a scrollbar that lies.
      expect(after.lines).toBeGreaterThan(first.lines + 30)
      // Asked for more lines than there are, a capture returns exactly that many.
      expect((await capture(s.id, 1_000)).split('\n').length).toBe(after.lines)
      // The child prints whole lines, so it leaves the cursor at the start of
      // the empty row under the last of them — the row a capture leaves out.
      expect(after.cursor.column).toBe(0)
      expect(after.cursor.back).toBe(-1)
      // A prompt drawn without a newline: typing lands on the last line captured.
      await driver.write(s.id, line('prompt'))
      await until(async () => (await driver.screen(s.id)).cursor.back === 0)
      const typing = await driver.screen(s.id)
      expect(typing.cursor).toEqual({ back: 0, column: 2 })
    })

    // Closing Tade and opening it again is the ordinary case, not the
    // exceptional one, so a driver whose lanes outlive us has to be able to
    // walk back into them: finding a lane is worth nothing if the handle it
    // returns cannot then be written to.
    it('a new instance adopts lanes it did not open, and can drive them', async () => {
      if (!driver.capabilities.adopt) return
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')

      // Deliberately not `shutdown()`: this is Tade going away, not the
      // lanes being closed.
      const reopened = await reopen()
      try {
        const found = await reopened.adopt({})
        expect(found.map((h) => h.id)).toContain(s.id)
        // The spec survives the round trip, or a relaunch has nothing to use.
        const handle = found.find((h) => h.id === s.id)!
        expect(handle.spec.command).toBe(s.command)
        expect(handle.alive).toBe(true)

        await reopened.write(s.id, line('after'))
        await until(async () => (await reopened.capture(s.id, { lines: 50 })).includes('got:after'))
      } finally {
        await reopened.shutdown()
      }
    })

    // `detach: true` is a promise to the user that closing Tade does not stop
    // their agents. This is where that promise is kept or broken.
    it('detach lets go of lanes without ending them', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const pid = (await driver.get(s.id))?.pid ?? null

      await driver.detach()
      try {
        if (!driver.capabilities.detach) return
        expect(pid).not.toBeNull()
        // Still running, and not because we are still holding it: this is a
        // process that outlived the thing that started it.
        expect(isRunning(pid!)).toBe(true)

        const reopened = await reopen()
        try {
          const found = await reopened.adopt({})
          expect(found.map((h) => h.id)).toContain(s.id)
        } finally {
          await reopened.shutdown()
        }
      } finally {
        // Detaching means nothing owns this lane any more, so the test has to
        // clean up after itself rather than leaving a process behind.
        if (pid) kill(pid)
      }
    })

    it('shutdown ends lanes, unlike detach', async () => {
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const pid = (await driver.get(s.id))?.pid
      await driver.shutdown()
      if (pid) await until(() => !isRunning(pid))
    })

    it('adopting twice does not produce the same lane twice', async () => {
      if (!driver.capabilities.adopt) return
      const s = spec()
      await driver.open(s)
      await waitFor(s.id, 'ready')
      const reopened = await reopen()
      try {
        await reopened.adopt({})
        // The second pass has nothing new to report: the lane is already held.
        expect((await reopened.adopt({})).map((h) => h.id)).not.toContain(s.id)
        expect((await reopened.list()).filter((h) => h.id === s.id)).toHaveLength(1)
      } finally {
        await reopened.shutdown()
      }
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
