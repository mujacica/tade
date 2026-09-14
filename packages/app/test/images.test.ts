import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  asPaste,
  clipboardImage,
  clipboardState,
  imagePaths,
  pasted,
  readImage,
  shellQuote,
  shellWords,
} from '../src/images.ts'
import { imageMenuItems } from '../src/panels.ts'

// A terminal never hands a program a picture: a dropped file arrives as its
// path, pasted. These are the rules for recognising one.

describe('a paste', () => {
  it('is what is between the brackets, and nothing when it is a keystroke', () => {
    expect(pasted(asPaste('hello'))).toBe('hello')
    expect(pasted('h')).toBeNull()
  })
})

describe('a dropped picture', () => {
  const exists = (path: string) => path.startsWith('/shots/')

  it('is a path, escaped the way a terminal escapes it', () => {
    expect(imagePaths('/shots/Screenshot\\ 2026-09-14\\ at\\ 01.12.33.png ', exists)).toEqual([
      '/shots/Screenshot 2026-09-14 at 01.12.33.png',
    ])
    expect(imagePaths("'/shots/a b.jpg' /shots/c.webp", exists)).toEqual([
      '/shots/a b.jpg',
      '/shots/c.webp',
    ])
    expect(imagePaths('file:///shots/d%20e.png', exists)).toEqual(['/shots/d e.png'])
  })

  it('is not a sentence that mentions one, a file that is not there, or not a picture', () => {
    expect(imagePaths('look at /shots/a.png please', exists)).toEqual([])
    expect(imagePaths('/elsewhere/a.png', exists)).toEqual([])
    expect(imagePaths('/shots/notes.txt', exists)).toEqual([])
    expect(imagePaths('', exists)).toEqual([])
  })

  it('reads back as one word to a shell', () => {
    expect(shellWords(shellQuote("/shots/it's here.png"))).toEqual(["/shots/it's here.png"])
    expect(shellQuote('/shots/plain.png')).toBe('/shots/plain.png')
  })

  it('is sent as its bytes, and refused when it is not a picture', () => {
    const dir = tmp('wilco-images-')
    const png = join(dir, 'a.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(readImage(png)).toEqual({ path: png, data: 'iVBORw==', mimeType: 'image/png' })
    expect(readImage(join(dir, 'missing.png'))).toBeNull()
    expect(readImage(join(dir, 'a.txt'))).toBeNull()
  })
})

describe('the clipboard', () => {
  it('gives a file when something wrote one, and nothing when it could not', async () => {
    const dir = tmp('wilco-clip-')
    const wrote = await clipboardImage('darwin', dir, async (_command, args) => {
      const target = /POSIX file "(.+?)"/.exec(args.join(' '))?.[1]
      if (!target) return { ok: false, stdout: '' }
      writeFileSync(target, 'png')
      return { ok: true, stdout: '' }
    })
    expect(wrote).toMatch(/wilco-clipboard-.*\.png$/)
    expect(await clipboardImage('darwin', dir, async () => ({ ok: false, stdout: '' }))).toBeNull()
    expect(await clipboardImage('win32', dir, async () => ({ ok: true, stdout: '' }))).toBeNull()
  })

  it('gives a picture file copied in Finder as that file', async () => {
    const dir = tmp('wilco-clip-')
    const shot = join(dir, 'shot.png')
    writeFileSync(shot, 'png')
    const found = await clipboardImage('darwin', dir, async (_command, args) =>
      args.join(' ').includes('furl')
        ? { ok: true, stdout: `${shot}\n` }
        : { ok: false, stdout: '' },
    )
    expect(found).toBe(shot)
  })
})

describe('who a picture is for', () => {
  it('offers the orchestrator, the agent in front first, and the terminal', () => {
    const items = imageMenuItems({
      agents: [
        { task: 'shop/b', name: 'b', running: false, focused: false },
        { task: 'shop/a', name: 'a', running: true, focused: true },
      ],
      terminal: { id: 'shop/terminals/1', name: 'tests' },
    })
    expect(items.map((item) => item.id)).toEqual([
      'orchestrator',
      'agent:shop/a',
      'agent:shop/b',
      'terminal:shop/terminals/1',
    ])
    expect(items.find((item) => item.id === 'agent:shop/b')?.off).toBe('its agent is not running')
  })
})

describe('a picture on the clipboard', () => {
  it('is told apart by which copy it is, on macOS and Linux', async () => {
    expect(await clipboardState('darwin', async () => ({ ok: true, stdout: '324 1\n' }))).toEqual({
      copy: '324',
      image: true,
    })
    expect(await clipboardState('darwin', async () => ({ ok: true, stdout: '325 0' }))).toEqual({
      copy: '325',
      image: false,
    })
    expect(await clipboardState('darwin', async () => ({ ok: false, stdout: '' }))).toBeNull()
    expect(
      await clipboardState('linux', async (command) => ({
        ok: command === 'wl-paste',
        stdout: command === 'wl-paste' ? 'image/png\ntext/plain\n' : '',
      })),
    ).toMatchObject({ image: true })
    expect(await clipboardState('win32')).toBeNull()
  })
})
