import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { located, runProgram } from '@tade/core'

// Pictures: screenshots dropped on the window or pasted into it.
//
// A terminal never hands a program an image. Dropping a file types its path,
// pasting types whatever text the clipboard has, and a screenshot copied to
// the clipboard has none — so a picture is either a path that arrived as a
// paste, or something read off the clipboard when you press ctrl+v. Which of
// the orchestrator and an agent it was meant for cannot be read from a drop,
// so the window asks; this file only works out what arrived.

/** What a model accepts, by the extension a file has. */
const TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** A model will not take more than this in one picture, and a terminal should not carry it. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

// What a paste looks like is the editing model's (`input.ts`), and one
// decoder answers for all of it: the two that used to live here and in the
// file editor already disagreed about which end marker ends a paste.
export { asPaste, pastedText as pasted } from './input.ts'

export function isImagePath(path: string): boolean {
  return TYPES[extname(path).toLowerCase()] !== undefined
}

/**
 * The words of a line the way a shell reads them: `\ ` and quotes keep a
 * space inside a word, which is how a terminal writes the path of a dropped
 * file with spaces in its name.
 */
export function shellWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < text.length) word += text[++i]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && i + 1 < text.length) {
      word += text[++i]
      started = true
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word)
      word = ''
      started = false
    } else {
      word += char
    }
  }
  if (started || word) words.push(word)
  return words
}

/**
 * The pictures a paste is made of, when that is all it is: one path or
 * several, as a terminal writes them for dropped files, each an image that is
 * there. Anything else — a sentence that mentions a screenshot — is text, and
 * gets an empty list.
 */
export function imagePaths(text: string, exists: (path: string) => boolean = existsSync): string[] {
  const words = shellWords(text.trim()).map((word) =>
    word.startsWith('file://') ? decodeURIComponent(word.slice('file://'.length)) : word,
  )
  if (words.length === 0) return []
  return words.every((word) => word.startsWith('/') && isImagePath(word) && exists(word))
    ? words
    : []
}

/**
 * Every file path a paste is made of, when that is all it is: one path or
 * several, as a terminal writes them for dropped files, each a file that is
 * there. Anything else — a sentence that mentions a path — is text, and gets
 * an empty list.
 */
export function filePaths(text: string, exists: (path: string) => boolean = existsSync): string[] {
  const words = shellWords(text.trim()).map((word) =>
    word.startsWith('file://') ? decodeURIComponent(word.slice('file://'.length)) : word,
  )
  if (words.length === 0) return []
  return words.every((word) => word.startsWith('/') && exists(word)) ? words : []
}

/** A path written so a shell reads it back as one word. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/** A picture to send: its bytes, base64, and what kind of picture. Null when it cannot be. */
export function readImage(path: string): { path: string; data: string; mimeType: string } | null {
  const mimeType = TYPES[extname(path).toLowerCase()]
  if (!mimeType) return null
  try {
    if (statSync(path).size > IMAGE_MAX_BYTES) return null
    return { path, data: readFileSync(path).toString('base64'), mimeType }
  } catch {
    return null
  }
}

/**
 * Files handed to an agent: copied into the task's own attachments folder, so
 * it can open them, a sentence saying where they are, and the pictures among
 * them to send with its prompt. A file gone by now is said to be gone, rather
 * than dropped without a word.
 *
 * The folder is Tade's, not the repository's, so the sentence carries the
 * whole path: a screenshot somebody pasted is nobody else's, and putting one
 * where `git status` can see it is what made every project need a rule about
 * Tade's files.
 */
export async function handOffFiles(
  paths: readonly string[],
  dir: string,
): Promise<{ note: string; images: { path: string; data: string; mimeType: string }[] }> {
  if (paths.length === 0) return { note: '', images: [] }
  const copied: string[] = []
  const gone: string[] = []
  const images: { path: string; data: string; mimeType: string }[] = []
  for (const path of paths) {
    const name = basename(path)
    try {
      await mkdir(dir, { recursive: true })
      await copyFile(path, join(dir, name))
      copied.push(name)
      const image = readImage(path)
      if (image) images.push(image)
    } catch {
      gone.push(name)
    }
  }
  const notes = [
    copied.length === 1
      ? `An attachment is at ${join(dir, copied[0] ?? '')}.`
      : copied.length > 1
        ? `Attachments are in ${dir}/: ${copied.join(', ')}.`
        : '',
    gone.length > 0 ? `Also attached, but gone before it could be copied: ${gone.join(', ')}.` : '',
  ]
  return { note: notes.filter(Boolean).join(' '), images }
}

type Run = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const run: Run = async (command, args) => {
  const ran = await runProgram(command, args, { timeoutMs: 5_000 })
  return { ok: ran.code === 0, stdout: ran.stdout }
}

/**
 * What is on the clipboard: which copy it is — a number that changes whenever
 * anything is copied, so a picture already offered, or attached, is not
 * offered again — and whether it is a picture.
 */
export interface ClipboardCopy {
  copy: string
  image: boolean
}

/** A clipboard being watched. Stopping it ends whatever was watching; twice is fine. */
export interface ClipboardWatch {
  stop(): void
}

/** Watch the clipboard: told what is on it, null where that cannot be told, until stopped. */
export type WatchClipboard = (told: (found: ClipboardCopy | null) => void) => ClipboardWatch

/** How often the clipboard is asked, where it cannot be watched. */
export const CLIPBOARD_ASK_MS = 3_000

/** How long after a watcher ended by itself another is started. */
const WATCH_AGAIN_MS = 30_000

/**
 * The macOS watcher, run by `osascript`: the pasteboard's count looked at once
 * a second inside it, and a line — the count, then 1 for a picture — written
 * only when the count moved. It ends itself once Tade is no longer its parent:
 * a window killed outright runs no stop, and what it started is handed to
 * launchd, which is what `getppid` says from then on.
 */
const WATCHER = `function run(argv) {
  ObjC.import('AppKit'); ObjC.import('unistd')
  var tade = Number(argv[0]), out = $.NSFileHandle.fileHandleWithStandardOutput
  var pb = $.NSPasteboard.generalPasteboard, last = -1
  while ($.getppid() === tade) {
    var copy = pb.changeCount
    if (copy !== last) {
      last = copy
      var image = (ObjC.deepUnwrap(pb.types) || []).some(function (t) { return /png|tiff/i.test(t) })
      out.writeData($(copy + ' ' + (image ? 1 : 0) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
    }
    delay(1)
  }
}`

export interface WatchOptions {
  platform?: NodeJS.Platform
  /** What watches, where the clipboard is watched: `osascript` running `WATCHER` unless given. */
  watcher?: { command: string; args: readonly string[] }
  /** What asks, where the clipboard is asked. */
  exec?: Run
  /** How often it is asked. */
  everyMs?: number
}

/**
 * The clipboard, watched: `told` hears which copy is on it and whether that is
 * a picture as soon as it can be told, again whenever it changes, and null
 * where it cannot be told — until `stop`.
 *
 * Cmd+V on a picture pastes nothing in most macOS terminals — they paste
 * text, and a screenshot has none — so the window has to notice the picture
 * itself to offer it. It used to ask: an `osascript` every three seconds while
 * the orchestrator's line was open, twenty processes a minute, each spawned on
 * the thread that draws. On macOS one watcher now lives for as long as it is
 * wanted, in its own process group like everything Tade starts, and costs
 * nothing between copies; Linux has no count to watch, so it is still asked
 * every few seconds, through `runProgram`. Anywhere else nothing is told.
 *
 * A watcher that ends by itself is said as null and started again a while
 * later, never at once, so a machine where it cannot run is not asked twenty
 * times a minute instead.
 */
export function watchClipboard(
  told: (found: ClipboardCopy | null) => void,
  options: WatchOptions = {},
): ClipboardWatch {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin')
    return watched(
      told,
      options.watcher ?? {
        command: 'osascript',
        args: ['-l', 'JavaScript', '-e', WATCHER, String(process.pid)],
      },
    )
  if (platform === 'linux')
    return asked(told, options.exec ?? run, options.everyMs ?? CLIPBOARD_ASK_MS)
  return { stop: () => {} }
}

/** A watcher's line: the count, then 1 for a picture. Null for anything else. */
function copyOf(line: string): ClipboardCopy | null {
  const [copy, image] = line.trim().split(' ')
  return copy && /^\d+$/.test(copy) ? { copy, image: image === '1' } : null
}

/** One long-lived watcher, read a line at a time. */
function watched(
  told: (found: ClipboardCopy | null) => void,
  watcher: { command: string; args: readonly string[] },
): ClipboardWatch {
  let child: ChildProcess | null = null
  let again: NodeJS.Timeout | undefined
  let stopped = false
  const later = () => {
    if (stopped) return
    told(null)
    again = setTimeout(start, WATCH_AGAIN_MS)
    again.unref()
  }
  function start(): void {
    let one: ChildProcess
    try {
      // Its own process group, or Terminal names the window after it for as
      // long as it lives, which here is as long as the line is open.
      one = spawn(located(watcher.command), [...watcher.args], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      later()
      return
    }
    child = one
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      if (child === one) child = null
      later()
    }
    // A spawn that fails does so asynchronously, and an unhandled `error` on a
    // child takes the window down with it.
    one.once('error', end)
    one.once('close', end)
    let partial = ''
    one.stdout?.setEncoding('utf8')
    one.stdout?.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const found = copyOf(line)
        if (found && !stopped) told(found)
      }
    })
    // Never what keeps the window's process alive: its stop, or Tade being
    // gone, ends it.
    one.unref()
    ;(one.stdout as Socket | null)?.unref()
  }
  start()
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearTimeout(again)
      try {
        child?.kill()
      } catch {
        // Already gone, which is what was wanted.
      }
    },
  }
}

/** Asked every `everyMs`, one ask at a time. */
function asked(
  told: (found: ClipboardCopy | null) => void,
  exec: Run,
  everyMs: number,
): ClipboardWatch {
  let stopped = false
  let asking = false
  const ask = () => {
    if (asking) return
    asking = true
    void askLinux(exec)
      .catch(() => null)
      .then((found) => {
        if (!stopped) told(found)
      })
      .finally(() => {
        asking = false
      })
  }
  ask()
  const timer = setInterval(ask, everyMs)
  timer.unref()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** What Linux's clipboard holds, asked of wl-paste, then xclip. */
async function askLinux(exec: Run): Promise<ClipboardCopy | null> {
  const listed =
    (await exec('wl-paste', ['--list-types'])).stdout ||
    (await exec('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])).stdout
  if (!listed) return null
  // No count to tell copies apart: the types stand in for one.
  return { copy: listed.trim(), image: /image\/(png|jpeg|tiff)/.test(listed) }
}

/**
 * Whatever picture is on the clipboard, saved to a file. Null when there is
 * none, or nothing on this machine can read one.
 *
 * macOS needs nothing installed: AppleScript can write the clipboard's PNG
 * out. Linux asks wl-paste, then xclip.
 */
export async function clipboardImage(
  platform: NodeJS.Platform = process.platform,
  dir: string = tmpdir(),
  exec: Run = run,
): Promise<string | null> {
  const path = join(dir, `tade-clipboard-${randomUUID()}.png`)
  if (platform === 'darwin') {
    // A picture file copied in Finder is on the clipboard as the file, not its pixels.
    const copied = await exec('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'])
    const file = copied.stdout.trim()
    if (copied.ok && file.startsWith('/') && isImagePath(file) && existsSync(file)) return file
  }
  const saved =
    platform === 'darwin'
      ? await exec('osascript', [
          '-e',
          `set f to open for access (POSIX file ${JSON.stringify(path)}) with write permission`,
          '-e',
          'try',
          '-e',
          'write (the clipboard as «class PNGf») to f',
          '-e',
          'on error',
          '-e',
          'close access f',
          '-e',
          'error number -1',
          '-e',
          'end try',
          '-e',
          'close access f',
        ]).then((done) => done.ok)
      : platform === 'linux'
        ? (await exec('sh', ['-c', `wl-paste --type image/png > ${shellQuote(path)}`])).ok ||
          (
            await exec('sh', [
              '-c',
              `xclip -selection clipboard -t image/png -o > ${shellQuote(path)}`,
            ])
          ).ok
        : false
  try {
    if (saved && statSync(path).size > 0) return path
  } catch {
    // Nothing was written.
  }
  rmSync(path, { force: true })
  return null
}
