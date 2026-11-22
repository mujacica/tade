// The files that set a person's environment, read for which keys they set
// and where — never for what the keys are.
//
// A key that works in the Mac's terminal can be missing on the VPS though the
// same dotfiles were copied: `tade serve` under systemd never reads
// `~/.zshenv` or `~/.zshrc`. Nothing could say so, because nothing knew where
// a key was set. This reads the lines that set one — `export NAME=value` in a
// shell's files, `NAME=value` in an environment file, `Environment=` in a
// unit — and hands back each name with its line, whether it is set, and
// whether it could be moved into one file (`~/.config/tade/env`) that the
// login shell and the service both read.
//
// **A value is held only as long as a line is being read.** The parser hands
// a literal value back so its caller can digest it or move it, and the
// scanner (`@tade/workbench`'s `env-scan.ts`) drops it at once; nothing here
// writes one down, and every diff a person is shown says `‹hidden›` in its
// place (`HIDDEN`).
//
// **Only a literal moves.** `export KEY="$(op read …)"` is a command run at
// every login, `export KEY=$OTHER` is another variable, and a line inside an
// `if` means something only there: each is named where it is and left. What
// moves is written single-quoted, which a POSIX shell, systemd's
// `EnvironmentFile=` and `environment.d` all read the same way, character for
// character — so a value with a single quote or a line break in it is left
// too, because no one spelling of it reads the same in all three.
//
// Pure: text in, lines out. Parsers return what they could read and never
// throw: a file in a shape this does not know is a file with nothing in it.

/** How a file says its assignments. */
export type EnvFormat =
  /** A POSIX-ish shell's own file: `~/.zshenv`, `~/.bashrc`, a project's `.envrc`. */
  | 'sh'
  /** fish's: `set -gx NAME value`. Named, never moved: fish reads its own syntax. */
  | 'fish'
  /** `NAME=value` lines: systemd's `EnvironmentFile=`, `environment.d/*.conf`, a `.env`. */
  | 'envfile'
  /** A systemd unit: its `Environment=` assignments, and which files `EnvironmentFile=` names. */
  | 'unit'

/** One assignment a file makes. */
export interface EnvAssignment {
  name: string
  /** 1-based. */
  line: number
  /**
   * `literal` — a value written out, which is in `value`; `empty` — set to
   * nothing; `computed` — a command, another variable, or a quoting this does
   * not follow, which only the shell knows the value of.
   */
  state: 'literal' | 'empty' | 'computed'
  /** The value, for a literal only. Its caller digests it or moves it and keeps neither. */
  value?: string
  /** Whether the line can move into one file as it is (`MOVABLE`). */
  movable: boolean
  /** Why not, where not: a clause. */
  why: string | null
}

/** What a unit says, beyond its assignments: the files it reads its environment from. */
export interface UnitEnvironment {
  assignments: EnvAssignment[]
  /** `EnvironmentFile=` paths as written, `%h` and `-` left for the caller. */
  files: string[]
}

/** A name a variable may have, as every shell and systemd agree. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A variable named like a credential: the pattern `carry.ts` reads a config
 * leaf by (`CREDENTIAL`), said for an environment's upper case.
 */
const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|DSN)$/i

/** Whether a variable's name says it holds a credential. */
export function isCredentialName(name: string): boolean {
  return NAME.test(name) && CREDENTIAL_NAME.test(name)
}

/** What a diff a person is shown says where a value was. */
export const HIDDEN = '‹hidden›'

/** Where the one file is, as a shell line spells it. */
export const ENV_FILE_SPELLED = '$HOME/.config/tade/env'

/** The same, as a person reads it. */
export const ENV_FILE_SAID = '~/.config/tade/env'

/**
 * The line each shell file gets where its keys were: it reads the one file,
 * exporting what it sets, and does nothing where the file is not there — a
 * missing file read with `.` ends a non-interactive `sh`, which is what a
 * login on a box with an older home would otherwise do.
 */
export const SOURCE_LINE = `[ -f "${ENV_FILE_SPELLED}" ] && { set -a; . "${ENV_FILE_SPELLED}"; set +a; }`

/** What the unit says to read the same file: `-` because it may not be there yet. */
export const UNIT_ENVIRONMENT_FILE = 'EnvironmentFile=-%h/.config/tade/env'

/** The head of the one file, written when it is first made. */
export const ENV_FILE_HEAD = [
  '# Keys moved here from your shell’s files by Tade, on your press.',
  `# Read by your login shell (${SOURCE_LINE})`,
  `# and by \`tade serve\` (${UNIT_ENVIRONMENT_FILE}). Plain NAME='value' lines.`,
  '# Any agent you run can read this file: agents run as you, and nothing sandboxes them.',
  '# Keeping it in step between machines is yours: chezmoi with age, `op inject`, Syncthing,',
  '# or a private dotfiles repository with sops or git-crypt.',
  '',
]

/** Every assignment a file makes, in the order it makes them. Never throws. */
export function assignmentsIn(text: string, format: EnvFormat): EnvAssignment[] {
  if (format === 'unit') return unitIn(text).assignments
  const lines = text.split(/\r?\n/)
  const out: EnvAssignment[] = []
  let depth = 0
  lines.forEach((raw, at) => {
    const line = at + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    if (format === 'sh') {
      const found = shAssignment(raw, depth)
      depth = Math.max(0, depth + blockChange(trimmed))
      if (found) out.push({ ...found, line })
    } else if (format === 'fish') {
      const found = fishAssignment(trimmed)
      if (found) out.push({ ...found, line })
    } else {
      if (trimmed.startsWith(';')) return
      const found = envfileAssignment(trimmed)
      if (found) out.push({ ...found, line })
    }
  })
  return out
}

/** A unit's assignments and the environment files it names. Never throws. */
export function unitIn(text: string): UnitEnvironment {
  const assignments: EnvAssignment[] = []
  const files: string[] = []
  text.split(/\r?\n/).forEach((raw, at) => {
    const trimmed = raw.trim()
    const environment = /^Environment\s*=\s*(.*)$/.exec(trimmed)
    if (environment) {
      for (const word of unitWords(environment[1] ?? '')) {
        const eq = word.indexOf('=')
        const name = eq < 0 ? '' : word.slice(0, eq)
        if (!NAME.test(name)) continue
        const value = word.slice(eq + 1)
        assignments.push({
          name,
          line: at + 1,
          ...(value === '' ? { state: 'empty' as const } : { state: 'literal' as const, value }),
          movable: false,
          why: 'it is in the unit, which reads it already',
        })
      }
      return
    }
    const file = /^EnvironmentFile\s*=\s*(.+)$/.exec(trimmed)
    if (file?.[1]) files.push(file[1].trim())
  })
  return { assignments, files }
}

/** The words of an `Environment=` line: space-separated, each optionally double- or single-quoted. */
function unitWords(text: string): string[] {
  const words: string[] = []
  let at = 0
  while (at < text.length) {
    while (text[at] === ' ' || text[at] === '\t') at++
    if (at >= text.length) break
    const quote = text[at]
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, at + 1)
      if (end < 0) break
      words.push(text.slice(at + 1, end))
      at = end + 1
    } else {
      let end = at
      while (end < text.length && text[end] !== ' ' && text[end] !== '\t') end++
      words.push(text.slice(at, end))
      at = end
    }
  }
  return words
}

type Found = Omit<EnvAssignment, 'line'>

/**
 * One shell line that sets a variable: `NAME=value`, `export NAME=value`, or
 * `typeset -x`/`declare -x` the same way — at the top of the file, or named
 * and left where it is inside a block.
 */
function shAssignment(raw: string, depth: number): Found | null {
  const trimmed = raw.trim()
  const head =
    /^(?:(?:export|typeset\s+-g?x|declare\s+-g?x|local\s+-x)\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(
      trimmed,
    )
  if (!head) return null
  const name = head[1] ?? ''
  const rest = head[2] ?? ''
  const value = shValue(rest)
  const inBlock = depth > 0 || /^\s/.test(raw)
  if (value === null) {
    return { name, state: 'computed', movable: false, why: 'its value is worked out by the shell' }
  }
  const state = value === '' ? ('empty' as const) : ('literal' as const)
  const why = inBlock
    ? 'it is inside a block, and means something only there'
    : state === 'empty'
      ? 'it is set to nothing'
      : unspellable(value)
  return {
    name,
    state,
    ...(state === 'literal' ? { value } : {}),
    movable: why === null,
    why,
  }
}

/**
 * The value a shell reads off what follows `=`, where it is a literal: quoted
 * whole, or a bare word of characters nothing in a shell reads as anything
 * else, with nothing after it but a comment. Null for anything else.
 */
function shValue(rest: string): string | null {
  if (rest === '') return ''
  const tail = (after: string) => after.trim() === '' || /^\s+#/.test(after)
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    if (end < 0) return null
    return tail(rest.slice(end + 1)) ? rest.slice(1, end) : null
  }
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1)
    if (end < 0) return null
    const inner = rest.slice(1, end)
    if (/[$`\\]/.test(inner)) return null
    return tail(rest.slice(end + 1)) ? inner : null
  }
  const bare = /^([A-Za-z0-9_./:@%+,=~-]*)(.*)$/.exec(rest)
  if (!bare) return null
  const word = bare[1] ?? ''
  if (word.startsWith('~')) return null
  return tail(bare[2] ?? '') ? word : null
}

/** How much deeper a line takes the blocks a shell file is in: `if` opens, `fi` closes. */
function blockChange(trimmed: string): number {
  const code = trimmed.replace(/\s+#.*$/, '')
  // `if …; then …; fi` on one line opens and closes in the same breath.
  const opens =
    (/^(?:if|case|for|while|until|select)\b/.test(code) ? 1 : 0) + (/\{\s*$/.test(code) ? 1 : 0)
  const closes =
    (/(?:^|[;\s])(?:fi|esac|done)\s*;?\s*$/.test(code) ? 1 : 0) + (/^\}/.test(code) ? 1 : 0)
  return opens - closes
}

/** fish's `set -gx NAME value`: named, and never moved. */
function fishAssignment(trimmed: string): Found | null {
  const head =
    /^set\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*x[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(
      trimmed,
    )
  if (!head) return null
  const name = head[1] ?? ''
  const rest = (head[2] ?? '').trim()
  const why = 'fish reads its own syntax, so it stays in fish’s file'
  if (rest === '') return { name, state: 'empty', movable: false, why }
  const value = shValue(rest)
  if (value === null) return { name, state: 'computed', movable: false, why }
  return value === ''
    ? { name, state: 'empty', movable: false, why }
    : { name, state: 'literal', value, movable: false, why }
}

/** `NAME=value` in an environment file, a `.env` or `environment.d`, an `export ` let be. */
function envfileAssignment(trimmed: string): Found | null {
  const head = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (!head) return null
  const name = head[1] ?? ''
  const rest = (head[2] ?? '').trim()
  const why = 'its file is read as it is, by what reads it'
  if (rest === '') return { name, state: 'empty', movable: false, why }
  if (rest.startsWith("'") || rest.startsWith('"')) {
    const end = rest.lastIndexOf(rest[0] as string)
    if (end <= 0) return { name, state: 'computed', movable: false, why }
    const inner = rest.slice(1, end)
    if (rest[0] === '"' && /[$`\\]/.test(inner)) {
      return { name, state: 'computed', movable: false, why }
    }
    return inner === ''
      ? { name, state: 'empty', movable: false, why }
      : { name, state: 'literal', value: inner, movable: false, why }
  }
  if (/\$\{?[A-Za-z_]/.test(rest)) return { name, state: 'computed', movable: false, why }
  return { name, state: 'literal', value: rest.replace(/\s+#.*$/, ''), movable: false, why }
}

/** Why a literal cannot be written once so that every reader reads it the same, or null. */
function unspellable(value: string): string | null {
  if (value.includes("'")) return 'its value has a single quote in it, which no one spelling keeps'
  if (/[\r\n\\]/.test(value)) return 'its value has a line break or a backslash in it'
  return null
}

/**
 * One line of the one file: single-quoted, which a POSIX shell's `.`,
 * systemd's `EnvironmentFile=` and `environment.d` all read as exactly the
 * characters between the quotes. Throws for a value `unspellable` refuses —
 * a caller that moves only `movable` lines never hands it one.
 */
export function envLine(name: string, value: string): string {
  if (!NAME.test(name)) throw new Error(`${name} is not a variable's name`)
  const why = unspellable(value)
  if (why !== null) throw new Error(`${name} cannot be written: ${why}`)
  return `${name}='${value}'`
}

/**
 * A line as a person is shown it where its value would be: everything up to
 * the `=` and `‹hidden›` after it — never the value, its length, or its first
 * characters.
 */
export function hiddenLine(text: string): string {
  const eq = text.indexOf('=')
  if (eq < 0) return text
  return `${text.slice(0, eq + 1)}${HIDDEN}`
}

/**
 * The names an environment file sets, as systemd's `EnvironmentFile=` reads it:
 * the check that what was written for the shell is what the service reads.
 */
export function namesSystemdReads(text: string): string[] {
  const names: string[] = []
  for (const one of assignmentsIn(text, 'envfile')) {
    if (one.state !== 'empty' && !names.includes(one.name)) names.push(one.name)
  }
  return names
}
