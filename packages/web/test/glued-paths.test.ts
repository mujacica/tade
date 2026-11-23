import { describe, expect, it } from 'vitest'
import { ELIDED, pathIn, withoutPaths } from '../src/fields.ts'
import { cleanScreen, cleanText } from '../src/screen.ts'

// A machine path glued to the text around it — a call's arguments, a flag, a
// JSON field — is still a machine path, and the away view's claim is that it
// adds none of its own. Asked of `withoutPaths` and of both of the screen's
// cleaners, because they are one rule (`pathIn`) and a page reaches all three.

const cleaners: [string, (said: string) => string][] = [
  ['withoutPaths', withoutPaths],
  ['cleanText', (said) => cleanText(said, []).text],
  ['cleanScreen', (said) => cleanScreen(said, []).lines.join('\n')],
]

describe.each(cleaners)('a path glued to other text, through %s', (_, clean) => {
  it('is taken out of a call’s arguments', () => {
    expect(clean("readFile('/Users/someone/.ssh/id_rsa')")).toBe(`readFile('${ELIDED}')`)
    expect(clean("join('/home/someone', 'x')")).toBe(`join('${ELIDED}', 'x')`)
  })

  it('is taken out after a flag’s or a variable’s equals sign, the home kind included', () => {
    expect(clean('--out=/Users/someone/build')).toBe(`--out=${ELIDED}`)
    expect(clean('HOME=~/work/app')).toBe(`HOME=${ELIDED}`)
  })

  it('is taken out of JSON written without a space in it', () => {
    const said = clean('{"cwd":"/Users/someone/app","n":1}')
    expect(said).not.toContain('someone')
    expect(said.startsWith(`{"cwd":"${ELIDED}`)).toBe(true)
  })

  it('leaves a URL, a relative path and a comment marker where they are', () => {
    const kept = 'see https://example.invalid/a/b and/or src/a/b.ts, x(a/b/c) // done'
    expect(clean(kept)).toBe(kept)
  })
})

describe('where in a word the path is', () => {
  it('is from the first opening it follows to the word’s closing punctuation', () => {
    expect(pathIn("readFile('/a/b')")).toEqual({ from: 10, to: 14 })
    expect(pathIn('x:/a/b')).toEqual({ from: 0, to: 6 })
    expect(pathIn('key:/a/b')).toEqual({ from: 4, to: 8 })
  })

  it('is nowhere when the only slashes are separators or a scheme', () => {
    expect(pathIn('a=//')).toBeNull()
    expect(pathIn('http://host/a/b')).toBeNull()
    expect(pathIn('f(x)/y')).toBeNull()
  })

  it('reads a minified line as fast as a short one', () => {
    // One word with an opening every other character: asked at each one, and
    // every one of them answers at once.
    const long = `${'a,'.repeat(200_000)}x`
    const started = performance.now()
    expect(pathIn(long)).toBeNull()
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
