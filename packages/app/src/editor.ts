import { spawn } from 'node:child_process'
import type { EditorName } from '@tade/core'

// Opening what you click: a file at a line in your editor, or a link in your
// browser.
//
// Which editor is decided in order of how sure we can be. One you named in the
// config wins. Then the editor whose terminal Tade is running in, because
// that is the window you are already looking at. Then $VISUAL or $EDITOR —
// and a terminal editor opens in a lane inside Tade, next to the agent, since
// handing this terminal to vim would take the window away. Last, whatever the
// system opens that kind of file with.
//
// Choosing is pure and tested; launching is one spawn, detached, so an editor
// that takes a second to come up never holds the window.

/** How to open a file: a program that returns at once, or one that needs a terminal. */
export type Opener =
  | { kind: 'detached'; command: string; args: string[] }
  | { kind: 'terminal'; command: string; args: string[] }

export interface Place {
  /** Absolute path. */
  file: string
  line?: number
  column?: number
}

type Env = Readonly<Record<string, string | undefined>>

/** The editor to use, and why, so a surprise can be explained. */
export function chooseEditor(
  configured: EditorName | undefined,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): { editor: EditorName; because: string } {
  if (configured) return { editor: configured, because: 'the config says so' }
  const inside = editorWeAreIn(env)
  if (inside) return { editor: inside, because: 'Tade is running in its terminal' }
  const named = fromEnvironment(env.VISUAL ?? env.EDITOR)
  if (named) return { editor: named, because: env.VISUAL ? '$VISUAL' : '$EDITOR' }
  void platform
  return { editor: 'system', because: 'nothing else was set' }
}

/**
 * The editor whose integrated terminal this is. VS Code and its forks all say
 * `TERM_PROGRAM=vscode`; which fork is in the path of the helper they set, so
 * Cursor opens Cursor and not a VS Code you may not have.
 */
export function editorWeAreIn(env: Env): EditorName | null {
  if (env.TERM_PROGRAM === 'vscode') {
    const trail =
      `${env.VSCODE_GIT_ASKPASS_NODE ?? ''} ${env.__CFBundleIdentifier ?? ''}`.toLowerCase()
    if (env.CURSOR_CLI || trail.includes('cursor') || trail.includes('todesktop')) return 'cursor'
    if (trail.includes('windsurf')) return 'windsurf'
    return 'code'
  }
  if (env.ZED_TERM === 'true') return 'zed'
  if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'idea'
  if (env.NVIM) return 'nvim'
  if (env.INSIDE_EMACS) return 'emacs'
  return null
}

function fromEnvironment(value: string | undefined): EditorName | null {
  const program = value?.trim().split(/\s+/)[0]?.split('/').at(-1)
  switch (program) {
    case 'code':
    case 'cursor':
    case 'windsurf':
    case 'zed':
    case 'subl':
    case 'nvim':
    case 'vim':
    case 'emacs':
      return program
    case 'vi':
      return 'vim'
    case 'emacsclient':
      return 'emacs'
    case 'idea':
      return 'idea'
    default:
      return null
  }
}

/** The command that opens a place in an editor. */
export function openerFor(
  editor: EditorName,
  place: Place,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): Opener {
  const { file } = place
  const line = place.line ?? 1
  const at = place.line ? `${file}:${line}${place.column ? `:${place.column}` : ''}` : file
  switch (editor) {
    case 'code':
    case 'cursor':
    case 'windsurf':
      // -r reuses the window you are in; -g understands file:line:column.
      return { kind: 'detached', command: editor, args: ['-r', '-g', at] }
    case 'zed':
    case 'subl':
      return { kind: 'detached', command: editor, args: [at] }
    case 'idea':
      return {
        kind: 'detached',
        command: 'idea',
        args: place.line ? ['--line', String(line), file] : [file],
      }
    case 'nvim':
      // Inside nvim's own terminal, open it in that nvim rather than a second one.
      if (env.NVIM) {
        return {
          kind: 'detached',
          command: 'nvim',
          args: [
            '--server',
            env.NVIM,
            '--remote-send',
            `<C-\\><C-N>:drop +${line} ${escapeVim(file)}<CR>`,
          ],
        }
      }
      return { kind: 'terminal', command: 'nvim', args: [`+${line}`, file] }
    case 'vim':
      return { kind: 'terminal', command: 'vim', args: [`+${line}`, file] }
    case 'emacs':
      return env.INSIDE_EMACS
        ? { kind: 'detached', command: 'emacsclient', args: ['-n', `+${line}`, file] }
        : { kind: 'terminal', command: 'emacs', args: ['-nw', `+${line}`, file] }
    case 'system':
      return systemOpen(file, platform)
  }
}

/** A link, in whatever the system opens links with. */
export function openerForLink(url: string, platform: NodeJS.Platform = process.platform): Opener {
  return systemOpen(url, platform)
}

function systemOpen(target: string, platform: NodeJS.Platform): Opener {
  if (platform === 'darwin') return { kind: 'detached', command: 'open', args: [target] }
  if (platform === 'win32')
    return { kind: 'detached', command: 'cmd', args: ['/c', 'start', '""', target] }
  return { kind: 'detached', command: 'xdg-open', args: [target] }
}

function escapeVim(path: string): string {
  // Spaces, backslashes, bars and quotes end or change an ex command.
  return path.replace(/[ \\|"]/g, (char) => `\\${char}`)
}

/**
 * Start a detached opener and let it go. Resolves once it has started or
 * failed to, with the reason in words: "code is not installed" is an answer,
 * an unhandled ENOENT is not.
 */
export function launch(opener: Extract<Opener, { kind: 'detached' }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opener.command, opener.args, { detached: true, stdio: 'ignore' })
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `${opener.command} is not installed, or not on PATH`
            : err.message,
        ),
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Where text on screen points at something you can open: a link, or a file at a line. */
export interface Found {
  from: number
  to: number
  target:
    | { kind: 'url'; url: string }
    | { kind: 'place'; path: string; line?: number; column?: number }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g
/** `src/a.ts:12`, `./b.js:3:7`, `pkg/c.tsx` — a path with a slash or an extension, maybe a line. */
const PATH_PATTERN =
  /(?:^|[\s(["'`])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][\w]{0,6})(?::(\d+))?(?::(\d+))?/g

/**
 * Find the links and file references in a row of plain text, by column.
 * Only things a click can do something with: a URL, or a path that looks like
 * a file. Whether the file exists is for whoever opens it to find out.
 */
export function findOpenable(
  text: string,
  linkers: readonly { pattern: string; url: string }[] = [],
): Found[] {
  const found: Found[] = []
  // What extensions know how to open — a Sentry short id — before anything
  // that merely looks like a path.
  for (const linker of linkers) {
    let pattern: RegExp
    try {
      pattern = new RegExp(linker.pattern, 'g')
    } catch {
      continue
    }
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) continue
      const from = match.index ?? 0
      found.push({
        from,
        to: from + match[0].length - 1,
        target: { kind: 'url', url: linker.url.replace(/\$&/g, encodeURIComponent(match[0])) },
      })
    }
  }
  const taken = (at: number) => found.some((f) => at >= f.from && at <= f.to)
  for (const match of text.matchAll(URL_PATTERN)) {
    const from = match.index ?? 0
    if (taken(from)) continue
    found.push({ from, to: from + match[0].length - 1, target: { kind: 'url', url: match[0] } })
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1]
    if (!path) continue
    const from = (match.index ?? 0) + match[0].indexOf(path)
    if (taken(from)) continue
    // A version number or a sentence's last word is not a file.
    if (/^\d+(\.\d+)+$/.test(path) || !/[/.]/.test(path) || /^\.+$/.test(path)) continue
    const tail = match[0].slice(match[0].indexOf(path) + path.length)
    found.push({
      from,
      to: from + path.length + tail.length - 1,
      target: {
        kind: 'place',
        path,
        ...(match[2] ? { line: Number(match[2]) } : {}),
        ...(match[3] ? { column: Number(match[3]) } : {}),
      },
    })
  }
  return found.sort((a, b) => a.from - b.from)
}
