import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type CarryOutcome, carriedSays, textOf, writtenAt } from './carry.ts'
import { loadConfig, writeSetting } from './config-file.ts'
import { isPersonaName, parsePersona } from './personas.ts'
import { contentHash, parseTemplate, personaDirs, templateDirs } from './templates-store.ts'

// The two kinds of file a remote is given of this machine's home: the personas
// somebody wrote (`personas/active/`) and the templates somebody published
// (`templates/published/<name>/<version>.yaml`). Both are `kept` (`carry.ts`).
//
// A persona is a file somebody edits, so it is carried the way a preference is:
// written there when that machine has none or still has the one carried, and
// left — and said — where somebody there changed it. A published template is a
// snapshot that never changes (`templates-store.ts`), so it is the same file
// there or it is not written: a version there with other bytes in it is
// refused, because rewriting a published version is the one thing a template
// promises never happens. Drafts and proposals stay where they were made.

/** One file, as carried: its kind, its name, and every byte of it. */
export type CarriedFile =
  | { kind: 'persona'; name: string; text: string }
  | { kind: 'template'; name: string; version: number; text: string }

/** A file, as a person reads it: `persona reviewer`, `template triage@3`. */
export function fileNamed(file: Pick<CarriedFile, 'kind' | 'name'> & { version?: number }): string {
  return file.kind === 'persona'
    ? `persona ${file.name}`
    : `template ${file.name}@${file.version ?? '?'}`
}

/** Where one lives in a home. Only for a name `isPersonaName` takes: nothing else is joined. */
function whereIn(home: string, file: Pick<CarriedFile, 'kind' | 'name'> & { version?: number }) {
  if (!isPersonaName(file.name)) throw new Error(`"${file.name}" is not a name Tade will use`)
  return file.kind === 'persona'
    ? join(personaDirs(home).active, `${file.name}.md`)
    : join(templateDirs(home).published, file.name, `${file.version ?? 0}.yaml`)
}

/** Whether a failed read is only that there is nothing there. */
function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** What a folder holds, or nothing where there is no folder; any other failure is thrown. */
async function listed(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    if (missing(err)) return []
    throw err
  }
}

/** A file's text, or null where there is no file — gone since it was listed is gone. */
async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (missing(err)) return null
    throw err
  }
}

/** The names in a folder that end so, or none where there is no folder. */
async function named(dir: string, ending: string): Promise<string[]> {
  return (await listed(dir))
    .filter((one) => one.endsWith(ending) && !one.startsWith('.') && !one.startsWith('_'))
    .map((one) => one.slice(0, -ending.length))
    .sort()
}

/** Every persona written and template published in this home, as they would be carried. */
export async function filesToCarry(home: string): Promise<CarriedFile[]> {
  const files: CarriedFile[] = []
  for (const name of await named(personaDirs(home).active, '.md')) {
    if (!isPersonaName(name)) continue
    const text = await readIfThere(join(personaDirs(home).active, `${name}.md`))
    if (text !== null) files.push({ kind: 'persona', name, text })
  }
  const published = templateDirs(home).published
  for (const name of (await listed(published)).filter(isPersonaName).sort()) {
    for (const version of await named(join(published, name), '.yaml')) {
      const number = Number(version)
      if (!Number.isInteger(number) || number <= 0) continue
      const text = await readIfThere(join(published, name, `${version}.yaml`))
      if (text !== null) files.push({ kind: 'template', name, version: number, text })
    }
  }
  return files
}

/** What is in a home under that file's name, or null where there is nothing. */
export async function fileThere(
  home: string,
  file: Pick<CarriedFile, 'kind' | 'name'> & { version?: number },
): Promise<string | null> {
  return readIfThere(whereIn(home, file))
}

/**
 * Write one carried file into a home, whole or not at all: read first for its
 * shape, so a file that would not load there is refused with the reason rather
 * than written to be listed as broken.
 */
export async function putFile(home: string, file: CarriedFile): Promise<void> {
  if (file.kind === 'persona') {
    const read = parsePersona(file.name, file.text)
    if (!read.ok) throw new Error(read.problems.join('; '))
  } else {
    const read = parseTemplate(file.name, file.text)
    if (!read.ok) throw new Error(read.problems.join('; '))
    if (read.template.version !== file.version) {
      throw new Error(`it says version ${read.template.version}, and was sent as ${file.version}`)
    }
  }
  const where = whereIn(home, file)
  await mkdir(join(where, '..'), { recursive: true })
  const partial = `${where}.carrying`
  await writeFile(partial, file.text)
  await rename(partial, where)
}

/** What a file's line in the journal is compared by: its content hash. */
export function fileHash(text: string): string {
  return contentHash(text)
}

/**
 * What a carry does with one file there.
 *
 * A template is the same file or none: never rewritten. A persona is a
 * preference: written over only where it is still the one last carried
 * (`lastHash`), or on a press.
 */
export function fileDecision(req: {
  file: CarriedFile
  current: string | null
  /** The hash the last carry of this file there wrote, or null for none. */
  lastHash: string | null
  force: boolean
}): CarryOutcome {
  const { file, current } = req
  if (current !== null && textOf(current) === textOf(file.text)) return 'same'
  if (file.kind === 'template') return current === null ? 'written' : 'refused'
  if (current === null || req.force) return 'written'
  return req.lastHash !== null && fileHash(current) === req.lastHash ? 'written' : 'theirs'
}

/**
 * One carried setting written into a config file the way the window's one
 * write path writes one — `writeSetting`, read back, and put back exactly as it
 * was where the config would not load with it — and its `config_changed` line,
 * which says it was carried and by whom and never a key. For a home with no
 * window to hand it to: the far end a link's suite links to. A window writes
 * through its own `Settings` instead (`packages/app/src/wire/web-carry.ts`).
 */
export async function writeCarried(
  configPath: string,
  write: {
    path: string
    value: unknown
    carry: 'kept' | 'pressed'
    by: { device: string; from: string }
  },
  log: (line: { type: 'config_changed'; detail: Record<string, string> }) => Promise<void>,
): Promise<void> {
  let before: string | null = null
  try {
    before = readFileSync(configPath, 'utf8')
  } catch (err) {
    // No file yet: this write starts one, and there is nothing to put back.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const was = writtenAt(before === null ? {} : (parseYaml(before) ?? {}), write.path)
  writeSetting(configPath, write.path, write.value as Parameters<typeof writeSetting>[2])
  const loaded = await loadConfig(configPath)
  if (!loaded.ok) {
    if (before !== null) writeFileSync(configPath, before)
    else rmSync(configPath, { force: true })
    throw new Error(loaded.issues[0]?.message ?? 'the config would not load with that')
  }
  await log({
    type: 'config_changed',
    detail: {
      path: write.path,
      was: carriedSays(write.carry, was),
      now: carriedSays(write.carry, write.value),
      by: `device ${write.by.device}`,
      carried: write.by.from,
    },
  })
}
