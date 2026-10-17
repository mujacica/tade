import { chmodSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { forgetOldPictures, PICTURES_KEPT_MS } from '../src/attachments.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** A file in `folder` last written `age` before `now`. */
function written(folder: string, name: string, now: number, age: number): string {
  const path = join(folder, name)
  writeFileSync(path, 'png')
  const at = (now - age) / 1000
  utimesSync(path, at, at)
  return path
}

describe('a picture handed on by its path', () => {
  it('is kept a week, and goes once it is older', () => {
    const folder = tmp('tade-pictures-')
    const now = Date.now()
    const old = written(folder, '1-1.png', now, 8 * DAY_MS)
    const edge = written(folder, '2-1.png', now, PICTURES_KEPT_MS - 1_000)
    const recent = written(folder, '3-1.png', now, DAY_MS)

    expect(forgetOldPictures(folder, now)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    // A second short of a week is still within it.
    expect(existsSync(edge)).toBe(true)
    expect(existsSync(recent)).toBe(true)
  })

  it('leaves what it did not write: a folder, and a link however old', () => {
    const folder = tmp('tade-pictures-')
    const now = Date.now()
    const elsewhere = written(tmp('tade-elsewhere-'), 'shot.png', now, 30 * DAY_MS)
    const link = join(folder, 'shot.png')
    symlinkSync(elsewhere, link)
    const inner = join(folder, 'inner')
    mkdirSync(inner)
    utimesSync(inner, (now - 30 * DAY_MS) / 1000, (now - 30 * DAY_MS) / 1000)

    expect(forgetOldPictures(folder, now)).toEqual([])
    expect(existsSync(link)).toBe(true)
    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(inner)).toBe(true)
  })

  it('has nothing to remove where nothing was written yet', () => {
    expect(forgetOldPictures(join(tmp('tade-pictures-'), 'attachments'), Date.now())).toEqual([])
  })

  it('says a picture it could not remove, rather than calling the folder tidied', () => {
    const folder = tmp('tade-pictures-')
    const now = Date.now()
    const old = written(folder, '1-1.png', now, 8 * DAY_MS)
    chmodSync(folder, 0o500)
    try {
      expect(() => forgetOldPictures(folder, now)).toThrow(/EACCES/)
    } finally {
      chmodSync(folder, 0o700)
    }
    expect(existsSync(old)).toBe(true)
  })
})
