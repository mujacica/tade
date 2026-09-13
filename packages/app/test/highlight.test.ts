import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { ansiLines, highlight, languageOf } from '../src/highlight.ts'

// Colouring code for the viewer. The colours are decoration; what matters is
// that the text is untouched and that no colour leaks from one line to the next.

describe('the language of a file', () => {
  it('comes from its extension, or its whole name', () => {
    expect(languageOf('src/app.ts')).toBe('typescript')
    expect(languageOf('README.md')).toBe('markdown')
    expect(languageOf('infra/Dockerfile')).toBe('dockerfile')
    expect(languageOf('notes.txt')).toBeNull()
    expect(languageOf('LICENSE')).toBeNull()
  })
})

describe('highlighting', () => {
  const code = 'const a = "x" // hi\n/* one\ntwo */ function f() { return 1 }\n'

  it('keeps every character, one line per line', () => {
    const lines = highlight(code, 'typescript')
    expect(lines.map((line) => stripTerminalSequences(line))).toEqual(code.split('\n'))
  })

  it('closes a colour at the end of a line and opens it again on the next', () => {
    const lines = highlight(code, 'typescript')
    // The comment runs across the break: painted on both lines, reset on the first.
    expect(lines[1]?.endsWith('\x1b[0m')).toBe(true)
    expect(lines[2]?.startsWith('\x1b[')).toBe(true)
  })

  it('leaves text plain when asked, or when the language is unknown', () => {
    expect(highlight('a < b', 'typescript', true)).toEqual(['a < b'])
    expect(highlight('a < b', 'not-a-language')).toEqual(['a < b'])
  })

  it('turns what highlight.js escapes back into characters', () => {
    const [line] = ansiLines('<span class="hljs-string">&quot;a&amp;b&lt;c&gt;&#x27;</span>')
    expect(stripTerminalSequences(line ?? '')).toBe('"a&b<c>\'')
  })

  it('keeps the colour of the span around one it has no look for', () => {
    const [line] = ansiLines(
      '<span class="hljs-string">a<span class="hljs-unknown">b</span>c</span>',
    )
    // No reset code in the middle of the string's own colour.
    expect(line).not.toContain('\x1b[38;5;114;m')
    expect(line).not.toContain('\x1b[38;5;114;0m')
  })
})
