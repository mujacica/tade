import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cachePath, parseCache, readCache, writeCache } from '@tade/mcp-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'

// What a server offered, last time anybody asked — and every way a file on
// disk holding a third party's words can be wrong.

const tool = { name: 'search', description: 'Search.', input: { type: 'object' } }

describe('the cache of what a server offered', () => {
  it('is written where the page says, kept to this user, and read back whole', () => {
    const home = tmp('mcp-cache-')
    writeCache(home, 'linear', {
      about: { title: 'Linear', version: '2' },
      tools: [tool],
      asked: '2026-09-21T08:00:00.000Z',
    })
    const path = cachePath(home, 'linear')
    expect(path).toBe(join(home, 'mcp', 'linear.json'))
    // A file holding what somebody else's server said, beside the keys.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readCache(home, 'linear')).toEqual({
      about: { title: 'Linear', version: '2' },
      tools: [tool],
      asked: '2026-09-21T08:00:00.000Z',
    })
  })

  it('is no cache rather than a throw, wherever it is wrong', () => {
    const home = tmp('mcp-cache-')
    // Nobody has asked yet: the normal case on a fresh machine.
    expect(readCache(home, 'linear')).toBeNull()
    mkdirSync(join(home, 'mcp'), { recursive: true })
    for (const written of ['', 'not json', '[]', '{}', '{"tools":[]}', 'null']) {
      writeFileSync(cachePath(home, 'linear'), written)
      expect(readCache(home, 'linear'), written).toBeNull()
    }
  })

  it('leaves out a tool it does not recognise, and keeps the rest of the list', () => {
    const read = parseCache(
      JSON.stringify({
        about: { title: 'Linear' },
        tools: [tool, { name: 'nope' }, null, 'a string'],
        asked: '2026-09-21T08:00:00.000Z',
      }),
    )
    expect(read?.tools).toEqual([tool])
    // Its version was not in the file, so it is empty and not invented.
    expect(read?.about).toEqual({ title: 'Linear', version: '' })
  })

  it('is never what a window refuses to open over', () => {
    const home = tmp('mcp-cache-')
    // A home that is a file: nothing can be written under it at all.
    const wedged = join(home, 'wedged')
    writeFileSync(wedged, 'not a directory')
    expect(() =>
      writeCache(wedged, 'linear', { about: { title: '', version: '' }, tools: [], asked: 'now' }),
    ).not.toThrow()
    expect(readCache(wedged, 'linear')).toBeNull()
  })
})
