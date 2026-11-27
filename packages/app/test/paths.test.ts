import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extensionOf, fileName, folderOf } from '../src/paths.ts'

// `paths.ts` is `node:path`'s POSIX answers without Node, so the window draws
// a file's name the same in a browser. Held to Node's own over the cases a
// guess gets wrong and over every short path made of the characters that matter.

const CASES = [
  '',
  '/',
  '//',
  '///a',
  '//a',
  'a',
  'a/',
  'a//',
  '/a',
  '/a/b',
  '/a/b/',
  'a/b/c.txt',
  '.bashrc',
  '..',
  '.',
  'a..',
  'a.b.c',
  '/x/.hidden.ts',
  'archive.tar.gz',
  'dir.d/file',
  'dir.d/',
  '...',
  'a.',
  '~/Pictures/shot 1.png',
]

/** Every string up to five characters long out of `a`, `.` and `/`. */
function generated(): string[] {
  const out: string[] = ['']
  let level = ['']
  for (let length = 1; length <= 5; length++) {
    level = level.flatMap((prefix) => ['a', '.', '/'].map((c) => prefix + c))
    out.push(...level)
  }
  return out
}

describe('a path, read without Node', () => {
  for (const [name, ours, theirs] of [
    ['fileName', fileName, (p: string) => posix.basename(p)],
    ['folderOf', folderOf, (p: string) => posix.dirname(p)],
    ['extensionOf', extensionOf, (p: string) => posix.extname(p)],
  ] as const) {
    it(`${name} answers as node:path does`, () => {
      for (const path of [...CASES, ...generated()]) expect(ours(path), path).toBe(theirs(path))
    })
  }
})
