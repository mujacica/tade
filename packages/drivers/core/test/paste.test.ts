import { describe, expect, it } from 'vitest'
import { bracketedAfter, pasteBytes, pastedText } from '../src/paste.ts'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('pasteBytes', () => {
  it('wraps a paste only for a program that turned bracketed paste on', () => {
    expect(text(pasteBytes('hello', true))).toBe('\x1b[200~hello\x1b[201~')
    expect(text(pasteBytes('hello', false))).toBe('hello')
  })

  it('sends a line break as Enter where the paste is typed, and as it came where it is wrapped', () => {
    expect(text(pasteBytes('a\nb\r\nc', false))).toBe('a\rb\rc')
    expect(text(pasteBytes('a\nb', true))).toBe('\x1b[200~a\nb\x1b[201~')
  })

  it('takes the markers out of the text, so a paste cannot end itself early', () => {
    expect(text(pasteBytes('a\x1b[201~rm -rf\x1b[200~', true))).toBe('\x1b[200~arm -rf\x1b[201~')
    expect(text(pasteBytes('\x1b[200~x\x1b[201~', false))).toBe('x')
  })
})

describe('pastedText', () => {
  it('takes the markers out and makes every line break one LF, for a terminal that wraps and turns LF into Enter itself', () => {
    expect(pastedText('a\r\nb\nc\x1b[201~d')).toBe('a\nb\ncd')
  })
})

describe('bracketedAfter', () => {
  it('reads the last word the program said about mode 2004', () => {
    expect(bracketedAfter('\x1b[?2004h', false)).toBe(true)
    expect(bracketedAfter('prompt \x1b[?2004h$ ls\r\n\x1b[?2004l', false)).toBe(false)
    expect(bracketedAfter('\x1b[?1049;2004h', false)).toBe(true)
    expect(bracketedAfter('nothing about it', true)).toBe(true)
    expect(bracketedAfter('\x1b[?20045h', false)).toBe(false)
  })
})
