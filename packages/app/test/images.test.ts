import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  asPaste,
  clipboardImage,
  clipboardState,
  filePaths,
  handOffFiles,
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
    const dir = tmp('tade-images-')
    const png = join(dir, 'a.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(readImage(png)).toEqual({ path: png, data: 'iVBORw==', mimeType: 'image/png' })
    expect(readImage(join(dir, 'missing.png'))).toBeNull()
    expect(readImage(join(dir, 'a.txt'))).toBeNull()
  })
})

describe('files handed to an agent', () => {
  it('are copied where it works and named in what it is told, pictures sent along', async () => {
    const from = tmp('tade-attached-')
    const shot = join(from, 'shot.png')
    const notes = join(from, 'notes.txt')
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(notes, 'the numbers')
    const cwd = tmp('tade-checkout-')

    const handed = await handOffFiles([shot, notes, join(from, 'deleted.png')], cwd)
    expect(existsSync(join(cwd, '.tade', 'attachments', 'shot.png'))).toBe(true)
    expect(existsSync(join(cwd, '.tade', 'attachments', 'notes.txt'))).toBe(true)
    expect(handed.note).toBe(
      'Attachments are in .tade/attachments/: shot.png, notes.txt. Also attached, but gone before it could be copied: deleted.png.',
    )
    expect(handed.images.map((image) => image.mimeType)).toEqual(['image/png'])
  })

  it('are nothing at all when nothing was attached', async () => {
    const cwd = tmp('tade-checkout-')
    expect(await handOffFiles([], cwd)).toEqual({ note: '', images: [] })
    // Not even the folder: an agent's checkout is not ours to litter.
    expect(existsSync(join(cwd, '.tade'))).toBe(false)
  })
})

describe('a dropped file', () => {
  const exists = (path: string) => path.startsWith('/shots/')

  it('includes non-image files as well as pictures', () => {
    expect(filePaths('/shots/Screenshot.png /shots/notes.txt', exists)).toEqual([
      '/shots/Screenshot.png',
      '/shots/notes.txt',
    ])
    expect(filePaths("'/shots/a b.jpg' /shots/c.txt", exists)).toEqual([
      '/shots/a b.jpg',
      '/shots/c.txt',
    ])
  })

  it('is not a sentence that mentions a path', () => {
    expect(filePaths('look at /shots/a.png please', exists)).toEqual([])
    expect(filePaths('/elsewhere/a.png', exists)).toEqual([])
    expect(filePaths('', exists)).toEqual([])
  })
})

describe('the clipboard', () => {
  it('gives a file when something wrote one, and nothing when it could not', async () => {
    const dir = tmp('tade-clip-')
    const wrote = await clipboardImage('darwin', dir, async (_command, args) => {
      const target = /POSIX file "(.+?)"/.exec(args.join(' '))?.[1]
      if (!target) return { ok: false, stdout: '' }
      writeFileSync(target, 'png')
      return { ok: true, stdout: '' }
    })
    expect(wrote).toMatch(/tade-clipboard-.*\.png$/)
    expect(await clipboardImage('darwin', dir, async () => ({ ok: false, stdout: '' }))).toBeNull()
    expect(await clipboardImage('win32', dir, async () => ({ ok: true, stdout: '' }))).toBeNull()
  })

  it('gives a picture file copied in Finder as that file', async () => {
    const dir = tmp('tade-clip-')
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
