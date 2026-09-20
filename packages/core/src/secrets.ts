import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerOnly } from './config.ts'

// Where a key you pasted into Tade goes, and where one is read back from.
//
// Tade used to refuse credentials on principle: a key typed into a wizard is
// a key in a file, so the only way in was an environment variable. The worry
// was right and the conclusion was wrong — what it actually bought was every
// person setting Tade up in a shell profile and starting it from the correct
// terminal. So the worry is answered instead: a pasted key goes to the OS
// keychain where there is one, and to a file of Tade's own, `0600`, where
// there is not. It never goes in `config.yaml`, which people commit, it is
// never written to the journal, and nothing ever draws it back.
//
// The order a credential is found in is the other half of the promise:
// **the environment always wins**. A machine that works today by exporting
// `TYPESAFE_API_KEY` goes on working exactly as it did, whatever is pasted.

/** A credential, and where it came from — the place, never the value. */
export interface SecretFound {
  value: string
  /** How to say where it came from: `$TYPESAFE_API_KEY`, `the macOS keychain`. */
  from: string
}

/** Somewhere credentials are kept. One implementation per kind of machine. */
export interface SecretVault {
  /** Its name in the registry: `keychain`, `file`. */
  id: string
  /** What it is called in a sentence: "the macOS keychain". */
  label: string
  /**
   * Whether this machine has it. Declared by the vault and asked before
   * anything is written — never worked out at a call site from its id.
   */
  usable(): boolean
  /** What is kept under this name, or null. Never throws. */
  read(name: string): string | null
  /** Keep it. Throws, with why, when it cannot. */
  write(name: string, value: string): void
  /** Forget it. Forgetting what was never there is not an error. */
  forget(name: string): void
}

/** What a vault is built with. `run` is how tests keep off the real keychain. */
export interface VaultOptions {
  /** Tade's home, for the vault that keeps a file there. */
  home: string
  platform?: NodeJS.Platform
  /** Run a program: the command, its arguments, and what to write to its input. */
  run?: (command: string, args: readonly string[], input?: string) => RunResult
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** The service every Tade item is filed under in an OS keychain. */
const SERVICE = 'tade'

function runProgram(command: string, args: readonly string[], input?: string): RunResult {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 15_000,
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: typeof failure.status === 'number' ? failure.status : 1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? failure.message ?? ''),
    }
  }
}

/**
 * The macOS keychain, through `security`.
 *
 * The value goes in on standard input — twice, which is what the prompt asks
 * for — rather than as an argument: an argument is in the process table for
 * anybody on the machine to read, which would undo the point of being here.
 */
function keychainVault(options: VaultOptions): SecretVault {
  const run = options.run ?? runProgram
  const platform = options.platform ?? process.platform
  return {
    id: 'keychain',
    label: 'the macOS keychain',
    usable() {
      if (platform !== 'darwin') return false
      return run('security', ['-h']).code === 0 || run('security', ['help']).code === 0
    },
    read(name) {
      const got = run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'])
      // 44 is "no such item", which is an answer, not a failure.
      if (got.code !== 0) return null
      const value = got.stdout.replace(/\n$/, '')
      return value === '' ? null : value
    },
    write(name, value) {
      const put = run(
        'security',
        ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-l', `tade: ${name}`, '-w'],
        `${value}\n${value}\n`,
      )
      if (put.code !== 0) {
        throw new Error(`the keychain would not take it: ${put.stderr.trim() || put.code}`)
      }
    },
    forget(name) {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', name])
    },
  }
}

/** What the file vault holds, as it is written. */
interface SecretsFile {
  version: 1
  secrets: Record<string, string>
}

/**
 * A file of Tade's own, `0600`, for machines with no keychain. Never the
 * config: that is a file people read out loud, copy between machines and
 * commit — and the whole reason a key in one is a bad idea.
 */
function fileVault(options: VaultOptions): SecretVault {
  const path = join(options.home, 'secrets.json')
  const read = (): SecretsFile => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SecretsFile>
      const secrets = parsed.secrets
      if (!secrets || typeof secrets !== 'object') return { version: 1, secrets: {} }
      return { version: 1, secrets: { ...(secrets as Record<string, string>) } }
    } catch {
      // No file, or one nothing can read: an empty answer, never a throw. A
      // key that cannot be found is asked for again; a crash here would take
      // the window with it.
      return { version: 1, secrets: {} }
    }
  }
  const save = (file: SecretsFile): void => {
    mkdirSync(options.home, { recursive: true })
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    ownerOnly(path)
  }
  return {
    id: 'file',
    label: `a file of Tade's own (${path})`,
    usable: () => true,
    read(name) {
      const value = read().secrets[name]
      return typeof value === 'string' && value !== '' ? value : null
    },
    write(name, value) {
      const file = read()
      file.secrets[name] = value
      save(file)
    },
    forget(name) {
      const file = read()
      if (!(name in file.secrets)) return
      delete file.secrets[name]
      if (Object.keys(file.secrets).length === 0) {
        try {
          rmSync(path)
        } catch {
          // Nothing to remove is nothing to say.
        }
        return
      }
      save(file)
    },
  }
}

/**
 * A shell command that prints a secret Tade keeps, read at the moment it runs:
 * for a program that asks for its key that way, so the key itself is never
 * written into what launches it.
 */
export function secretCommand(home: string, name: string): string {
  const script = fileURLToPath(new URL('./print-secret.ts', import.meta.url))
  const word = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  return [process.execPath, script, home, name].map(word).join(' ')
}

/** Every place credentials can be kept, by name. Call sites take one from here. */
export const SECRET_VAULTS: Readonly<Record<string, (options: VaultOptions) => SecretVault>> = {
  keychain: keychainVault,
  file: fileVault,
}

/** The vaults tried, best first: the OS keychain, then Tade's own file. */
const IN_ORDER = ['keychain', 'file'] as const

export interface SecretsOptions extends VaultOptions {
  /** Keep new ones here, whatever the machine has: `keychain`, `file`. */
  prefer?: string | null
}

/**
 * The credentials Tade holds: what is kept, where it went, and what wins.
 *
 * Reads look in every vault this machine has, best first, so a key pasted
 * before a keychain existed is still found. Writes go to the best one that
 * works, and say which — because "saved" without saying where is how people
 * end up with two copies of a key and no idea which is live.
 */
export class Secrets {
  readonly vaults: readonly SecretVault[]

  private constructor(vaults: readonly SecretVault[]) {
    this.vaults = vaults
  }

  static open(options: SecretsOptions): Secrets {
    const wanted = options.prefer
      ? [options.prefer, ...IN_ORDER.filter((id) => id !== options.prefer)]
      : [...IN_ORDER]
    const vaults = wanted
      .map((id) => SECRET_VAULTS[id]?.(options))
      .filter((vault): vault is SecretVault => vault !== undefined)
      .filter((vault) => vault.usable())
    return new Secrets(vaults)
  }

  /** Nothing is kept anywhere: what a surface uses when it has no home to write in. */
  static none(): Secrets {
    return new Secrets([])
  }

  /** Where a new one would go, or null when nowhere can. */
  get keeper(): SecretVault | null {
    return this.vaults[0] ?? null
  }

  /** What is kept under this name, wherever it is, or null. */
  get(name: string): string | null {
    for (const vault of this.vaults) {
      const value = safely(() => vault.read(name))
      if (value) return value
    }
    return null
  }

  /** Where what is kept under this name is, said as a place, or null. */
  where(name: string): string | null {
    for (const vault of this.vaults) {
      if (safely(() => vault.read(name))) return vault.label
    }
    return null
  }

  /**
   * Keep one, and say where it went. An empty value forgets it instead — which
   * is what clearing a field means, and the only way to take a key back out.
   */
  set(name: string, value: string): string {
    const trimmed = value.trim()
    if (trimmed === '') {
      this.clear(name)
      return 'nowhere: it was cleared'
    }
    if (/[\n\r]/.test(trimmed)) {
      throw new Error('a key cannot have a line break in it — paste it as one line')
    }
    const keeper = this.keeper
    if (!keeper) throw new Error('there is nowhere on this machine to keep it')
    keeper.write(name, trimmed)
    // Only in one place: a copy left in another vault would still be found by
    // `get` and would quietly win or lose depending on the order.
    for (const vault of this.vaults) {
      if (vault.id !== keeper.id) safely(() => vault.forget(name))
    }
    return keeper.label
  }

  /** Forget it, wherever it is. */
  clear(name: string): void {
    for (const vault of this.vaults) safely(() => vault.forget(name))
  }

  /**
   * The credential to use, and where it came from: the environment first —
   * every machine that works today goes on working — then what was pasted.
   */
  find(
    name: string,
    options: {
      env: Readonly<Record<string, string | undefined>>
      /** Environment variables to look in, in order. */
      variables?: readonly string[]
    },
  ): SecretFound | null {
    for (const variable of options.variables ?? []) {
      const value = options.env[variable]
      if (value?.trim()) return { value: value.trim(), from: `$${variable}` }
    }
    for (const vault of this.vaults) {
      const value = safely(() => vault.read(name))
      if (value) return { value, from: vault.label }
    }
    return null
  }
}

/** A secret's name: what it belongs to, and which of its keys. */
export function secretName(owner: string, key: string): string {
  return `${owner}.${key}`
}

/**
 * A credential as anything but its own field may show it. Bullets, never
 * characters: the length is all a screen ever gives away, and a key read back
 * to you is a key in a scrollback, a screen recording and a support ticket.
 */
export function masked(value: string): string {
  return value === '' ? '' : '•'.repeat(Math.min(12, [...value].length))
}

function safely<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}
