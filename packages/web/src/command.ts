import { isText, printableLines } from '@tade/core'
import { ELIDED } from './fields.ts'
import { withoutCredentials } from './screen.ts'

// The command an approval asks about, as it may leave the machine.
//
// **Why it leaves at all.** A phone that can answer an approval used to be
// shown the tool's name and nothing else, so that no absolute path ever left
// the machine — and on a box with no screen, the phone is where the person says
// yes. Saying yes to a command you cannot see is what an approval exists to
// prevent. So a device that may answer is shown what it is answering, as the
// card at the machine draws it (`view/approval.ts`): the whole command, read
// `'whole'` so a character that is not text is a mark and never taken out with
// whatever it hid (`printable`).
//
// **What changes on the way out is the paths, and only by this one rule**
// (`shortenPaths`). Where the task works becomes `.`, Tade's own home becomes
// `~/.tade` wherever it really is, and the home directory becomes `~`; any
// other absolute path is its last name behind `…/`, so no absolute path
// outside those three leaves as itself. And every key Tade holds, and anything
// shaped like a credential, is taken out by the screen's own rule
// (`withoutCredentials`), because a command is something an agent wrote and an
// agent writes keys into commands.
//
// **Lexical, on purpose.** Nothing here asks the disk. A symlink is named as
// the command names it, never followed — following it would show somebody a
// path that is not the one they are approving, and would be I/O on the thread
// the window draws on. A path that climbs out of a place with `..` is not in
// it, so `./../../etc` can never carry an absolute path out in pieces; a root
// reached by another spelling (`/private/var` for `/var`) is not that root, and
// is cut like any other path outside. Erring that way is the point: a path cut
// that need not have been is a shorter line, and a path let through that should
// not have been is the leak.
//
// Pure: no `node:` import, no clock, nothing awaited.

/** The three places a path may be shortened to, as the window knows them. */
export interface Places {
  /** Where the task works — its worktree, or the project's checkout — which becomes `.`. */
  work: string | null
  /** Tade's own home, which becomes `~/.tade` wherever it really is. */
  tade: string | null
  /** The home directory of whoever runs Tade, which becomes `~`. */
  home: string | null
}

/** One place, and what it is spelt as on the way out. */
interface Root {
  at: string
  as: string
  /** Two names or more: one that cannot turn up inside a relative path by chance. */
  deep: boolean
}

/**
 * The command an approval asks about, as a device that may answer it reads it:
 * credentials out, paths shortened, then read whole. `known` is every value the
 * window knows to be a key (`knownKeys`).
 */
export function commandOut(summary: string, places: Places, known: readonly string[]): string {
  return printableLines(shortenPaths(withoutCredentials(summary, known), places), 'whole')
}

/**
 * A command as much of it as `most` code points, and how many characters were
 * not sent — line breaks not counted, as the card at the machine counts them —
 * so a page says how much more there is rather than drawing it as whole.
 * Under `BUDGET` `most` is whole and every command goes out as it is.
 */
export function commandShown(text: string, most: number): { text: string; notShown: number } {
  if (text.length <= most) return { text, notShown: 0 }
  const points = [...text]
  if (points.length <= most) return { text, notShown: 0 }
  const left = points.slice(most).filter((one) => one !== '\n').length
  return { text: points.slice(0, most).join(''), notShown: left }
}

/**
 * Text with every absolute path in it shortened: a place in `places` to its
 * short spelling, anything else to its last name behind `…/`.
 *
 * A path starts at a `/` after anything that cannot be part of a name — the
 * start, a space, a quote, `=`, `:`, a bracket, a redirection — after a flag
 * glued to it (`-I/usr/include`), or wherever one of the three places begins.
 * It runs to the next space, quote or shell punctuation; one that opens right
 * after a quote runs to the quote that closes it, spaces and all; and `\ ` is
 * part of it. `scheme://` is an address and is left alone, except `file://`.
 */
export function shortenPaths(text: string, places: Places): string {
  return shortened(text, rootsOf(places))
}

function shortened(text: string, roots: readonly Root[]): string {
  let out = ''
  let copied = 0
  let at = 0
  while (at < text.length) {
    const from = startAt(text, at, roots)
    if (from === null) {
      at += 1
      continue
    }
    const to = endOf(text, from)
    out += text.slice(copied, from) + rewritten(text.slice(from, to), roots)
    copied = to
    at = Math.max(to, at + 1)
  }
  return out + text.slice(copied)
}

/**
 * The places, longest first so the narrowest one wins — a project under the
 * home is `.`, not `~/code/app` — each also as a shell spells it with its
 * spaces escaped. A place that is not absolute, or is `/` itself, shortens
 * nothing.
 */
function rootsOf(places: Places): Root[] {
  const roots: Root[] = []
  const add = (path: string | null, as: string): void => {
    const at = (path ?? '').replace(/\/+$/, '')
    if (!at.startsWith('/')) return
    const deep = at.split('/').filter((one) => one !== '').length >= 2
    roots.push({ at, as, deep })
    if (at.includes(' ')) roots.push({ at: at.replaceAll(' ', '\\ '), as, deep })
  }
  add(places.work, '.')
  add(places.tade, '~/.tade')
  add(places.home, '~')
  return roots.sort((a, b) => b.at.length - a.at.length)
}

/**
 * Where a path starts at `at`, or null. `file://` is answered with where the
 * path after it starts; any other `scheme://` with null, and the address is
 * then read as text, whose own `/`s never start one (`isName`).
 */
function startAt(text: string, at: number, roots: readonly Root[]): number | null {
  const one = text[at]
  if (one === '/') {
    if (at === 0) return at
    // Glued to a name, a place is still a place (`$DESTDIR/Users/me/x`) — but
    // only one of two names or more, or `src/app/x` would be read as `/app`.
    if (roots.some((root) => root.deep && rootHere(text, at, root.at))) return at
    const before = text[at - 1] ?? ''
    if (before === '/') return null
    if (before === ':' && text[at + 1] === '/') {
      const scheme = schemeBefore(text, at - 1)
      if (scheme === null) return at
      return scheme.toLowerCase() === 'file' && text[at + 2] === '/' ? at + 2 : null
    }
    if (!isName(before)) return at
    return flagBefore(text, at) ? at : null
  }
  // A drive letter, `C:\…`, at a boundary: nothing on this machine, so cut.
  if (driveAt(text, at)) return at === 0 || !isName(text[at - 1] ?? '') ? at : null
  return null
}

/** Whether `C:\` or `C:/` begins at `at`. */
function driveAt(text: string, at: number): boolean {
  return text[at + 1] === ':' && /[\\/]/.test(text[at + 2] ?? '') && /[A-Za-z]/.test(text[at] ?? '')
}

/** Whether a place begins at `at` and ends where a name does. */
function rootHere(text: string, at: number, root: string): boolean {
  if (!text.startsWith(root, at)) return false
  const after = text[at + root.length]
  return after === undefined || after === '/' || ends(after)
}

/** The scheme before a `:` at `colon`, where the word up to it is one, or null. */
function schemeBefore(text: string, colon: number): string | null {
  let from = colon
  while (from > 0 && /[A-Za-z0-9+.-]/.test(text[from - 1] ?? '')) from -= 1
  const scheme = text.slice(from, colon)
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) ? scheme : null
}

/** Whether the name glued to the `/` at `at` is a flag: `-I`, `-isystem`, `--prefix`. */
function flagBefore(text: string, at: number): boolean {
  let from = at
  while (from > 0 && isName(text[from - 1] ?? '')) from -= 1
  return /^--?[A-Za-z]/.test(text.slice(from, at))
}

/**
 * Whether a character can be part of a name before a `/` — so the `/` after
 * it continues a relative path (`src/a.ts`, `$HOME/x`, `${X}/y`, `$(pwd)/z`,
 * `~/w`) rather than starting an absolute one.
 */
function isName(one: string): boolean {
  return /[\p{L}\p{N}\p{M}._~$})*?%+-]/u.test(one)
}

/** Whether a character ends a path: a space, a quote, shell punctuation, or not text. */
function ends(one: string): boolean {
  if (/[\s"'`;|&<>(){}[\],:=]/.test(one)) return true
  return !isText(one.codePointAt(0) ?? 0)
}

/** Where the path starting at `from` ends. */
function endOf(text: string, from: number): number {
  const quote = text[from - 1]
  if (quote === '"' || quote === "'" || quote === '`') {
    const closed = closingQuote(text, from, quote)
    if (closed !== null) return closed
  }
  let at = driveAt(text, from) ? from + 3 : from
  while (at < text.length) {
    const one = text[at] ?? ''
    if (one === '\\' && at + 1 < text.length && text[at + 1] !== '\n') {
      at += 2
      continue
    }
    if (ends(one)) break
    at += 1
  }
  return at
}

/** The quote closing one opened just before `from`, on the same line, or null. */
function closingQuote(text: string, from: number, quote: string): number | null {
  for (let at = from; at < text.length; at += 1) {
    const one = text[at]
    if (one === '\n') return null
    if (one === '\\' && quote !== "'") {
      at += 1
      continue
    }
    if (one === quote) return at
  }
  return null
}

/** One path, shortened: inside a place, by it; anywhere else, to its last name. */
function rewritten(path: string, roots: readonly Root[]): string {
  for (const root of roots) {
    if (path === root.at) return root.as
    if (!path.startsWith(`${root.at}/`)) continue
    const rest = path.slice(root.at.length + 1)
    // The rest again, because a quoted span can hold a second path after a space.
    if (!climbs(rest)) return `${root.as}/${shortened(rest, roots)}`
  }
  return cut(path)
}

/**
 * Whether a path inside a place climbs out of it with `..` — spelt with
 * escapes too, `\.\.`, which a shell reads as the same.
 */
function climbs(rest: string): boolean {
  let depth = 0
  for (const part of rest.split('/')) {
    const name = part.replace(/\\(.)/g, '$1')
    if (name === '' || name === '.') continue
    depth += name === '..' ? -1 : 1
    if (depth < 0) return true
  }
  return false
}

/**
 * A path outside every place, as its last name behind `…/` — or as it is
 * where it has one name or none (`/`, `/etc`), which says no more than that.
 */
function cut(path: string): string {
  const drive = /^[A-Za-z]:/.test(path)
  const sep = drive ? '\\' : '/'
  const names = path.split(drive ? /[\\/]/ : '/').filter((one) => one !== '')
  if (drive) names.shift()
  if (!drive && names.length <= 1) return path
  const last = names[names.length - 1] ?? ''
  const trailing = /[\\/]$/.test(path) && last !== '' ? sep : ''
  return `${ELIDED}${sep}${last}${trailing}`
}
