import { describe, expect, it } from 'vitest'
import { isText, printable, printableLines } from '../src/printable.ts'

/** Every code point in a string that is not text, which must be none. */
const notText = (said: string): number[] =>
  [...said].map((one) => one.codePointAt(0) ?? 0).filter((point) => !isText(point))

describe('printable', () => {
  it('hands plain words back as they are, the ones a font has to work at included', () => {
    for (const said of ['fix the double charge', 'Café — naïve 東京 ✓ ⠋ 🚀', '']) {
      expect(printable(said)).toBe(said)
    }
  })

  it('takes a whole escape sequence out, never only its first byte', () => {
    expect(printable('\x1b[31mred\x1b[0m title')).toBe('red title')
    expect(printable('\x1b[38;5;196mbold\x1b[1;4m')).toBe('bold')
    // Charset and keypad escapes: intermediates, then a final byte.
    expect(printable('\x1b(Bplain\x1b=')).toBe('plain')
  })

  it('takes a link out with its address, and keeps the words it said', () => {
    expect(printable('\x1b]8;;https://evil.example\x1b\\click me\x1b]8;;\x1b\\')).toBe('click me')
    expect(printable('\x1b]8;;https://evil.example\x07click\x1b]8;;\x07')).toBe('click')
  })

  it('takes the window title, the clipboard and a device string out, however they end', () => {
    expect(printable('a\x1b]0;pwned\x07b')).toBe('ab')
    expect(printable('a\x1b]52;c;cm0gLXJmIH4=\x1b\\b')).toBe('ab')
    expect(printable('a\x1bPq#0;2;0;0;0\x1b\\b')).toBe('ab')
    // Unterminated, a terminal takes the rest as its argument, and so does this.
    expect(printable('title\x1b]0;and everything after')).toBe('title')
  })

  it('reads the eight-bit spellings as the sequences they are', () => {
    expect(printable('a\u009b2Jb')).toBe('ab')
    expect(printable('a\u009d0;pwned\u009cb')).toBe('ab')
    expect(printable('a\u0090q\u009cb')).toBe('ab')
  })

  it('makes a line break or a tab a space, and takes every other control out', () => {
    expect(printable('one\ntwo\r\nthree\tfour')).toBe('one two  three four')
    expect(printable('bell\x07 back\x08space\x7f nul\x00')).toBe('bell backspace nul')
  })

  it('takes out what reorders or hides the words around it', () => {
    expect(printable('admin‮⁦gnp.exe⁩')).toBe('admingnp.exe')
    expect(printable('in​visible﻿ soft­hyphen')).toBe('invisible softhyphen')
  })

  it('keeps the line breaks of many lines and makes each of them text', () => {
    expect(printableLines('one\r\ntwo\n\nthree')).toBe('one\ntwo\n\nthree')
    expect(printableLines('\x1b]0;pwned\x07first\n\x1b[2Jsecond\u009b6n\n\x1b')).toBe(
      'first\nsecond\n',
    )
    // A string left open ends with its line: the next one is text again.
    expect(printableLines('\x1b]0;open\nafter')).toBe('\nafter')
  })

  it('leaves nothing that is not text in a title made of escapes', () => {
    const title = [
      '\x1b]0;pwned\x07',
      '\x1b[2J\x1b[H',
      '\x1b[?1049h',
      '\x1b]52;c;cm0gLXJmIH4=\x07',
      '\u009b6n',
      '\x1bP+q544e\x1b\\',
      '\x1b[31mfix the build\x1b[0m',
      '‮',
      '\x1b',
    ].join('')
    const said = printable(title)
    expect(said).toBe('fix the build')
    expect(notText(said)).toEqual([])
  })
})
