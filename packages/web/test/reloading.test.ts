import type { FSWatcher } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Streams } from '../src/peers.ts'
import { projector } from '../src/reading.ts'
import { fromSource, type Watch, watchFolder } from '../src/reloading.ts'
import { STREAM_EVENTS } from '../src/stream.ts'
import { input, NOW, reach } from './fixtures.ts'

// Live reload, which is the repository's alone.

describe('whether this is the repository’s copy', () => {
  it('is a module whose own URL is a `.ts` file, and nothing published is', () => {
    expect(fromSource('file:///Users/me/tade/packages/web/src/reloading.ts')).toBe(true)
    // The tarball renames every `.ts` to `.js` when it is staged.
    expect(fromSource('file:///opt/node_modules/tade-sh/packages/web/src/reloading.js')).toBe(false)
    // And this suite runs from source, so it is the repository's here.
    expect(fromSource()).toBe(true)
  })
})

describe('watching the folder', () => {
  // The OS's word that a folder changed is stood in for, and the clock is
  // faked: on a loaded Mac FSEvents said nothing for 16 s at a time, so the
  // real one failed this as `expected 0 to be greater than 0` — about the OS's
  // pace, never about the burst.
  function standIn() {
    const was = { dir: '', persistent: true as boolean, closed: false, heard: () => {} }
    const on: Watch = (dir, options, heard) => {
      Object.assign(was, { dir, persistent: options.persistent, heard })
      return {
        on: () => {},
        close: () => {
          was.closed = true
        },
      } as unknown as FSWatcher
    }
    return { was, on }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('says once per burst of writes, a beat after the last', () => {
    vi.useFakeTimers()
    const { was, on } = standIn()
    let said = 0
    const stop = watchFolder('/served', () => (said += 1), 400, on)
    expect(was).toMatchObject({ dir: '/served', persistent: false })
    // Three writes, each inside the settle of the one before.
    was.heard()
    vi.advanceTimersByTime(300)
    was.heard()
    vi.advanceTimersByTime(300)
    was.heard()
    vi.advanceTimersByTime(399)
    expect(said).toBe(0)
    vi.advanceTimersByTime(1)
    expect(said).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(said).toBe(1)
    // A later burst is a reload of its own.
    was.heard()
    vi.advanceTimersByTime(400)
    expect(said).toBe(2)
    // And one cut off by stopping is never said.
    was.heard()
    stop()
    vi.advanceTimersByTime(400)
    expect(said).toBe(2)
    expect(was.closed).toBe(true)
  })

  it('stops when told, and a folder that is not there is quietly not watched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-reload-'))
    let said = 0
    const stop = watchFolder(dir, () => (said += 1), 20)
    stop()
    await writeFile(join(dir, 'a.css'), 'a')
    await new Promise((done) => setTimeout(done, 150))
    expect(said).toBe(0)
    expect(() => watchFolder(join(dir, 'not-here'), () => {})()).not.toThrow()
  })
})

describe('telling the open pages', () => {
  it('sends every stream one reload and leaves it open', () => {
    expect(STREAM_EVENTS).toContain('reload')
    const streams = new Streams()
    const sink = {
      wrote: [] as string[],
      ended: false,
      write(text: string): boolean {
        sink.wrote.push(text)
        return true
      },
      end(): void {
        sink.ended = true
      },
    }
    streams.open({
      device: 'aaaa0000bbbb1111',
      until: NOW + 86_400_000,
      cursor: null,
      sink,
      snapshot: () => projector(input({ reach: reach() }), NOW).snapshot(),
      rev: 0,
      now: NOW,
    })
    streams.reloadAll()
    expect(sink.wrote.join('')).toContain('event: reload')
    expect(sink.ended).toBe(false)
  })
})
