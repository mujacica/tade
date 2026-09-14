import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

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

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** The text of a bracketed paste, or null when this is not one. */
export function pasted(data: string): string | null {
  if (!data.startsWith(PASTE_START)) return null
  const end = data.lastIndexOf(PASTE_END)
  return data.slice(PASTE_START.length, end < 0 ? undefined : end)
}

/** Text wrapped the way a terminal wraps a paste, for a program that asked for them. */
export function asPaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`
}

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

type Run = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const run: Run = (command, args) =>
  new Promise((done) => {
    execFile(command, args, detachedFor(5_000), (err, stdout) =>
      done({ ok: !err, stdout: String(stdout ?? '') }),
    )
  })

/**
 * Whether the clipboard holds a picture, and which copy it is: a number that
 * changes whenever anything is copied, so a picture already offered, or
 * attached, is not offered again. Null where it cannot be told.
 *
 * Asked, never waited on: Cmd+V on a picture pastes nothing in most macOS
 * terminals — they paste text, and a screenshot has none — so the window has
 * to notice the picture itself to offer it.
 */
export async function clipboardState(
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Promise<{ copy: string; image: boolean } | null> {
  if (platform === 'darwin') {
    const asked = await exec('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); var pb = $.NSPasteboard.generalPasteboard; var t = ObjC.deepUnwrap(pb.types) || []; pb.changeCount + " " + (t.some(function (x) { return /png|tiff/i.test(x) }) ? 1 : 0)',
    ])
    const [copy, image] = asked.stdout.trim().split(' ')
    return asked.ok && copy ? { copy, image: image === '1' } : null
  }
  if (platform === 'linux') {
    const listed =
      (await exec('wl-paste', ['--list-types'])).stdout ||
      (await exec('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])).stdout
    if (!listed) return null
    // No count to tell copies apart: the types stand in for one.
    return { copy: listed.trim(), image: /image\/(png|jpeg|tiff)/.test(listed) }
  }
  return null
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
  const path = join(dir, `wilco-clipboard-${randomUUID()}.png`)
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

/**
 * Options for a short-lived helper in its own process group, so the terminal
 * Wilco runs in never names its window after it. `execFile` passes `detached`
 * on to the spawn beneath it; its types just do not say so.
 */
function detachedFor(timeout: number): { timeout: number } {
  const options = { timeout, detached: true }
  return options
}
