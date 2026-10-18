import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseDocument, parse as parseYaml, YAMLParseError } from 'yaml'
import type { z } from 'zod'
import { awayProblems } from './away.ts'
import { type Config, ConfigSchema } from './config.ts'
import { dropGone } from './gone.ts'
import { defaultConfigPath } from './home.ts'
import { pushProblems } from './project.ts'

// The file `ConfigSchema` is read out of and written back to. Its own file
// because the schema is the half that grows with every setting anybody adds,
// and this half needs nothing of it but its name.

export interface ConfigIssue {
  /** Dotted path to the offending key, e.g. `workspace.driver`. Empty for file-level errors. */
  path: string
  message: string
}

export type ConfigResult =
  | {
      ok: true
      config: Config
      path: string
      exists: boolean
      warnings: string[]
      /** Dotted paths of the keys this Tade has no setting for, dropped and said in `warnings`. */
      unknown: string[]
    }
  | { ok: false; path: string; issues: ConfigIssue[] }

/**
 * What is said of a key this Tade has no setting for. Two things write one:
 * a hand that misspelt a setting, and a newer Tade — its CLI writing the
 * file while a window on this one holds the home.
 */
export function unknownSays(path: string): string {
  return `${path} is ignored: this Tade has no such setting — a newer Tade may have written it, or it is misspelt`
}

export function parseConfig(text: string, path = '<inline>'): ConfigResult {
  let raw: unknown
  try {
    raw = parseYaml(text) ?? {}
  } catch (err) {
    const message = err instanceof YAMLParseError ? err.message : String(err)
    return { ok: false, path, issues: [{ path: '', message: `invalid YAML: ${message}` }] }
  }
  const warnings = dropGone(raw)
  // A key this Tade has no setting for is dropped and said, like one that is
  // gone, rather than refusing the file: a newer Tade's CLI writing a key of
  // its own took away every setting from a window on this one holding the
  // home, and every change in its Settings after it. A typo is still named by
  // its dotted path here, and `tade config --check` still fails on it.
  const unknown: z.core.$ZodIssue[] = []
  let parsed = ConfigSchema.safeParse(raw)
  // Each round can only take keys away, and a parent refused for its own value
  // hides what is under it, so it stops when a round finds none.
  for (let round = 0; !parsed.success && round < 8; round++) {
    const found = parsed.error.issues.filter((i) => i.code === 'unrecognized_keys')
    if (found.length === 0 || !found.every((i) => dropKeys(raw, i))) break
    unknown.push(...found)
    parsed = ConfigSchema.safeParse(raw)
  }
  if (!parsed.success) {
    return {
      ok: false,
      path,
      issues: [...parsed.error.issues, ...unknown].map((i) => ({
        path: issuePath(i),
        message: i.message,
      })),
    }
  }
  const unknownPaths = unknown.flatMap((i) => issuePath(i).split(', '))
  warnings.push(...unknownPaths.map(unknownSays))
  // A push mode that cannot mean what it says is said here rather than
  // refused: it resolves to pushing nothing, and refusing the file would take
  // away everything else somebody wrote in it.
  warnings.push(...pushProblems(parsed.data))
  // The away view's own keys that are on and cannot mean what they say, said
  // the same way and for the same reason: a setting Tade accepts and ignores
  // is worse than one it does not have.
  warnings.push(...awayProblems(parsed.data.surfaces.web))
  return { ok: true, config: parsed.data, path, exists: true, warnings, unknown: unknownPaths }
}

/**
 * Write one setting back into the file as a document, not as data: parsing to
 * an object and printing it again loses every comment in the file, and the
 * file belongs to whoever wrote those comments.
 */
export function writeSetting(
  path: string,
  key: string,
  value:
    | string
    | number
    | boolean
    | readonly string[]
    | Readonly<Record<string, unknown>>
    | undefined,
): void {
  // A credential is written here like anything else. It used to be refused —
  // the config was "a file people read out loud" — which sent every key to the
  // keychain, where it could not be read back, checked or copied. The file is
  // `0600` (`ownerOnly`), which keeps it from other people and not from the
  // agents you run, which can read it (`KEYS_AND_AGENTS`).
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No file yet: this starts it.
  }
  const doc = parseDocument(text)
  const at = key.split('.')
  if (value === undefined || value === '') doc.deleteIn(at)
  else doc.setIn(at, typeof value === 'object' ? doc.createNode(value) : value)
  // A home nothing has written yet — `tade web on` on a new box before setup —
  // is made here rather than an ENOENT out of a stack trace.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, doc.toString(), { mode: 0o600 })
  ownerOnly(path)
}

/**
 * Keep the config from other people: where somebody's projects are, which
 * Sentry they watch, a DSN anybody holding it could send events to, and the
 * keys they pasted in. `0600` is the whole of what that buys — the agents they
 * run run as them and can read it like any other file of theirs, which is said
 * where somebody is deciding (`KEYS_AND_AGENTS`). Writing with `mode` only
 * covers a file that is being made; one that was already there is narrowed
 * here, keeping whatever the owner may do with it and taking away what
 * everybody else could.
 */
export function ownerOnly(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077) chmodSync(path, mode & 0o700)
  } catch {
    // A file we cannot stat or chmod is not a reason to lose the setting.
  }
}

/** Load config from disk. A missing file is not an error: defaults apply. */
export async function loadConfig(path = defaultConfigPath()): Promise<ConfigResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: true,
        config: ConfigSchema.parse({}),
        path,
        exists: false,
        warnings: [],
        unknown: [],
      }
    }
    return { ok: false, path, issues: [{ path: '', message: String(err) }] }
  }
  return parseConfig(text, path)
}

/**
 * Take the keys one `unrecognized_keys` issue names out of what was parsed.
 * False where its path does not lead to an object, which is then left to be
 * refused as it was.
 */
function dropKeys(raw: unknown, issue: z.core.$ZodIssue): boolean {
  if (issue.code !== 'unrecognized_keys') return false
  let node = raw
  for (const at of issue.path) {
    if (typeof node !== 'object' || node === null) return false
    node = (node as Record<PropertyKey, unknown>)[at as PropertyKey]
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
  for (const key of issue.keys) delete (node as Record<string, unknown>)[key]
  return true
}

function issuePath(issue: z.core.$ZodIssue): string {
  const segments = [...issue.path]
  // Unrecognized keys report their names separately from the path.
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => [...segments, k].join('.')).join(', ')
  }
  return segments.map(String).join('.')
}
