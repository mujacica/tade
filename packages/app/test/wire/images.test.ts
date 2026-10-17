import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { orchestratorAttachments } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { asPaste, type ClipboardCopy, clipboardImage } from '../../src/images.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

/**
 * What the person actually said, out of the message the orchestrator is handed:
 * the window puts where they are standing above their words, under a heading,
 * and every test here is about the words.
 */
const theirWords = (message: string | undefined): string =>
  (message ?? '').split('What they said:\n').at(-1) ?? ''

// A screenshot pasted, dropped or taken off the clipboard: who it is for,
// and how it is taken back.

describe('the window, taking a picture', () => {
  let terminal: FakeTerminal
  let home: string
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    home = wired.home
  })

  it('offers a screenshot on the clipboard, and attaches it from an empty paste or a click', async () => {
    const shot = join(tmp('tade-shot-'), 'shot.png')
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    // The clipboard as the window watches it: what is on it said as the watch
    // starts, and said again here when something new is copied.
    let tell: (found: ClipboardCopy | null) => void = () => {}
    await start({
      clipboard: {
        watch: (told) => {
          tell = told
          told({ copy: '7', image: true })
          return { stop: () => {} }
        },
        image: async () => shot,
        text: async () => '',
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Open the line: the picture on the clipboard is offered.
    terminal.press('\x00')
    await until('the offer', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Attach the screenshot on the clipboard'),
      ),
    )
    // Cmd+V on a picture reaches a terminal program as a paste with nothing in it.
    terminal.press(asPaste(''))
    await until('attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ shot.png')),
    )
    // That copy is not offered again; a new one is.
    expect(
      screenOf(terminal.written).some((row) =>
        row.includes('Attach the screenshot on the clipboard'),
      ),
    ).toBe(false)
    // Abandoned with ctrl+c — escape never throws anything away, and a picture
    // going with the message is something to throw away — and something new
    // copied: offered again on the line, which ctrl+c empties without closing.
    terminal.press('\x03')
    tell({ copy: '8', image: true })
    await until('the next copy offered', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Attach the screenshot on the clipboard'),
      ),
    )
  })

  it('attaches a screenshot on ctrl+v and on Cmd+V as Ghostty sends them, before any text', async () => {
    const dir = tmp('tade-shot-')
    const shots = ['one.png', 'two.png'].map((name) => join(dir, name))
    for (const shot of shots) writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    let taken = 0
    await start({
      clipboard: {
        watch: () => ({ stop: () => {} }),
        image: async () => shots[taken++] ?? null,
        text: async () => 'never typed',
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    const attached = (name: string) =>
      screenOf(terminal.written).some((row) => row.includes(`▣ ${name}`))
    // ctrl+v under kitty: the picture, as pi takes one at an agent's prompt.
    terminal.press('\x1b[118;5u')
    await until('the first attached', () => attached('one.png'))
    // Cmd+V with a picture and no text: Ghostty passes the key on.
    terminal.press('\x1b[118;9u')
    await until('the second attached', () => attached('two.png'))
    expect(screenOf(terminal.written).some((row) => row.includes('never typed'))).toBe(false)
  })

  it("keeps a pasted screenshot with the orchestrator's own attachments, never in the temp folder", async () => {
    const saved: string[] = []
    await start({
      clipboard: {
        watch: () => ({ stop: () => {} }),
        // The machine's own saving, over an osascript that writes the picture where it is told.
        image: (dir) =>
          clipboardImage(dir, 'darwin', async (_command, args) => {
            const target = /POSIX file "(.+?)"/.exec(args.join(' '))?.[1]
            if (!target) return { ok: false, stdout: '' }
            writeFileSync(target, Buffer.from('89504e470d0a1a0a', 'hex'))
            saved.push(target)
            return { ok: true, stdout: '' }
          }),
        text: async () => 'never typed',
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    terminal.press('\x1b[118;5u')
    await until('attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ tade-clipboard-')),
    )
    const kept = orchestratorAttachments(home)
    expect(saved.map((path) => dirname(path))).toEqual([kept])
    expect(readdirSync(kept)).toEqual([basename(saved[0] ?? '')])
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('tade-clipboard-'))).toEqual([])
  })

  it('watches the clipboard only while the line is open, and never after the window', async () => {
    let started = 0
    let watching = 0
    const app = await start({
      clipboard: {
        watch: () => {
          started += 1
          watching += 1
          return {
            stop: () => {
              watching -= 1
            },
          }
        },
        image: async () => null,
        text: async () => '',
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    await until('the watch, once the line is open', () => watching === 1)
    // Escape on an empty line steps off it, and what the watch costs goes with it.
    terminal.press('\x1b')
    await until('the watch to stop with the line', () => watching === 0)
    terminal.press('\x00')
    await until('a watch again', () => started === 2 && watching === 1)
    await app.stop()
    expect(watching).toBe(0)
  })

  it('asks who a dropped screenshot is for, and sends it with what you say next', async () => {
    const shot = join(tmp('tade-shot-'), 'Screen Shot.png')
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sent: { text: string; images: readonly { mimeType: string }[] }[] = []
    await start({
      thinker: {
        ask: async (text, images = []) => {
          sent.push({ text, images })
          return 'a red square'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // What a terminal types when a file is dropped on it.
    terminal.press(asPaste(shot.replace(/ /g, '\\ ')))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send Screen Shot.png to')),
    )
    terminal.press('\r')
    await until('the picture waiting on the line', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ Screen Shot.png')),
    )
    for (const char of 'what is this') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator to be asked', () => sent.length === 1)
    expect(theirWords(sent[0]?.text)).toBe('what is this')
    expect(sent[0]?.images.map((image) => image.mimeType)).toEqual(['image/png'])
  })

  it('keeps several screenshots, and each can be removed', async () => {
    const dir = tmp('tade-multi-shot-')
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.png')
    writeFileSync(a, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(b, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Drop the first.
    terminal.press(asPaste(a))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send a.png to')),
    )
    terminal.press('\r')
    await until('first attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ a.png')),
    )
    // Drop the second.
    terminal.press(asPaste(b))
    await until('the question again', () =>
      screenOf(terminal.written).some((row) => row.includes('Send b.png to')),
    )
    terminal.press('\r')
    await until('both attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ a.png') && row.includes('▣ b.png')),
    )
    // Remove the first by clicking its ×.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('▣ a.png') && line.includes('▣ b.png'))
    expect(row).toBeGreaterThanOrEqual(0)
    const aX = (lines[row] ?? '').indexOf('×', (lines[row] ?? '').indexOf('▣ a.png'))
    expect(aX).toBeGreaterThanOrEqual(0)
    terminal.press(`\x1b[<0;${aX + 1};${row + 1}M`)
    terminal.press(`\x1b[<0;${aX + 1};${row + 1}m`)
    await until('only the second remains', () =>
      screenOf(terminal.written).some((row) => !row.includes('▣ a.png') && row.includes('▣ b.png')),
    )
  })

  it('attaches a non-image file dropped on the orchestrator', async () => {
    const dir = tmp('tade-file-')
    const txt = join(dir, 'notes.txt')
    writeFileSync(txt, 'these are notes')
    const sent: { text: string; images: readonly { mimeType: string }[] }[] = []
    await start({
      thinker: {
        ask: async (text, images = []) => {
          sent.push({ text, images })
          return 'got it'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press(asPaste(txt))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send notes.txt to')),
    )
    terminal.press('\r')
    await until('the file waiting on the line', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ notes.txt')),
    )
    for (const char of 'read this') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator to be asked', () => sent.length === 1)
    expect(sent[0]?.images).toEqual([])
  })
})
