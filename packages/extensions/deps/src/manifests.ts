import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Ecosystem } from './versions.ts'

// Where a project says what it depends on, read so each requirement can be
// changed in place.
//
// Every dependency remembers exactly where its requirement is written in its
// file, so an update replaces those characters and nothing else: the file's
// formatting, comments and key order are whoever wrote them's. Reading is by
// careful patterns rather than full parsers, and a file that does not look the
// way these expect gives fewer dependencies — never a rewritten file.

export interface Dependency {
  /** The manifest, relative to the folder that was searched. */
  manifest: string
  ecosystem: Ecosystem
  name: string
  /** The requirement as written: `^18.2.0`, `>=2.31`, `v1.9.0`. */
  spec: string
  /** Which list it is in: `dependencies`, `devDependencies`, `dev-dependencies`, `catalog`… */
  group: string
  /** Where the requirement is in the file, as offsets: what an update replaces. */
  start: number
  end: number
  line: number
}

/** The files each ecosystem keeps requirements in, by name. */
export function ecosystemOf(path: string): Ecosystem | null {
  const name = basename(path)
  if (name === 'package.json' || name === 'pnpm-workspace.yaml') return 'npm'
  if (name === 'pyproject.toml' || /^requirements.*\.txt$/.test(name)) return 'pypi'
  if (name === 'Cargo.toml') return 'cargo'
  if (name === 'go.mod') return 'go'
  return null
}

/** Every dependency in these manifests, in file order. Files that cannot be read give none. */
export function readManifests(root: string, files: readonly string[]): Dependency[] {
  const out: Dependency[] = []
  for (const manifest of files) {
    let text: string
    try {
      text = readFileSync(join(root, manifest), 'utf8')
    } catch {
      continue
    }
    out.push(...readManifest(manifest, text))
  }
  return out
}

export function readManifest(manifest: string, text: string): Dependency[] {
  const name = basename(manifest)
  if (name === 'package.json') return packageJson(manifest, text)
  if (name === 'pnpm-workspace.yaml') return pnpmCatalogs(manifest, text)
  if (name === 'pyproject.toml') return pyproject(manifest, text)
  if (/^requirements.*\.txt$/.test(name)) return requirements(manifest, text)
  if (name === 'Cargo.toml') return cargo(manifest, text)
  if (name === 'go.mod') return goMod(manifest, text)
  return []
}

/** Replace requirements in a file's text, last first so earlier offsets stay true. */
export function rewrite(
  text: string,
  changes: readonly { start: number; end: number; to: string }[],
): string {
  let out = text
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, change.start) + change.to + out.slice(change.end)
  }
  return out
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

const NPM_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function packageJson(manifest: string, text: string): Dependency[] {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return []
  }
  const out: Dependency[] = []
  for (const group of NPM_GROUPS) {
    const listed = parsed[group]
    if (!listed || typeof listed !== 'object') continue
    const opening = new RegExp(`"${group}"\\s*:\\s*\\{`).exec(text)
    if (!opening) continue
    const from = opening.index + opening[0].length
    const to = closingBrace(text, from)
    const body = text.slice(from, to)
    for (const [name, spec] of Object.entries(listed as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue
      const entry = new RegExp(`"${literal(name)}"\\s*:\\s*"(${literal(spec)})"`).exec(body)
      if (!entry) continue
      const start = from + entry.index + entry[0].length - spec.length - 1
      // `npm:real-name@^1.2` aliases another package: the name that has versions is inside.
      const alias = /^npm:(@?[^@]+)@(.+)$/.exec(spec)
      out.push({
        manifest,
        ecosystem: 'npm',
        name: alias?.[1] ?? name,
        spec: alias?.[2] ?? spec,
        group,
        start: alias ? start + spec.length - (alias[2]?.length ?? 0) : start,
        end: start + spec.length,
        line: lineAt(text, start),
      })
    }
  }
  return out
}

/** pnpm's catalogs: versions a workspace names once and packages refer to as `catalog:`. */
function pnpmCatalogs(manifest: string, text: string): Dependency[] {
  const out: Dependency[] = []
  const lines = text.split('\n')
  let offset = 0
  let section: string | null = null
  let named: string | null = null
  for (const line of lines) {
    const top = /^(\w[\w-]*):\s*$/.exec(line)
    if (top) {
      section = top[1] ?? null
      named = null
    } else if (/^\S/.test(line)) {
      section = null
    } else if (section === 'catalogs' && /^ {2}([\w-]+):\s*$/.test(line)) {
      named = /^ {2}([\w-]+):/.exec(line)?.[1] ?? null
    } else if (section === 'catalog' || (section === 'catalogs' && named)) {
      const entry = /^\s+['"]?(@?[\w./-]+)['"]?:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
      if (entry?.[1] && entry[2]) {
        const start = offset + line.indexOf(entry[2], line.indexOf(':'))
        out.push({
          manifest,
          ecosystem: 'npm',
          name: entry[1],
          spec: entry[2],
          group: named ? `catalog ${named}` : 'catalog',
          start,
          end: start + entry[2].length,
          line: lineAt(text, start),
        })
      }
    }
    offset += line.length + 1
  }
  return out
}

function requirements(manifest: string, text: string): Dependency[] {
  const out: Dependency[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const entry =
      /^\s*([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?\s*((?:===|==|~=|>=|<=|!=|>|<)\s*[^;#\s]+(?:\s*,\s*(?:===|==|~=|>=|<=|!=|>|<)\s*[^;#\s,]+)*)/.exec(
        line,
      )
    if (entry?.[1] && entry[3] && !line.trim().startsWith('-')) {
      const start = offset + line.indexOf(entry[3], entry[1].length)
      out.push(pep508(manifest, entry[1], entry[3], 'requirements', start, text))
    }
    offset += line.length + 1
  }
  return out
}

function pep508(
  manifest: string,
  name: string,
  spec: string,
  group: string,
  start: number,
  text: string,
): Dependency {
  return {
    manifest,
    ecosystem: 'pypi',
    name,
    spec: spec.replace(/\s+/g, ''),
    group,
    start,
    end: start + spec.length,
    line: lineAt(text, start),
  }
}

function pyproject(manifest: string, text: string): Dependency[] {
  const out: Dependency[] = []
  for (const table of tables(text)) {
    if (table.name === 'project' || /^project\.optional-dependencies$/.test(table.name)) {
      const list = /dependencies\s*=\s*\[/.exec(table.body)
      const arrays =
        table.name === 'project'
          ? list
            ? [list.index + list[0].length]
            : []
          : allArrays(table.body)
      for (const from of arrays) {
        const to = table.body.indexOf(']', from)
        const body = table.body.slice(from, to < 0 ? undefined : to)
        for (const quoted of body.matchAll(/["']([^"']+)["']/g)) {
          const requirement =
            /^\s*([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?\s*((?:===|==|~=|>=|<=|!=|>|<)[^;]+?)?\s*(;.*)?$/.exec(
              quoted[1] ?? '',
            )
          if (!requirement?.[1] || !requirement[3]) continue
          const at =
            table.start + from + (quoted.index ?? 0) + 1 + (quoted[1] ?? '').indexOf(requirement[3])
          out.push(
            pep508(
              manifest,
              requirement[1],
              requirement[3].trim(),
              table.name === 'project' ? 'dependencies' : 'optional',
              at,
              text,
            ),
          )
        }
      }
    }
    if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(table.name)) {
      out.push(...keyedVersions(manifest, 'pypi', table, text, ['python']))
    }
  }
  return out
}

function cargo(manifest: string, text: string): Dependency[] {
  const out: Dependency[] = []
  for (const table of tables(text)) {
    if (/(^|\.)(dev-|build-)?dependencies$/.test(table.name)) {
      out.push(...keyedVersions(manifest, 'cargo', table, text, []))
      continue
    }
    // `[dependencies.serde]` with `version = "1.0"` inside.
    const one = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(table.name)
    if (one?.[1]) {
      const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(table.body)
      if (version?.[1]) {
        const start = table.start + version.index + version[0].lastIndexOf(version[1])
        out.push({
          manifest,
          ecosystem: 'cargo',
          name: one[1],
          spec: version[1],
          group: table.name.replace(/\.[\w-]+$/, ''),
          start,
          end: start + version[1].length,
          line: lineAt(text, start),
        })
      }
    }
  }
  return out
}

/** `name = "1.2"` and `name = { version = "1.2", … }` lines in a TOML table. */
function keyedVersions(
  manifest: string,
  ecosystem: Ecosystem,
  table: { name: string; body: string; start: number },
  text: string,
  skip: readonly string[],
): Dependency[] {
  const out: Dependency[] = []
  for (const match of table.body.matchAll(
    /^\s*["']?([\w.-]+)["']?\s*=\s*(?:"([^"]+)"|\{[^}\n]*?version\s*=\s*"([^"]+)"[^}\n]*\})/gm,
  )) {
    const name = match[1] ?? ''
    const spec = match[2] ?? match[3] ?? ''
    if (!name || !spec || skip.includes(name)) continue
    const start = table.start + (match.index ?? 0) + match[0].lastIndexOf(`"${spec}"`) + 1
    out.push({
      manifest,
      ecosystem,
      name,
      spec,
      group: table.name,
      start,
      end: start + spec.length,
      line: lineAt(text, start),
    })
  }
  return out
}

function goMod(manifest: string, text: string): Dependency[] {
  const out: Dependency[] = []
  const add = (name: string, version: string, at: number, indirect: boolean) => {
    out.push({
      manifest,
      ecosystem: 'go',
      name,
      spec: version,
      group: indirect ? 'indirect' : 'require',
      start: at,
      end: at + version.length,
      line: lineAt(text, at),
    })
  }
  for (const block of text.matchAll(/^require\s*\(\n([\s\S]*?)^\)/gm)) {
    const from = (block.index ?? 0) + block[0].indexOf('\n') + 1
    let offset = from
    for (const line of (block[1] ?? '').split('\n')) {
      const entry = /^\s*(\S+)\s+(v[\w.+-]+)(\s*\/\/\s*indirect)?/.exec(line)
      if (entry?.[1] && entry[2])
        add(entry[1], entry[2], offset + line.indexOf(entry[2]), Boolean(entry[3]))
      offset += line.length + 1
    }
  }
  for (const single of text.matchAll(/^require\s+(\S+)\s+(v[\w.+-]+)(\s*\/\/\s*indirect)?/gm)) {
    if (single[1] && single[2])
      add(
        single[1],
        single[2],
        (single.index ?? 0) + single[0].indexOf(single[2], single[1].length + 8),
        Boolean(single[3]),
      )
  }
  return out.sort((a, b) => a.start - b.start)
}

/** A TOML file's tables: each `[name]` heading, what follows it, and where that starts. */
function tables(text: string): { name: string; body: string; start: number }[] {
  const out: { name: string; body: string; start: number }[] = []
  const headings = [...text.matchAll(/^\[([^\]\n]+)\]\s*$/gm)]
  headings.forEach((heading, i) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[i + 1]?.index ?? text.length
    out.push({ name: (heading[1] ?? '').trim(), body: text.slice(start, end), start })
  })
  return out
}

function allArrays(body: string): number[] {
  return [...body.matchAll(/=\s*\[/g)].map((match) => (match.index ?? 0) + match[0].length)
}

function closingBrace(text: string, from: number): number {
  let depth = 1
  let quoted = false
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && quoted) {
      i++
      continue
    }
    if (char === '"') quoted = !quoted
    if (quoted) continue
    if (char === '{') depth++
    if (char === '}' && --depth === 0) return i
  }
  return text.length
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
