import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Streams } from '../src/peers.ts'
import { projector } from '../src/reading.ts'
import { fromSource, watchFolder } from '../src/reloading.ts'
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
  it('says once per burst of writes, a beat after the last', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-reload-'))
    let said = 0
    const stop = watchFolder(dir, () => (said += 1), 40)
    try {
      for (const name of ['a.css', 'b.js', 'a.css']) await writeFile(join(dir, name), name)
      const until = Date.now() + 3_000
      while (said === 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 20))
      // A beat more, to see that the burst stayed one.
      await new Promise((done) => setTimeout(done, 150))
      expect(said).toBe(1)
    } finally {
      stop()
    }
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
