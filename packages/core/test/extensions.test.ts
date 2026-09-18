import { describe, expect, it } from 'vitest'
import { extensionDirs, isExtensionName, loadable, proposalPath } from '../src/extensions.ts'

describe('extensionDirs', () => {
  it('keeps proposed, active and rejected apart', () => {
    const dirs = extensionDirs('/home/me/.tade/extensions')
    expect(dirs.active).toBe('/home/me/.tade/extensions/active')
    expect(dirs.proposed).toBe('/home/me/.tade/extensions/proposed')
    // Kept rather than deleted, so the same idea is not proposed twice.
    expect(dirs.rejected).toBe('/home/me/.tade/extensions/rejected')
  })
})

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

describe('proposalPath', () => {
  const dirs = extensionDirs('/x')

  it('lands in proposed, never active', () => {
    // An agent writes proposals. A human decides what runs.
    expect(proposalPath(dirs, 'summarise-prs')).toBe('/x/proposed/summarise-prs.ts')
  })

  it('refuses a name it will not write', () => {
    expect(proposalPath(dirs, '../../etc/passwd')).toBeNull()
  })
})
