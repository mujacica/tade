import { describe, expect, it } from 'vitest'
import { folderMark, type Listed, marksFrom, treeOf } from '../src/files.ts'
import { initialState, toggleFolder } from '../src/model.ts'

// The FILES tree, from a made-up disk: what is listed, in what order, how deep.

const disk: Record<string, Listed[]> = {
  '': [
    { name: 'README.md', folder: false },
    { name: 'src', folder: true },
    { name: '.git', folder: true },
    { name: '.github', folder: true },
    { name: 'package.json', folder: false },
    { name: '.DS_Store', folder: false },
  ],
  src: [
    { name: 'app.ts', folder: false },
    { name: 'panels', folder: true },
  ],
  'src/panels': [{ name: 'menu.ts', folder: false }],
}
const list = (folder: string) => disk[folder] ?? []

describe('the FILES tree', () => {
  it('lists folders first, then files, each by name, and leaves out git and Finder', () => {
    expect(treeOf([], list).map((entry) => entry.path)).toEqual([
      '.github',
      'src',
      'package.json',
      'README.md',
    ])
  })

  it('lists an open folder under itself, one step in', () => {
    const tree = treeOf(['src', 'src/panels'], list)
    expect(tree.map((entry) => [entry.path, entry.depth])).toEqual([
      ['.github', 0],
      ['src', 0],
      ['src/panels', 1],
      ['src/panels/menu.ts', 2],
      ['src/app.ts', 1],
      ['package.json', 0],
      ['README.md', 0],
    ])
    expect(tree.find((entry) => entry.path === 'src')?.open).toBe(true)
  })

  it('stops at a length nobody would scroll through', () => {
    expect(treeOf(['src'], list, 3)).toHaveLength(3)
  })

  it('closes what is inside a folder when the folder closes', () => {
    let state = toggleFolder(initialState(), 'src')
    state = toggleFolder(state, 'src/panels')
    expect(state.expanded).toEqual(['src', 'src/panels'])
    expect(toggleFolder(state, 'src').expanded).toEqual([])
  })
})

describe('marks from git', () => {
  it('reads what git status says about each file, and leaves Tade out', () => {
    const status = [
      '1 .M N... 100644 100644 100644 abc abc src/app.ts',
      '1 A. N... 000000 100644 100644 000 abc src/new.ts',
      '1 D. N... 100644 000000 000000 abc 000 old.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/renamed.ts',
      'src/before.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
      '? notes/draft.md',
      '? .tade/task.yaml',
      '',
    ].join('\0')
    expect(marksFrom(status)).toEqual({
      'src/app.ts': 'M',
      'src/new.ts': 'A',
      'old.ts': 'D',
      'src/renamed.ts': 'R',
      'src/conflict.ts': '!',
      'notes/draft.md': 'U',
    })
  })

  it('marks a folder by the most pressing thing inside it', () => {
    expect(folderMark('src', { 'src/a.ts': 'U', 'src/deep/b.ts': 'M' })).toBe('M')
    expect(folderMark('notes', { 'notes/draft.md': 'U' })).toBe('U')
    expect(folderMark('src', { 'src/x.ts': 'M', 'src/y.ts': '!' })).toBe('!')
    expect(folderMark('test', { 'src/a.ts': 'M' })).toBeNull()
    // `src` is not inside `sr`.
    expect(folderMark('sr', { 'src/a.ts': 'M' })).toBeNull()
  })
})
