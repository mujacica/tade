import type { Match, SearchRoot } from './finder.ts'

// Search: one box for everything you might be looking for — an agent, a file
// in any agent's worktree, a line inside one, something to do, a setting.
//
// Pure. What the box holds and what matches it is decided here; listing files
// and grepping them is `finder.ts`, and carrying a choice out is the app's.

export type SearchKind =
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
}

/** How many of each kind to show when not narrowed to it. */
const SHOWN: Record<SearchKind, number> = {
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

// ── Asking, rather than matching ────────────────────────────────────────────
//
// Everything above matches letters. A sentence is not letters to match — "stop
// whoever is on the refunds thing" shares almost none of its characters with
// "Stop refunds", and fuzzy is right to find nothing. So when somebody writes
// a sentence, what is already in the list can be put to somebody who reads
// sentences — *alongside* whatever the letters found, never instead of it.
//
// The division is deliberate: code does the recall — which handful of the
// things Tade can do are worth putting to anybody — and whoever answers does
// the precision. Nothing here invents an entry, and nothing here runs one.
//
// What is put forward is a name, where it is, and what is happening about it
// (`about`), which is the half that makes this answer "what is going on" and
// not only "which of these names". It is also the half that leaves the
// machine, so how much of it does is bounded here and whether any of it does
// at all is a person's (`surfaces.search.context`).

/** Words a sentence carries that say nothing about what is wanted. */
const NOISE = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'that',
  'the',
  'this',
  'to',
  'up',
  'was',
  'what',
  'where',
  'which',
  'with',
  'you',
])

/** Short of this, a sentence is a prefix somebody is still typing. */
export const SENTENCE_MIN = 8

/**
 * The words of a sentence that say anything about what is wanted.
 *
 * One reading, read twice: by what picks the shortlist out, and by what
 * decides whether the letters already answered. Two readings of "which words
 * does this sentence carry" is how the two halves come to disagree about the
 * same sentence.
 */
export function wordsIn(raw: string): string[] {
  return parseQuery(raw)
    .text.toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length >= 3 && !NOISE.has(word))
}

/** Whether what is in the box is a sentence rather than the start of a name. */
export function isSentence(raw: string): boolean {
  const { scope, text } = parseQuery(raw)
  if (scope === 'text') return false
  return text.length >= SENTENCE_MIN && text.trim().split(/\s+/).length >= 2
}

/**
 * Whether asking anybody is worth it: a sentence, and nothing came back that is
 * plainly the whole of it.
 *
 * It used to be "and the letters matched nothing at all", which is too tight in
 * exactly the way that matters. A sentence is long and a name is short, so what
 * a sentence matches is never the name and is always letters scattered down
 * some long label — the letters of `what the run` are all in
 * `Telemetry › What the brief counts`, in order, and mean nothing by it. One
 * such match was enough to silence the question for good: over three-word
 * sentences made of the words somebody would actually type, 418 of them came
 * back with one weak match apiece and were never asked about.
 *
 * So what counts as an answer is every word of the sentence that carries
 * meaning, said outright in one row's own name (`answered`). Anything short of
 * that, the question is still worth putting.
 *
 * Asking alongside is safe because what comes back only ever *adds* rows: the
 * letters keep everything they found and the order they found it in. Lines
 * inside files never counted and still do not — a sentence that appears in
 * somebody's code is not an answer to what they asked for.
 */
export function worthAsking(raw: string, found: readonly SearchEntry[]): boolean {
  if (!isSentence(raw)) return false
  const words = wordsIn(raw)
  return !found.some(
    (entry) => entry.kind !== 'file' && entry.kind !== 'match' && answered(words, entry),
  )
}

/**
 * Whether one row is plainly the whole of what was typed: every word of it
 * that carries any meaning, said outright in that row's own name.
 *
 * Two words at least, and that is the whole of the difference between this and
 * what it replaced. One word of a sentence found is a word found — "what is
 * the coverage" leaves `coverage`, and an agent called `coverage` answering it
 * is exactly the guess that made this feature necessary. Every word of it in
 * one name is somebody typing the name of a thing, which is already the first
 * row of the list.
 */
function answered(words: readonly string[], entry: SearchEntry): boolean {
  if (words.length < 2) return false
  const name = `${entry.label} ${entry.detail ?? ''}`.toLowerCase()
  return words.every((word) => name.includes(word))
}

/** How far above a name spelling a word, what is happening saying it outright counts. */
const SAID = 1_000

/**
 * How well one word of a sentence picks an entry out: what its name spells,
 * and a long way above that, what is happening about it saying that word in so
 * many letters.
 *
 * This is the recall half, and it is where the whole of "search knows what is
 * happening" lives: `coverage` is in the name of nothing and in what one agent
 * is doing, so without this the shortlist is a list of names and whoever reads
 * it is being asked to guess.
 */
function picks(word: string, entry: SearchEntry): number | null {
  const named = fuzzy(word, `${entry.label} ${entry.detail ?? ''}`)
  if ((entry.about ?? '').toLowerCase().includes(word)) return (named?.score ?? 0) + SAID
  return named?.score ?? null
}

/**
 * The few things worth putting to somebody, for a sentence the letters could
 * not place: whatever each word of it finds, and then the things Tade can do,
 * in the order it already keeps them — which is what needs you, then what you
 * can do here, then everything else.
 */
export function shortlist(
  raw: string,
  entries: readonly SearchEntry[],
  most: number,
): SearchEntry[] {
  const words = wordsIn(raw)
  const picked = new Map<string, SearchEntry>()
  for (const word of words) {
    const ranked = entries
      .map((entry) => ({ entry, score: picks(word, entry) }))
      .filter((one) => one.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
    for (const { entry } of ranked) if (!picked.has(entry.id)) picked.set(entry.id, entry)
  }
  // Topped up in the order the window keeps them, so a sentence whose words
  // match nothing at all is still answered with the things there are to do
  // rather than with nothing.
  for (const entry of entries) {
    if (picked.size >= most) break
    if (entry.kind === 'file' || entry.kind === 'match') continue
    if (!picked.has(entry.id)) picked.set(entry.id, entry)
  }
  return [...picked.values()].slice(0, most)
}

/**
 * How much of what is happening goes with one choice.
 *
 * A bound, because a shortlist is two dozen choices and every one of them
 * carries a paragraph: what one ask costs is this times that, and a number
 * nobody wrote down is a number that grows. Enough for what a thing is and
 * what is being done to it; the rest is on screen, where somebody is already
 * looking.
 */
export const ABOUT_ASKED = 300

/** What is happening about something, as much of it as one ask carries. */
export function askedAbout(about: string | undefined): string | undefined {
  if (!about) return undefined
  const said = about.replace(/\s+/g, ' ').trim()
  if (said === '') return undefined
  return said.length <= ABOUT_ASKED ? said : `${said.slice(0, ABOUT_ASKED)}…`
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
