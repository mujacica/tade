import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A lane with the keyboard is its program's: every key reaches it but the
// leader and talking, and a paste reaches it the way it asked for pastes.
// Both through a real pty, to a program that writes down every byte it read —
// nano in miniature: it turns bracketed paste on and off when told, and says so.

/** A program that keeps every byte it reads in `out`, and turns bracketed paste on at `on` and off at `off`. */
const RECORDER = `import { appendFileSync } from 'node:fs'
const out = process.argv[2]
process.stdin.setRawMode(true)
process.stdout.write('reading\\r\\n')
let line = ''
process.stdin.on('data', (bytes) => {
  const text = bytes.toString()
  appendFileSync(out, text)
  for (const char of text) {
    if (char !== '\\r') { line += char; continue }
    if (line === 'on') process.stdout.write('\\x1b[?2004hbracketed on\\r\\n')
    if (line === 'off') process.stdout.write('\\x1b[?2004lbracketed off\\r\\n')
    line = ''
  }
  if (text.includes('\\x04')) process.exit(0)
})
`

describe('a lane with the keyboard', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('gets a paste as its program asked for one, and every key but the leader', async () => {
    const dir = tmp('tade-lane-keys-')
    const script = join(dir, 'record.mjs')
    const out = join(dir, 'read')
    writeFileSync(script, RECORDER)
    const read = () => (existsSync(out) ? readFileSync(out, 'utf8') : '')
    const opened = await client.openTerminal({ project: 'app' })
    await client.write(opened.id, `'${process.execPath}' '${script}' '${out}'\r`)
    // Wide enough for the strip to say how to reach the window from the lane.
    terminal.columns = 140
    terminal.rows = 40
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('terminal 1')
    click(tab.col + 1, tab.row)
    const shown = (text: string) => screenOf(terminal.written).some((row) => row.includes(text))
    await until('the program reading', () => shown('reading'), 20_000)
    /** What the program read after this many bytes, once it has read `ending`. */
    const after = async (from: number, ending: string) => {
      await until(`the program to read ${JSON.stringify(ending)}`, () =>
        read().slice(from).endsWith(ending),
      )
      return read().slice(from)
    }

    // It never asked for bracketed paste, so the paste is the text, typed —
    // a line break as Enter — and no `~` either side of it.
    terminal.press('\x1b[200~one\ntwo\x1b[201~')
    expect(await after(0, 'two')).toBe('one\rtwo')

    // Asked, it gets the markers round the paste, and the text as it came.
    let mark = read().length
    terminal.type('\ron\r')
    await until('bracketed paste on', () => shown('bracketed on'), 20_000)
    mark = read().length
    terminal.press('\x1b[200~three\nfour\x1b[201~')
    expect(await after(mark, '\x1b[201~')).toBe('\x1b[200~three\nfour\x1b[201~')

    terminal.type('\roff\r')
    await until('bracketed paste off', () => shown('bracketed off'), 20_000)
    mark = read().length
    terminal.press('\x1b[200~five\x1b[201~')
    expect(await after(mark, 'five')).toBe('five')

    // Tade's own keys are the program's while it has the keyboard: nano's
    // ctrl+k cuts a line, in legacy bytes and as kitty spells it with its
    // release; tab and shift+tab; ctrl+t, ctrl+n and ctrl+/, which open a
    // terminal, start an agent and go to Tade anywhere else.
    await until('the way back to the window, said', () => shown('to Tade'))
    mark = read().length
    for (const key of [
      '\x0b',
      '\x1b[107;5u',
      '\x1b[107;5:3u',
      '\t',
      '\x1b[Z',
      '\x14',
      '\x0e',
      '\x1f',
    ])
      terminal.press(key)
    terminal.press('.')
    expect(await after(mark, '.')).toBe('\x0b\x0b\t\x1b[Z\x14\x0e\x1f.')
    expect(shown('terminal 2')).toBe(false)

    // The leader, and the next key is the window's: ctrl+k is Search. The
    // program reads neither.
    mark = read().length
    terminal.press('\x1d')
    await until('the leader, lit', () => shown('now a key'))
    terminal.press('\x0b')
    await until('search', () => shown('Search'))
    terminal.press('\x1b')
    await until('search closed', () => !shown('Search') && shown('to Tade'))
    // Twice, it is the program's after all; a release in between is nothing.
    terminal.press('\x1b[93;5u')
    terminal.press('\x1b[93;5:3u')
    terminal.press('\x1d')
    terminal.press('\x04')
    expect(await after(mark, '\x04')).toBe('\x1d\x04')
  })
})
