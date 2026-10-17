import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { promptWithImages } from '../src/pictures.ts'

const picture = (bytes: string) => ({
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
})

const pathsIn = (said: string) => [...said.matchAll(/\[picture: (.+)\]/g)].map((m) => m[1] ?? '')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a picture a harness is pointed at', () => {
  it('is said after the message as a file, and nothing is written where there is none', () => {
    const dir = tmp('tade-pictures-')
    expect(promptWithImages('just words', [], dir)).toBe('just words')
    expect(readdirSync(dir)).toEqual([])

    const said = promptWithImages('look', [picture('one'), picture('two')], dir)
    expect(said).toMatch(/^look\n\n\[picture: .+\.png\]\n\[picture: .+\.png\]$/)
    expect(pathsIn(said).map((path) => readFileSync(path, 'utf8'))).toEqual(['one', 'two'])
  })

  it('is a file of its own when two are written in the same millisecond', () => {
    const dir = tmp('tade-pictures-')
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000)
    const [first] = pathsIn(promptWithImages('this one', [picture('first')], dir))
    const [second] = pathsIn(promptWithImages('and this', [picture('second')], dir))

    expect(second).not.toBe(first)
    expect(readFileSync(first ?? '', 'utf8')).toBe('first')
    expect(readFileSync(second ?? '', 'utf8')).toBe('second')
  })

  it('takes one older than a week away as the next is written, whatever it is called', () => {
    const dir = tmp('tade-pictures-')
    const [kept] = pathsIn(promptWithImages('first', [picture('kept')], dir))
    const old = join(dir, 'attachments', '1700000000000-1.png')
    writeFileSync(old, 'old')
    const overAWeek = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(old, overAWeek, overAWeek)

    promptWithImages('next', [picture('next')], dir)
    expect(readdirSync(join(dir, 'attachments'))).not.toContain('1700000000000-1.png')
    expect(readFileSync(kept ?? '', 'utf8')).toBe('kept')
  })
})
