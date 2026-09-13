import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { formattable, formattedLines, readForView, sourceLines } from '../src/viewer.ts'

// A file, read for the viewer from a real disk.

describe('reading a file to look at', () => {
  it('reads text, and knows its language', () => {
    const dir = tmp('wilco-view-')
    writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 2\n')
    const file = readForView(join(dir, 'app.ts'))
    expect(file).toMatchObject({
      binary: false,
      truncated: false,
      language: 'typescript',
      error: null,
    })
    // No empty line for the newline at the end.
    expect(sourceLines(file, true)).toEqual(['const a = 1', 'const b = 2'])
  })

  it('says a binary file is one, rather than showing it', () => {
    const dir = tmp('wilco-view-')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1]))
    const file = readForView(join(dir, 'logo.png'))
    expect(file.binary).toBe(true)
    expect(sourceLines(file, true)).toEqual([])
  })

  it('reads only the start of a big file, and says so', () => {
    const dir = tmp('wilco-view-')
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(5_000))
    const file = readForView(join(dir, 'big.log'), 1_000)
    expect(file.truncated).toBe(true)
    expect(file.text).toHaveLength(1_000)
  })

  it('says why when a file cannot be read', () => {
    expect(readForView('/nowhere/at/all.ts').error).toBe('It is not there any more.')
  })

  it('lays Markdown out, and offers it only for Markdown', () => {
    const dir = tmp('wilco-view-')
    writeFileSync(join(dir, 'README.md'), '# Title\n\nSome **bold** words.\n')
    const file = readForView(join(dir, 'README.md'))
    expect(formattable(file)).toBe(true)
    const text = formattedLines(file, 40, true)
      .map((line) => stripTerminalSequences(line))
      .join('\n')
    expect(text).toContain('Some bold words.')
    expect(text).not.toContain('**')
    expect(formattable(readForView(join(dir, 'nope.md')))).toBe(false)
  })
})
