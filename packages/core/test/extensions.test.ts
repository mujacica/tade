import { describe, expect, it } from 'vitest'
import { extensionEnabled, extensionPath, isExtensionName, loadable } from '../src/extensions.ts'

describe('loadable', () => {
  it('takes the source files and nothing else', () => {
    expect(loadable(['a.ts', 'b.js', 'c.mjs', 'notes.md', 'README', 'data.json'])).toEqual([
      'a.ts',
      'b.js',
      'c.mjs',
    ])
  })

  it('ignores editor leftovers and partial writes', () => {
    // `.park.ts.swp` is not a tool, and neither is a half-written `_new.ts`.
    expect(loadable(['.hidden.ts', '_wip.ts', 'real.ts'])).toEqual(['real.ts'])
  })

  it('is sorted, because load order decides who wins a name clash', () => {
    // Directory order is whatever the filesystem feels like, which is a bug
    // that only appears on somebody else's machine.
    expect(loadable(['zebra.ts', 'apple.ts', 'mango.ts'])).toEqual([
      'apple.ts',
      'mango.ts',
      'zebra.ts',
    ])
  })

  it('has nothing to load from an empty directory', () => {
    expect(loadable([])).toEqual([])
  })
})

describe('isExtensionName', () => {
  it('accepts a plain name', () => {
    expect(isExtensionName('summarise-prs')).toBe(true)
    expect(isExtensionName('tool7')).toBe(true)
  })

  it('refuses anything that would escape the directory or hide', () => {
    for (const name of ['../escape', 'a/b', '.hidden', '-leading', 'Caps', 'with space', '']) {
      expect(isExtensionName(name)).toBe(false)
    }
  })
})

describe('extensionPath', () => {
  it('lands in the one directory extensions live in', () => {
    // Tade writes it there and a human turns it on: there is no second place.
    expect(extensionPath('/x', 'summarise-prs')).toBe('/x/summarise-prs.ts')
  })

  it('refuses a name it will not write', () => {
    expect(extensionPath('/x', '../../etc/passwd')).toBeNull()
  })
})

describe('extensionEnabled', () => {
  it('has Tade’s own on unless they are turned off', () => {
    expect(extensionEnabled(undefined, 'built-in')).toBe(true)
    expect(extensionEnabled({ city: 'Vienna' }, 'built-in')).toBe(true)
    expect(extensionEnabled({ enabled: false }, 'built-in')).toBe(false)
  })

  it('leaves yours off until somebody turns one on', () => {
    // Sitting in the directory is being listed, not being loaded: an
    // extension Tade wrote for itself runs when a human says so.
    expect(extensionEnabled(undefined, 'yours')).toBe(false)
    expect(extensionEnabled({ token: 'x' }, 'yours')).toBe(false)
    expect(extensionEnabled({ enabled: true }, 'yours')).toBe(true)
    expect(extensionEnabled({ enabled: false }, 'yours')).toBe(false)
  })
})
