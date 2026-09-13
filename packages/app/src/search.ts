import type { Match, SearchRoot } from './finder.ts'

// Search: one box for everything you might be looking for — an agent, a file
// in any agent's worktree, a line inside one, something to do, a setting.
//
// Pure. What the box holds and what matches it is decided here; listing files
// and grepping them is `finder.ts`, and carrying a choice out is the app's.

export type SearchKind = 'approval' | 'agent' | 'file' | 'match' | 'action' | 'project' | 'setting'

/** One thing search can go to. */
export interface SearchEntry {
  /** What choosing it does, for the app to carry out. */
  id: string
  kind: SearchKind
  label: string
  /** Said quietly after the label: where it is, what it is. */
  detail?: string
  /** Said at the right edge: `waiting on you`, `line 42`. */
  note?: string
  /** A mark before it, so a column of results is readable by shape. */
  mark: string
  tone?: 'waiting' | 'busy' | 'done' | 'bad' | 'hint'
  /** The line of a file a match was found on, shown under its name. */
  preview?: string
  /** What tab fills the box with. */
  complete?: string
  /** Which characters of the label matched, to show why it is here. */
  hits?: number[]
}

/** The groups results are shown in, in this order, and what each is called. */
export const GROUPS: readonly { kind: SearchKind; title: string }[] = [
  { kind: 'approval', title: 'WAITING ON YOU' },
  { kind: 'agent', title: 'AGENTS' },
  { kind: 'file', title: 'FILES' },
  { kind: 'match', title: 'IN FILES' },
  { kind: 'action', title: 'ACTIONS' },
  { kind: 'project', title: 'PROJECTS' },
  { kind: 'setting', title: 'SETTINGS' },
]

/** What a leading character narrows search to, shown as chips under the box. */
export const SCOPES: readonly { prefix: string; label: string; scope: Scope }[] = [
  { prefix: '@', label: 'agents', scope: 'agents' },
  { prefix: '#', label: 'in files', scope: 'text' },
  { prefix: '>', label: 'actions', scope: 'actions' },
]

export type Scope = 'all' | 'agents' | 'text' | 'actions'

export interface Query {
  scope: Scope
  /** What to look for, without the scope or the line. */
  text: string
  /** `file.ts:42`, or `file.ts:42:7`. */
  line: number | null
  column: number | null
}

/** Shorter than this, looking inside every file finds everything, which is nothing. */
export const TEXT_MIN = 3

export function parseQuery(raw: string): Query {
  let text = raw.trimStart()
  const scope = SCOPES.find((one) => text.startsWith(one.prefix))?.scope ?? 'all'
  if (scope !== 'all') text = text.slice(1).trimStart()
  let line: number | null = null
  let column: number | null = null
  const at = /^(.*?):(\d+)(?::(\d+))?$/.exec(text)
  if (at && scope !== 'text' && at[1] !== '') {
    text = at[1] ?? ''
    line = Number(at[2])
    column = at[3] ? Number(at[3]) : null
  }
  return { scope, text: text.trim(), line, column }
}

/**
 * How well a query matches some text, and where: every character of the query
 * in order, scored so that a run of them, a match at the start of a word, and a
 * match in a file's own name all count for more than letters scattered along a
 * path. Null when it does not match at all.
 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (q === '') return { score: 0, hits: [] }
  const t = text.toLowerCase()
  const name = t.lastIndexOf('/') + 1

  const whole = t.lastIndexOf(q)
  if (whole >= 0) {
    const hits = Array.from({ length: q.length }, (_, i) => whole + i)
    const score =
      1_000 +
      (boundary(text, whole) ? 200 : 0) +
      (whole >= name ? 300 : 0) +
      (whole === name ? 200 : 0) -
      text.length
    return { score, hits }
  }

  const hits: number[] = []
  let from = 0
  let score = 0
  for (const char of q) {
    const found = t.indexOf(char, from)
    if (found < 0) return null
    if (hits.length > 0 && found === (hits.at(-1) ?? -2) + 1) score += 15
    if (boundary(text, found)) score += 10
    if (found >= name) score += 5
    hits.push(found)
    from = found + 1
  }
  // Letters close together beat the same letters spread along a long path.
  const spread = (hits.at(-1) ?? 0) - (hits[0] ?? 0)
  return { score: score - spread - text.length / 10, hits }
}

/** The start of a word: after a separator, or a capital after a small letter. */
function boundary(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text[at - 1] ?? ''
  const here = text[at] ?? ''
  if ('/-_. '.includes(before)) return true
  return /[a-z]/.test(before) && /[A-Z]/.test(here)
}

export interface SearchSources {
  /** Agents, approvals, actions, projects, settings: everything known without looking at disk. */
  entries: readonly SearchEntry[]
  /** Every file in every place searched. */
  files: readonly { root: SearchRoot; path: string }[]
  /** Lines found inside files for the text being searched, once git has answered. */
  matches: readonly Match[]
}

/** How many of each kind to show when not narrowed to it. */
const SHOWN: Record<SearchKind, number> = {
  approval: 5,
  agent: 6,
  file: 12,
  match: 12,
  action: 5,
  project: 4,
  setting: 5,
}

/** Narrowed to one kind, a longer list is the point. */
const NARROWED = 200

/**
 * What search shows for a query, best first within each group and the groups
 * in `GROUPS` order. With nothing typed, what needs you and what you can do.
 */
export function searchResults(raw: string, sources: SearchSources): SearchEntry[] {
  const query = parseQuery(raw)
  const wanted = (kind: SearchKind): boolean => {
    switch (query.scope) {
      case 'agents':
        return kind === 'agent' || kind === 'approval'
      case 'text':
        return kind === 'match'
      case 'actions':
        return kind === 'action' || kind === 'setting' || kind === 'project'
      default:
        return query.text !== '' || kind !== 'file'
    }
  }
  const limit = (kind: SearchKind) => (query.scope === 'all' ? SHOWN[kind] : NARROWED)

  const out: SearchEntry[] = []
  for (const group of GROUPS) {
    if (!wanted(group.kind)) continue
    if (group.kind === 'file') {
      out.push(...fileResults(query, sources.files, limit('file')))
      continue
    }
    if (group.kind === 'match') {
      if (query.text.length >= TEXT_MIN) {
        out.push(...matchResults(query.text, sources.matches, limit('match')))
      }
      continue
    }
    const ranked = sources.entries
      .filter((entry) => entry.kind === group.kind)
      .map((entry, order) => ({ entry, order, found: fuzzy(query.text, entry.label) }))
      .filter((one) => one.found !== null)
      .sort((a, b) =>
        query.text === ''
          ? a.order - b.order
          : (b.found?.score ?? 0) - (a.found?.score ?? 0) || a.order - b.order,
      )
      .slice(0, limit(group.kind))
      .map(({ entry, found }) => ({ ...entry, hits: found?.hits ?? [] }))
    out.push(...ranked)
  }
  return out
}

function fileResults(query: Query, files: SearchSources['files'], limit: number): SearchEntry[] {
  if (query.text === '') return []
  const ranked: { entry: SearchEntry; score: number }[] = []
  for (const file of files) {
    const found = fuzzy(query.text, file.path)
    if (!found) continue
    const place = `${file.root.path}/${file.path}`
    ranked.push({
      score: found.score,
      entry: {
        id: openId(place, query.line, query.column),
        kind: 'file',
        label: file.path,
        detail: file.root.label,
        mark: '□',
        ...(query.line ? { note: `line ${query.line}` } : {}),
        complete: file.path,
        hits: found.hits,
      },
    })
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit)
    .map((one) => one.entry)
}

function matchResults(text: string, matches: readonly Match[], limit: number): SearchEntry[] {
  return matches.slice(0, limit).map((match) => ({
    id: openId(`${match.root.path}/${match.path}`, match.line, null),
    kind: 'match' as const,
    label: `${match.path}:${match.line}`,
    detail: match.root.label,
    mark: '≡',
    preview: match.text.trim(),
    complete: `#${text}`,
  }))
}

/** What opening a file at a place is called, for the app to take apart again. */
export function openId(path: string, line: number | null, column: number | null): string {
  return ['open', path, line ?? '', column ?? ''].join('\0')
}

export function parseOpenId(
  id: string,
): { path: string; line: number | null; column: number | null } | null {
  const [verb, path, line, column] = id.split('\0')
  if (verb !== 'open' || !path) return null
  return {
    path,
    line: line ? Number(line) : null,
    column: column ? Number(column) : null,
  }
}

/**
 * What tab fills the box with: the chosen result, keeping the scope you typed
 * and the line you asked for, so `app:42` and tab gives `src/app.ts:42`.
 */
export function completed(raw: string, entry: SearchEntry | undefined): string {
  if (!entry?.complete) return raw
  const query = parseQuery(raw)
  // A completion that names its own scope (`@refunds`, `#text`) is whole already.
  if (SCOPES.some((one) => entry.complete?.startsWith(one.prefix))) return entry.complete
  const scope = SCOPES.find((one) => one.scope === query.scope)?.prefix ?? ''
  const line = query.line ? `:${query.line}${query.column ? `:${query.column}` : ''}` : ''
  return `${scope}${entry.complete}${line}`
}
