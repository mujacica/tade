import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  asPaste,
  type ClipboardCopy,
  clipboardImage,
  clipboardText,
  filePaths,
  handOffFiles,
  imagePaths,
  pasted,
  readImage,
  shellQuote,
  shellWords,
  watchClipboard,
} from '../src/images.ts'
import { imageMenuItems } from '../src/panels/menu/state.ts'

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
  it('are copied into the task’s own folder and named in full, pictures sent along', async () => {
    const from = tmp('tade-attached-')
    const shot = join(from, 'shot.png')
    const notes = join(from, 'notes.txt')
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(notes, 'the numbers')
    // Where `taskDir` puts them: Tade's home, never the agent's checkout.
    const dir = join(tmp('tade-own-'), 'projects', 'app', 'tasks', 'refunds', 'attachments')

    const handed = await handOffFiles([shot, notes, join(from, 'deleted.png')], dir)
    expect(existsSync(join(dir, 'shot.png'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    // The whole path, because it is nowhere the agent would look otherwise.
    expect(handed.note).toBe(
      `Attachments are in ${dir}/: shot.png, notes.txt. Also attached, but gone before it could be copied: deleted.png.`,
    )
    expect(handed.images.map((image) => image.mimeType)).toEqual(['image/png'])
  })

  it('are nothing at all when nothing was attached', async () => {
    const dir = join(tmp('tade-own-'), 'attachments')
    expect(await handOffFiles([], dir)).toEqual({ note: '', images: [] })
    // Not even the folder: a folder nobody put anything in is litter too.
    expect(existsSync(dir)).toBe(false)
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
    // Whoever it was pasted to may have no attachments yet: the folder is made.
    const dir = join(tmp('tade-clip-'), 'orchestrator', 'attachments')
    const wrote = await clipboardImage(dir, 'darwin', async (_command, args) => {
      const target = /POSIX file "(.+?)"/.exec(args.join(' '))?.[1]
      if (!target) return { ok: false, stdout: '' }
      writeFileSync(target, 'png')
      return { ok: true, stdout: '' }
    })
    expect(wrote).toMatch(/tade-clipboard-.*\.png$/)
    expect(dirname(wrote ?? '')).toBe(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(await clipboardImage(dir, 'darwin', async () => ({ ok: false, stdout: '' }))).toBeNull()
    expect(readdirSync(dir)).toEqual([basename(wrote ?? '')])
    // Nothing can save one there, so nothing is made for it either.
    const nowhere = join(tmp('tade-clip-'), 'attachments')
    expect(
      await clipboardImage(nowhere, 'win32', async () => ({ ok: true, stdout: '' })),
    ).toBeNull()
    expect(existsSync(nowhere)).toBe(false)
  })

  it('keeps a picture a week, and takes older ones away as the next is saved', async () => {
    // Handed on by its path, so nothing says when it is done with: in the
    // temp folder, and then here, every one of them stayed for good.
    const dir = join(tmp('tade-clip-'), 'orchestrator', 'attachments')
    const save = (_command: string, args: string[]) => {
      const target = /POSIX file "(.+?)"/.exec(args.join(' '))?.[1]
      if (target) writeFileSync(target, 'png')
      return Promise.resolve({ ok: Boolean(target), stdout: '' })
    }
    const days = (n: number) => (Date.now() - n * 24 * 60 * 60 * 1000) / 1000
    const old = (await clipboardImage(dir, 'darwin', save)) ?? ''
    utimesSync(old, days(8), days(8))
    const recent = (await clipboardImage(dir, 'darwin', save)) ?? ''
    utimesSync(recent, days(6), days(6))

    const now = (await clipboardImage(dir, 'darwin', save)) ?? ''
    expect(readdirSync(dir).sort()).toEqual([basename(recent), basename(now)].sort())
  })

  it('gives a picture file copied in Finder as that file', async () => {
    const dir = tmp('tade-clip-')
    const shot = join(dir, 'shot.png')
    writeFileSync(shot, 'png')
    const found = await clipboardImage(dir, 'darwin', async (_command, args) =>
      args.join(' ').includes('furl')
        ? { ok: true, stdout: `${shot}\n` }
        : { ok: false, stdout: '' },
    )
    expect(found).toBe(shot)
  })

  it('reads its text for ctrl+v, says none where it holds none, and null where it cannot tell', async () => {
    const asked: string[] = []
    const answering =
      (answers: Record<string, { ok: boolean; stdout: string }>) =>
      async (command: string, args: string[]) => {
        asked.push([command, ...args].join(' '))
        return answers[command] ?? { ok: false, stdout: '' }
      }
    const text = 'héllo – tade ✓\nsecond line'
    expect(await clipboardText('darwin', answering({ pbpaste: { ok: true, stdout: text } }))).toBe(
      text,
    )
    // A screenshot has no text, which is not the same as not being able to look.
    expect(await clipboardText('darwin', answering({ pbpaste: { ok: true, stdout: '' } }))).toBe('')
    expect(await clipboardText('darwin', answering({}))).toBeNull()
    asked.length = 0
    // Linux asks Wayland, then X.
    expect(await clipboardText('linux', answering({ xclip: { ok: true, stdout: 'x11' } }))).toBe(
      'x11',
    )
    expect(asked).toEqual(['wl-paste --no-newline --type text', 'xclip -selection clipboard -o'])
    expect(await clipboardText('win32', answering({ pbpaste: { ok: true, stdout: 'no' } }))).toBe(
      null,
    )
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

/** What a watch told, and a way to wait for the next of it that needs no clock. */
function listening() {
  const told: (ClipboardCopy | null)[] = []
  let wake = () => {}
  return {
    told,
    hear: (found: ClipboardCopy | null) => {
      told.push(found)
      wake()
    },
    heard: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (told.length >= count) resolve()
          else wake = check
        }
        check()
      }),
  }
}

/** Is this process still there? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Which process group a process is in, or null where nothing can be asked. */
function groupOf(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Waits on a thing the machine does, never on a sleep it is measured over. */
async function eventually(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('a picture on the clipboard', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is watched on macOS by one process of its own, told a line at a time, until stopped', async () => {
    // A stand-in for osascript that says its own pid as the copy, then a line
    // split across two writes, then something that is not a line of its at all.
    const script = `process.stdout.write(process.pid + ' 1\\n12'); setTimeout(() => process.stdout.write(' 0\\nnonsense\\n'), 20); setInterval(() => {}, 1000)`
    const { told, hear, heard } = listening()
    const watch = watchClipboard(hear, {
      platform: 'darwin',
      watcher: { command: process.execPath, args: ['-e', script] },
    })
    await heard(2)
    const pid = Number(told[0]?.copy)
    expect(told).toEqual([
      { copy: String(pid), image: true },
      { copy: '12', image: false },
    ])
    // Its own process group, or Terminal names the window after it.
    const theirs = groupOf(pid)
    if (theirs) expect(theirs).toBe(String(pid))
    watch.stop()
    watch.stop()
    await eventually(() => !alive(pid), 'the watcher to be stopped')
    // Stopped is not "cannot tell": nothing more is said.
    expect(told).toHaveLength(2)
  })

  it('says a watcher that ended by itself as unknown, and starts another a while later, not at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { told, hear, heard } = listening()
    const watch = watchClipboard(hear, {
      platform: 'darwin',
      watcher: { command: process.execPath, args: ['-e', `process.stdout.write('5 0\\n')`] },
    })
    await heard(2)
    expect(told).toEqual([{ copy: '5', image: false }, null])
    // The next one waits on a timer, which is the only thing that starts it.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await heard(3)
    expect(told[2]).toEqual({ copy: '5', image: false })
    watch.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is asked on Linux every few seconds, one ask at a time, until stopped', async () => {
    vi.useFakeTimers()
    const { told, hear } = listening()
    let types = 'image/png\ntext/plain\n'
    const watch = watchClipboard(hear, {
      platform: 'linux',
      exec: async (command) => ({
        ok: command === 'wl-paste',
        stdout: command === 'wl-paste' ? types : '',
      }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(told).toEqual([{ copy: 'image/png\ntext/plain', image: true }])
    types = 'text/plain\n'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(told.at(-1)).toEqual({ copy: 'text/plain', image: false })
    watch.stop()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(told).toHaveLength(2)
  })

  it('falls back to xclip on Linux, and says null where nothing can read it', async () => {
    vi.useFakeTimers()
    const xclip = listening()
    const none = listening()
    const watches = [
      watchClipboard(xclip.hear, {
        platform: 'linux',
        exec: async (command) => ({
          ok: command === 'xclip',
          stdout: command === 'xclip' ? 'TARGETS\nimage/png\n' : '',
        }),
      }),
      watchClipboard(none.hear, {
        platform: 'linux',
        exec: async () => ({ ok: false, stdout: '' }),
      }),
    ]
    await vi.advanceTimersByTimeAsync(0)
    for (const watch of watches) watch.stop()
    expect(xclip.told).toEqual([{ copy: 'TARGETS\nimage/png', image: true }])
    expect(none.told).toEqual([null])
  })

  it('is told nothing on Linux once stopped, even an answer already on its way', async () => {
    vi.useFakeTimers()
    const { told, hear } = listening()
    watchClipboard(hear, {
      platform: 'linux',
      exec: async () => ({ ok: true, stdout: 'image/png\n' }),
    }).stop()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(told).toEqual([])
  })

  it('is told nothing anywhere else', () => {
    const { told, hear } = listening()
    watchClipboard(hear, { platform: 'win32' }).stop()
    expect(told).toEqual([])
  })

  // The real watcher, on the one platform it runs on. It reads the
  // pasteboard's count and the kinds of thing on it — never what was copied.
  it.runIf(process.platform === 'darwin')(
    'ends itself on macOS once the window that started it is gone, crash or not',
    async () => {
      const images = fileURLToPath(new URL('../src/images.ts', import.meta.url))
      // A window that starts the watch, says the watcher's pid once it has
      // heard from it, and goes without stopping anything — as a crash would.
      const window = `
        import { execFileSync } from 'node:child_process'
        const { watchClipboard } = await import(${JSON.stringify(images)})
        watchClipboard((found) => {
          if (!found) return
          const pid = execFileSync('pgrep', ['-P', String(process.pid), 'osascript'], { encoding: 'utf8' }).trim()
          process.stdout.write(pid + ' ' + found.copy + '\\n', () => process.exit(0))
        })
        setInterval(() => {}, 1000)
      `
      const child = spawn(process.execPath, ['--input-type=module', '-e', window], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let said = ''
      child.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
      })
      await new Promise((resolve) => child.once('close', resolve))
      const [pid, copy] = said.trim().split(' ')
      expect(copy).toMatch(/^\d+$/)
      await eventually(() => !alive(Number(pid)), 'the watcher to end with its window')
    },
  )
})
