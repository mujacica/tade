import type { Match, SearchRoot } from './finder.ts'

// Search: one box for everything you might be looking for — an agent, a file
// in any agent's worktree, a line inside one, something to do, a setting.
//
// Pure. What the box holds and what matches it is decided here; listing files
// and grepping them is `finder.ts`, and carrying a choice out is the app's.

export type SearchKind =
  | 'path'
  | 'approval'
  | 'meant'
  | 'agent'
  | 'file'
  | 'match'
  | 'terminal'
  | 'action'
  | 'project'
  | 'setting'

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
  /**
   * What is happening about it, in words: what an agent is doing, what it was
   * asked for, what queued work waits on and why, the notes about it. Derived
   * wherever this entry is made, from what the window already has — never a
   * store of its own, which would be wrong the moment an agent did anything.
   *
   * Never drawn as itself: it is a paragraph and a result is a row. What it is
   * for is the two things a name cannot do — being put to whoever reads a
   * sentence, and being found by letters that are nowhere in the name. The
   * letters only ever match it as a whole run, because a paragraph spells
   * almost anything if they are let wander; the line that matched is what the
   * row then shows, so it says why it is there.
   */
  about?: string
}

/** The groups results are shown in, in this order, and what each is called. */
export const GROUPS: readonly { kind: SearchKind; title: string }[] = [
  { kind: 'path', title: 'THIS PATH' },
  { kind: 'approval', title: 'WAITING ON YOU' },
  { kind: 'meant', title: 'MIGHT MEAN' },
  { kind: 'agent', title: 'AGENTS' },
  { kind: 'file', title: 'FILES' },
  { kind: 'match', title: 'IN FILES' },
  { kind: 'terminal', title: 'IN TERMINALS' },
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
  /** What each terminal has printed, as plain text, for finding lines in. */
  terminals?: readonly { id: string; name: string; project: string; text: string }[]
  /**
   * What somebody made of the sentence in the box, where the letters in it
   * matched nothing. Already chosen for this query, so they are shown as they
   * came rather than matched again — and they are the same entries as
   * everything else here, so choosing one does what choosing it always did.
   */
  meant?: readonly SearchEntry[]
  /**
   * Your home directory, so `~/notes.md` in the box means the file you meant.
   * Taken rather than read, because this file is a function of what it is
   * handed; `expandHome('~')` is where the window gets it.
   */
  home?: string | null
  /**
   * What a look at the path in the box found, and which path it was about.
   * Absent until the look has answered — and a look about a path that is no
   * longer typed is not an answer about this one.
   */
  look?: { path: string; is: PathLook } | null
}

// ── A path somebody named outright ──────────────────────────────────────────
//
// Everything else here is a ranking of what Tade already has, which is every
// project and every worktree and nothing else. A path pasted in is the other
// thing: an agent wrote a document under Tade's own home and said where it
// put it, and the answer to "open that" may not be "Tade does not index that
// folder, so no".
//
// It is one row and nothing more. Naming a file is not asking for the folder
// it is in to be listed, so nothing is indexed, nothing is read until the row
// is chosen, and nothing about it is put to anybody who reads a sentence
// (`isSentence`, `meant.ts`) — a path is not a sentence however many spaces
// somebody's folders have in their names.

/** What a look at a typed path found, or why it could not say. */
export type PathLook = 'file' | 'folder' | 'missing' | 'unreadable' | 'unknown'

/** A path somebody named outright, as they typed it and as it resolves. */
export interface TypedPath {
  /** As typed, with a shell's quotes and escapes taken off: what the row says. */
  typed: string
  /** Absolute, with `~` expanded: what is looked at and what is opened. */
  path: string
  line: number | null
  column: number | null
}

/**
 * A path as somebody pasted it: the quotes a shell would have put round one
 * with a space in it taken off, and the backslash it would have escaped the
 * space with.
 *
 * Only a space is unescaped. A backslash anywhere else in a path is part of
 * the name, and a path with one in it comes through quoted.
 */
function unquoted(text: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(text)
  if (quoted?.[2] !== undefined) return quoted[2]
  return text.replace(/\\ /g, ' ')
}

/** Whether it starts the way only a path does: at the root, or at your home. */
function rooted(text: string): boolean {
  return text.startsWith('/') || text === '~' || text.startsWith('~/')
}

/**
 * Whether what is in the box is somebody naming a file outright rather than
 * describing one.
 *
 * Only in the unnarrowed box: `#/api/v1` is text to look for inside files and
 * has been since before any of this, so the scope decides first.
 */
export function looksLikePath(raw: string): boolean {
  const query = parseQuery(raw)
  return query.scope === 'all' && rooted(unquoted(query.text))
}

/**
 * The path in the box, if there is one — absolute, and at the line asked for.
 *
 * `~` needs the home to resolve, so a `~/…` path with none given is not a path
 * anybody here can place and is left alone rather than resolved against
 * nothing: `/x` and `~/x` are different files and only one of them is a guess.
 */
export function pathTyped(raw: string, home: string | null): TypedPath | null {
  const query = parseQuery(raw)
  if (query.scope !== 'all') return null
  const typed = unquoted(query.text)
  if (!rooted(typed)) return null
  if (typed.startsWith('~')) {
    if (!home) return null
    // Stripped of its trailing slash so the join cannot double one — which
    // leaves nothing at all where home *is* the root, and then `~` is `/`.
    const root = home.replace(/\/+$/, '')
    return {
      typed,
      path: typed === '~' ? root || '/' : `${root}/${typed.slice(2)}`,
      ...place(query),
    }
  }
  return { typed, path: typed, ...place(query) }
}

function place(query: Query): { line: number | null; column: number | null } {
  return { line: query.line, column: query.column }
}

/** The last part of a path: what the row is called. */
function nameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  const name = at < 0 ? trimmed : trimmed.slice(at + 1)
  return name === '' ? path : name
}

/** Everything above it, as it was typed: where the row says it is. */
function folderOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return ''
  return at === 0 ? '/' : trimmed.slice(0, at)
}

/**
 * How much of that folder the row says.
 *
 * Bounded, and that is the whole of why: a row that does not fit drops its
 * right-hand group *whole* (`Row.build`), and the right-hand group is where
 * this row says whether the file is there at all. Drawn in full, a folder
 * sixty characters deep — which is what every path under Tade's home is —
 * left a row naming a file and saying nothing about it, on an eighty-column
 * terminal, in exactly the case this feature exists for.
 *
 * The folder is also the one thing on this row nobody needs telling: they
 * pasted it, and the end of it is still in the box above. So it is the half
 * that gives way, from its left, by whole segments, saying that it did.
 *
 * One number rather than the room there is, because this is the entry and the
 * entry is a value: a row that says less than a wide window could have shown
 * is a cosmetic loss, and a row whose answer fell off the edge is the bug.
 */
const FOLDER_CELLS = 36

function shortFolder(folder: string): string {
  if (folder.length <= FOLDER_CELLS) return folder
  const parts = folder.split('/').filter((part) => part !== '')
  let shown = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = shown === '' ? (parts[i] ?? '') : `${parts[i]}/${shown}`
    if (next.length + 2 > FOLDER_CELLS) break
    shown = next
  }
  // One segment longer than the whole budget: cut that from its left too,
  // which is where a path's least telling half is.
  return shown === '' ? `…${folder.slice(1 - FOLDER_CELLS)}` : `…/${shown}`
}

/**
 * What the row says about what the look found.
 *
 * A file that is there and readable says nothing: the row being there is the
 * whole of it, and a note under every ordinary path is a word read a hundred
 * times. The other four are each their own answer — `unknown` included, which
 * is a look that could not say and never a look that found nothing.
 */
const SAYS: Record<PathLook, string | null> = {
  file: null,
  folder: 'folder',
  missing: 'not there',
  unreadable: 'cannot read',
  unknown: 'cannot tell',
}

const TONES: Record<PathLook, SearchEntry['tone']> = {
  file: 'busy',
  folder: 'hint',
  missing: 'bad',
  unreadable: 'bad',
  unknown: 'hint',
}

/**
 * The one row a typed path makes: its name, the folder it is in as they typed
 * it, and what a look at it found.
 *
 * Drawn before the look has answered (`look` null), because search is what
 * answers instantly and a row that waits for a stat is a row that flickers.
 * What it opens is the same `open` the FILES rows carry, so choosing it is the
 * same act as choosing a file in a project: the viewer, at the line, with its
 * own words for a file that is a folder, gone, unreadable or binary.
 *
 * It carries no `about`, and that is not an omission: nothing about a path
 * somebody pasted leaves this machine.
 */
export function pathEntry(found: TypedPath, look: PathLook | null): SearchEntry {
  const said = look ? SAYS[look] : null
  const where = shortFolder(folderOf(found.typed))
  const note = [found.line ? `line ${found.line}` : null, said].filter(Boolean).join(' · ')
  return {
    id: openId(found.path, found.line, found.column),
    kind: 'path',
    label: nameOf(found.typed),
    ...(where ? { detail: where } : {}),
    ...(note ? { note } : {}),
    mark: look === 'folder' ? '▸' : '□',
    tone: look ? TONES[look] : 'busy',
    // Tab tidies what was pasted into the path it resolves to.
    complete: found.path,
    hits: [],
  }
}

/** How many of each kind to show when not narrowed to it. */
const SHOWN: Record<SearchKind, number> = {
  // One path was typed, so there is one row: a count here would be a cap on
  // an answer that cannot have a second.
  path: 1,
  approval: 5,
  meant: 4,
  agent: 6,
  file: 12,
  match: 12,
  terminal: 8,
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
        return kind === 'match' || kind === 'terminal'
      case 'actions':
        return kind === 'action' || kind === 'setting' || kind === 'project' || kind === 'meant'
      default:
        return query.text !== '' || kind !== 'file'
    }
  }
  const limit = (kind: SearchKind) => (query.scope === 'all' ? SHOWN[kind] : NARROWED)

  const out: SearchEntry[] = []
  for (const group of GROUPS) {
    if (!wanted(group.kind)) continue
    if (group.kind === 'path') {
      // Never fuzzy-matched either: they typed the path, so there is nothing
      // to rank and nothing to light.
      const found = pathTyped(raw, sources.home ?? null)
      if (found) {
        const look = sources.look?.path === found.path ? sources.look.is : null
        out.push(pathEntry(found, look))
      }
      continue
    }
    if (group.kind === 'meant') {
      // Never fuzzy-matched: the letters not matching is why anybody was asked.
      out.push(
        ...(sources.meant ?? [])
          .slice(0, limit('meant'))
          .map((entry) => ({ ...entry, kind: 'meant' as const, hits: [] })),
      )
      continue
    }
    if (group.kind === 'file') {
      out.push(...fileResults(query, sources.files, limit('file')))
      continue
    }
    if (group.kind === 'terminal') {
      if (query.text.length >= TEXT_MIN) {
        out.push(...terminalResults(query.text, sources.terminals ?? [], limit('terminal')))
      }
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
      .map((entry, order) => ({ entry, order, found: answers(query.text, entry) }))
      .filter((one) => one.found !== null)
      .sort((a, b) =>
        query.text === ''
          ? a.order - b.order
          : (b.found?.score ?? 0) - (a.found?.score ?? 0) || a.order - b.order,
      )
      .slice(0, limit(group.kind))
      .map(({ entry, found }) => ({
        ...entry,
        hits: found?.hits ?? [],
        // The line of what is happening that said it, so a row whose name
        // spells none of the query still says why it is in the list.
        ...(found?.preview ? { preview: found.preview } : {}),
      }))
    out.push(...ranked)
  }
  // One row per thing: where the letters found what was also put forward as
  // what they might have meant, it is the same act either way, and the list
  // says it once.
  if (!sources.meant?.length) return out
  const seen = new Set<string>()
  return out.filter((entry) => !seen.has(entry.id) && seen.add(entry.id) !== undefined)
}

/**
 * How far below any name match what is happening ranks.
 *
 * Below every score `fuzzy` can return, which is what makes this a tie-break
 * and never a reordering: a name is what somebody typed at, and being told
 * about a thing whose name says nothing is the extra, never the answer.
 */
const ABOUT_SCORE = -10_000

/**
 * How well one entry answers what was typed: its name, and failing that, what
 * is happening about it.
 *
 * The two are matched differently on purpose. A name is short, so letters in
 * order are evidence. `about` is a paragraph, and letters in order through a
 * paragraph are evidence of nothing — so it has to say what was typed in so
 * many letters, and what comes back is the line that said it.
 */
function answers(
  text: string,
  entry: SearchEntry,
): { score: number; hits: number[]; preview?: string } | null {
  const named = fuzzy(text, entry.label)
  if (named) return named
  const said = saidIn(text, entry.about)
  return said === null ? null : { score: ABOUT_SCORE, hits: [], preview: said }
}

/**
 * The line of what is happening that says what was typed, whole and in one
 * run. Null when nothing there says it — and never for a letter or two, which
 * every paragraph holds somewhere.
 */
function saidIn(text: string, about: string | undefined): string | null {
  const want = text.trim().toLowerCase()
  if (!about || want.length < TEXT_MIN) return null
  for (const line of about.split('\n')) {
    if (line.toLowerCase().includes(want)) return line.trim()
  }
  return null
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

/** Lines a terminal printed that contain the text, newest first: the latest run is the one you want. */
function terminalResults(
  text: string,
  terminals: NonNullable<SearchSources['terminals']>,
  limit: number,
): SearchEntry[] {
  const want = text.toLowerCase()
  const out: SearchEntry[] = []
  for (const terminal of terminals) {
    const lines = terminal.text.split('\n')
    // Which match, counting back from the newest, is what the find panel opens on.
    let back = 0
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i] ?? ''
      if (!line.toLowerCase().includes(want)) continue
      out.push({
        id: ['terminal', terminal.id, text, String(back)].join('\0'),
        kind: 'terminal',
        label: terminal.name,
        detail: terminal.project,
        mark: '›',
        preview: line.trim(),
        complete: `#${text}`,
      })
      back++
    }
  }
  return out.slice(0, limit)
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
